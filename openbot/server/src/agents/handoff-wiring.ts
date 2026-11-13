import { workOwner } from "@openbot/shared/work-owner";
import { eq } from "drizzle-orm";
import { type AuditStore, handoffInitiator } from "../audit";
import type { GroupConversations } from "../channels/group";
import type { ChannelStore } from "../channels/routes";
import type { DeploymentConfig } from "../config";
import type { Database } from "../db/client";
import { threadChannelMappings } from "../db/schema";
import type { LocalRuntime } from "../runtime/local-runtime";
import { repeatAfterEach } from "../work/loop";
import { createWorkQueue, startWorkOfferedListener, type WorkOfferedListener } from "../work/queue";
import { HANDOFF_KIND } from "./handoff";
import { createHandoffDelivery } from "./handoff-delivery";
import { createHandoffRunner } from "./handoff-runner";
import { signHandoffDeliveryRun } from "./handoff-signing";
import type { AgentActor } from "./profile-types";
import { serverTurnAdmission } from "./turn-admission";

/** Queue ownership belongs here; execution ownership belongs to the local runtime. */
export async function startHandoffDelivery(deps: {
  config: DeploymentConfig;
  database: Database;
  bootAuditStore: AuditStore;
  actorFor(ownerUserId: string): Promise<AgentActor>;
  localRuntime: LocalRuntime;
  groupConversations: GroupConversations;
  channelStore: ChannelStore;
}): Promise<WorkOfferedListener> {
  const { config, database, bootAuditStore, actorFor, localRuntime, groupConversations, channelStore } = deps;
  const queue = createWorkQueue(database);
  const delivery = createHandoffDelivery({
    admission: serverTurnAdmission, threads: localRuntime.threads, runner: localRuntime.runner,
    agentFor: async ({ actorId, botId, fromBotId, initiator }) => localRuntime.agentFor({
      actor: await actorFor(actorId), botId, initiator: handoffInitiator(fromBotId, initiator),
    }),
  });
  const runner = createHandoffRunner({
    queue, owner: workOwner("handoff"), auditStore: bootAuditStore,
    sign: (work, key) => signHandoffDeliveryRun(work, config.keyEncryptionKey, key),
    complete: async ({ actorId, ...input }) => {
      const message = input.message;
      const text = message && typeof message.content === "string" ? message.content : null;
      const groupMessage = text !== null && message?.senderBotId
        ? await groupConversations.prepareHandoff({
            threadId: input.threadId, actorId, agentId: message.senderBotId, text, messageId: input.key,
          })
        : null;
      const kept = await localRuntime.threads.completeHandoff({ ...input, groupMessage: groupMessage ?? undefined });
      if (!kept || text === null || !message?.senderBotId) return kept;
      try {
        if (groupMessage) await groupConversations.announceHandoff(groupMessage);
        else {
          const [mapped] = await database.select({ channelId: threadChannelMappings.channelId })
            .from(threadChannelMappings).where(eq(threadChannelMappings.threadId, input.threadId)).limit(1);
          if (mapped) await channelStore.recordActivity(await actorFor(actorId), mapped.channelId,
            { text, agentId: message.senderBotId, at: new Date() }, { id: input.key });
        }
      } catch (error) { console.warn("Could not announce a committed delegation answer.", error); }
      return kept;
    },
    runState: key => localRuntime.threads.run(key),
    delivery: {
      async deliver(input) {
        await channelStore.signalBusy(input.work.threadId, true, input.key)
          .catch(error => console.warn("Could not show delegation progress.", error));
        try { return await delivery.deliver(input); }
        finally {
          await channelStore.signalBusy(input.work.threadId, false, input.key)
            .catch(error => console.warn("Could not clear delegation progress.", error));
        }
      },
    },

  });
  let sweeping = false;
  let sweepAgain = false;
  const kick = async () => {
    if (sweeping) { sweepAgain = true; return; }
    sweeping = true;
    try {
      do {
        sweepAgain = false;
        const report = await runner.sweep();
        if (report.delivered.length || report.skipped.length) console.info(JSON.stringify({ type: "bot-handoff", ...report }));
      } while (sweepAgain);
    } catch (error) {
      console.warn("The delegation queue could not run.", error);
    } finally { sweeping = false; }
  };
  const listener = await startWorkOfferedListener(config.databaseUrl, kind => { if (kind === HANDOFF_KIND) void kick(); });
  repeatAfterEach(kick, 2_000);
  return listener;
}
