import type { AuditStore } from "../audit";
import { recordAuditEvent } from "../audit";
import type { WorkQueue } from "../work/queue";
import type { RunAssertion } from "./callback-token";
import { isBotPaused } from "./lifecycle";
import type { AgentProfileStore } from "./profile-store";
import type { AgentActor, AgentProfile } from "./profile-types";

export const HANDOFF_KIND = "bot.message";
export const HANDOFF_GRANT = "bot";

export type HandoffEnvelope = { task: string; constraints?: string; expecting?: string };
export type HandoffCaps = { maxDepth: number; maxPerRun: number };
export type AddressableBot = Pick<AgentProfile, "id" | "name" | "title" | "roleDescription">;
export type CoordinationSource = { channelId: string; botId: string; group?: boolean };
export type HandoffOutcome =
  | { ok: true; to: string; toName: string }
  | { ok: false; refusal: string }
  | { handled: string };

export type HandoffDesk = {
  send(input: {
    from: RunAssertion;
    target: string;
    envelope: HandoffEnvelope;
    toolCallId: string;
    signal?: AbortSignal;
    beforeSend?: (target: AgentProfile) => Promise<string | undefined>;
  }): Promise<HandoffOutcome>;
};

/** Resolve a formal Bot ID once, then enqueue the actual tool call's work. */
export function createHandoffDesk(options: {
  queue: WorkQueue;
  profiles: AgentProfileStore;
  mayAddress(fromBotId: string, toBotId: string): Promise<boolean>;
  actorFor(userId: string): Promise<AgentActor | null>;
  auditStore: AuditStore;
  caps: HandoffCaps;
}): HandoffDesk {
  const { queue, profiles, mayAddress, actorFor, auditStore, caps } = options;
  async function refuse(from: RunAssertion, target: string, reason: string, refusal: string): Promise<HandoffOutcome> {
    await recordAuditEvent(auditStore, {
      eventType: "agent.handoff_refused", targetType: "agent", targetId: from.botId,
      actorUserId: from.actorId, ...(from.initiator ? { initiator: from.initiator } : {}),
      payload: { bot: from.botId, from: from.botId, target, run: from.runId, depth: from.depth ?? 0, reason },
    });
    return { ok: false, refusal };
  }
  return {
    async send({ from, target, envelope, toolCallId, signal, beforeSend }) {
      signal?.throwIfAborted();
      const task = envelope.task.trim();
      if (!task) return refuse(from, target, "no_task", "Nothing was sent: say what the other Bot should do.");
      if (!from.threadId) return refuse(from, target, "no_thread", "There is no source conversation for the answer.");
      if ((from.depth ?? 0) >= caps.maxDepth || caps.maxPerRun <= 0)
        return refuse(from, target, "depth_cap", "This run cannot delegate further work.");
      const actor = await actorFor(from.actorId);
      const found = actor ? await profiles.get(actor, target) : null;
      if (!found || found.hidden || found.deletedAt !== null)
        return refuse(from, target, "no_such_bot", "That Bot ID is not available to this person.");
      if (found.id === from.botId)
        return refuse(from, target, "self", "This is your own Bot ID. Do the work yourself.");
      if (!(await mayAddress(from.botId, found.id)))
        return refuse(from, target, "not_granted", `You have not been granted ${found.name} to ask for help.`);
      if (await isBotPaused(from.actorId, found.id))
        return refuse(from, target, "paused", `${found.name} is paused, so nothing was sent.`);
      const handled = await beforeSend?.(found);
      if (handled !== undefined) return { handled };
      signal?.throwIfAborted();
      const prefix = `${from.runId.length}:${from.runId}:`;
      const key = `${prefix}${toolCallId}`;
      const offered = await queue.offer({
        kind: HANDOFF_KIND, key,
        atMost: { keyPrefix: prefix, max: caps.maxPerRun },
        payload: {
          fromBotId: from.botId, toBotId: found.id, toName: found.name,
          actorId: from.actorId, threadId: from.threadId, runId: from.runId,
          depth: (from.depth ?? 0) + 1, task,
          ...(from.initiator ? { initiator: from.initiator } : {}),
          ...(envelope.constraints ? { constraints: envelope.constraints } : {}),
          ...(envelope.expecting ? { expecting: envelope.expecting } : {}),
        },
      });
      if (offered === "refused")
        return refuse(from, target, "fanout_cap", "This run has reached its delegation limit.");
      if (offered === "already")
        return { handled: "That tool call already has work queued or completed. No second task was created." };
      await recordAuditEvent(auditStore, {
        eventType: "agent.handoff_offered", targetType: "agent", targetId: found.id,
        actorUserId: from.actorId, ...(from.initiator ? { initiator: from.initiator } : {}),
        payload: { bot: from.botId, from: from.botId, to: found.id, run: from.runId, depth: (from.depth ?? 0) + 1, task },
      });
      return { ok: true, to: found.id, toName: found.name };
    },
  };
}
