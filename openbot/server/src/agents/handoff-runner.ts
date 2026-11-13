import type { ThreadMessage, ThreadRun } from "@openbot/shared/thread-events";
import { type AuditInitiator, type AuditStore, recordAuditEvent } from "../audit";
import { RunStoppedError } from "../runtime/thread-store";
import { DEFAULT_MAX_ATTEMPTS, type WorkQueue } from "../work/queue";
import { HANDOFF_KIND } from "./handoff";
import { HandoffRunFailedError } from "./handoff-delivery";

export type HandoffWork = {
  fromBotId: string; toBotId: string; actorId: string; threadId: string; runId: string; depth: number;
  initiator?: AuditInitiator;
  task: string; constraints?: string; expecting?: string; fromName?: string; toName?: string;
};
export type HandoffDelivery = {
  deliver(input: { key: string; work: HandoffWork; assertion: string; signal: AbortSignal }): Promise<
    { state: "completed"; answer: string | null } | { state: "waiting" }
  >;
};
export type HandoffRunReport = { delivered: string[]; skipped: { key: string; reason: string }[] };

export function createHandoffRunner(options: {
  queue: WorkQueue;
  delivery: HandoffDelivery;
  owner: string;
  sign(work: HandoffWork, key: string): string;
  complete(input: { key: string; owner: string; actorId: string; threadId: string; runId: string; message?: ThreadMessage; error?: string }): Promise<boolean>;
  runState(key: string): Promise<(ThreadRun & { stopRequested: boolean }) | undefined>;
  auditStore: AuditStore;
  leaseMs?: number; limit?: number; maxAttempts?: number; renewEveryMs?: number;
}) {
  const { queue, delivery, owner, sign, complete, runState, auditStore,
    leaseMs = 60_000, limit = 5, maxAttempts = DEFAULT_MAX_ATTEMPTS, renewEveryMs = 20_000 } = options;
  async function audit(work: HandoffWork, eventType: "agent.handoff_delivered" | "agent.handoff_failed" | "agent.handoff_cancelled", extra: Record<string, unknown>) {
    await recordAuditEvent(auditStore, {
      eventType, targetType: "agent", targetId: work.toBotId, actorUserId: work.actorId,
      ...(work.initiator ? { initiator: work.initiator } : {}),
      payload: { bot: work.fromBotId, from: work.fromBotId, to: work.toBotId, run: work.runId, ...extra },
    }).catch(error => console.warn("Could not record the delegation outcome.", error));
  }
  async function finish(key: string, work: HandoffWork, text?: string, error?: string) {
    const message: ThreadMessage | undefined = text ? { id: key, role: "assistant", senderBotId: work.toBotId, content: text } : undefined;
    return complete({ key, owner, actorId: work.actorId, threadId: work.threadId, runId: work.runId, message, error });
  }
  return {
    async sweep(): Promise<HandoffRunReport> {
      const claimed = await queue.claim({ kind: HANDOFF_KIND, owner, leaseMs, limit, maxAttempts });
      const controls = new Map(claimed.map(item => [item.key, new AbortController()]));
      const heartbeat = setInterval(() => {
        for (const [key, controller] of controls) {
          void queue.renew({ kind: HANDOFF_KIND, key, owner, leaseMs })
            .then(kept => { if (!kept) controller.abort(new RunStoppedError("The delegated work was cancelled or claimed elsewhere.")); })
            .catch(error => console.warn("Could not renew a delegation's queue claim.", error));
        }
      }, renewEveryMs);
      const report: HandoffRunReport = { delivered: [], skipped: [] };
      try {
        for (const item of claimed) {
          const work = item.payload as unknown as HandoffWork;
          const controller = controls.get(item.key)!;
          try {
            controller.signal.throwIfAborted();
            const sourceRun = await runState(work.runId);
            if (sourceRun?.stopRequested || sourceRun?.status === "stopped") throw new RunStoppedError("The source work was cancelled.");
            const result = await delivery.deliver({
              key: item.key, work, assertion: sign(work, item.key), signal: controller.signal,
            });
            if (result.state === "waiting") {
              await queue.release({ kind: HANDOFF_KIND, key: item.key, owner, delayMs: 60_000, unstarted: true });
              continue;
            }
            const kept = await finish(item.key, work, result.answer ?? `${work.toName ?? work.toBotId} completed without a written reply.`);
            if (kept) {
              report.delivered.push(work.toBotId);
              await audit(work, "agent.handoff_delivered", { depth: work.depth });
            }
          } catch (error) {
            const reason = error instanceof Error ? error.message : "The delegated work could not finish.";
            const execution = await runState(item.key);
            const source = await runState(work.runId);
            if (error instanceof RunStoppedError || (error instanceof Error && error.name === "BotPausedError") || controller.signal.aborted || source?.stopRequested || source?.status === "stopped") {
              if (await finish(item.key, work, undefined, "Stopped by the person"))
                await audit(work, "agent.handoff_cancelled", { reason });
            } else if (!(error instanceof HandoffRunFailedError) && (execution?.status === "running" || execution?.status === "waiting")) {
              await queue.release({ kind: HANDOFF_KIND, key: item.key, owner, delayMs: 60_000, unstarted: true, reason });
            } else if (!execution && item.attempts < maxAttempts && !(error instanceof Error && error.name === "CapabilityRefusedError")) {
              await queue.release({ kind: HANDOFF_KIND, key: item.key, owner, delayMs: 60_000, reason });
            } else {
              if (await finish(item.key, work, `${work.toName ?? work.toBotId} did not complete the delegated work: ${reason}`, reason))
                await audit(work, "agent.handoff_failed", { reason });
            }
            report.skipped.push({ key: item.key, reason });
          } finally {
            controls.delete(item.key);
          }
        }
      } finally {
        clearInterval(heartbeat);
      }
      return report;
    },
  };
}
