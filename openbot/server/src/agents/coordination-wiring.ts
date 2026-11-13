import { HeadlessToolSuspension } from "@openbot/toolkit/headless-tools";
import type { ToolExecutionContext } from "@openbot/toolkit/granted-tool";
import { eq, sql } from "drizzle-orm";
import { PERSON_QUESTION_WAITING } from "../approvals/question-resume";
import type { ApprovalService } from "../approvals/service";
import { currentApprovalContext } from "../approvals/types";
import {
  type AuditInitiator,
  type AuditStore,
  PERSON_INITIATOR,
} from "../audit";
import type { ChannelStore } from "../channels/routes";
import type { DeploymentConfig } from "../config";
import type { Database } from "../db/client";
import { channelMemberships, workItems } from "../db/schema";
import type { DeliveryScope } from "../delivery/types";
import type { PluginStore } from "../plugins/store";
import { REFUSAL_MARKER } from "../plugins/tools";
import { createPrivateShareCheck } from "../proactive/private-share";
import { WORK_OFFERED_TOPIC } from "../work/queue";
import { RunStoppedError } from "../runtime/thread-store";
import { type RunAssertion, readRunAssertion } from "./callback-token";
import type { HandoffDesk } from "./handoff";
import { createCoordinationTools } from "./handoff-tool";
import type { AgentProfileStore } from "./profile-store";
import type { AgentActor } from "./profile-types";

/**
 * Bots coordinating with each other and with people: handing work on, asking a person a question,
 * and the per-run tools a Bot is given for both.
 *
 * Moved out of index.ts verbatim. `notify` is taken as a function because index.ts assigns delivery
 * after this is created: a question reads it when it is routed, never when this is built.
 */
export function wireCoordination(deps: {
  handoffDesk: HandoffDesk;
  config: DeploymentConfig;
  approvalService: ApprovalService;
  agentProfileStore: AgentProfileStore;
  actorFor: (ownerUserId: string) => Promise<AgentActor>;
  database: Database;
  pluginStore: PluginStore;
  bootAuditStore: AuditStore;
  sourceForCoordinationRun: (
    run: RunAssertion,
  ) => Promise<{ channelId: string; botId: string; group?: boolean } | null>;
  channelStore: ChannelStore;
  notify: (
    scope: DeliveryScope,
    input: {
      id: string;
      text: string;
      kind: "question";
      requestId: string;
    },
  ) => Promise<void>;
}) {
  const {
    handoffDesk,
    config,
    approvalService,
    agentProfileStore,
    actorFor,
    database,
    pluginStore,
    bootAuditStore,
    sourceForCoordinationRun,
    channelStore,
  } = deps;
  const coordination = createCoordinationTools({
    desk: handoffDesk,
    caps: config.handoff,
    approvalGate: approvalService.gate,
    privateShare: {
      check: createPrivateShareCheck({ approvals: approvalService.store }),
      // A question from a conversation other people are in reaches them too, so it is held like a
      // handoff to another person. Only the owner reading it is the ordinary, unheld case.
      questionAudience: async (from, source) => {
        const members = (
          await database
            .select({ userId: channelMemberships.userId })
            .from(channelMemberships)
            .where(eq(channelMemberships.channelId, source.channelId))
        ).map((row) => row.userId);
        if (members.every((userId) => userId === from.actorId)) return null;
        return {
          audience: {
            kind: source.group ? "group" : "channel",
            id: source.channelId,
            recipientUserIds: members,
          },
          // A channel thread is the conversation itself; a group Bot's own thread also holds context
          // only its owner has seen.
          origin: source.group
            ? { kind: "private_conversation" }
            : { kind: "shared_conversation", sharedWithUserIds: members },
        };
      },
    },
    addressableBots: async (from) => {
      const [granted, roster] = await Promise.all([
        pluginStore.botsReachableFrom(from.botId),
        agentProfileStore.list(await actorFor(from.actorId)),
      ]);
      const ids = new Set(granted);
      return roster
        .filter(bot => ids.has(bot.id) && bot.id !== from.botId && !bot.hidden && bot.deletedAt === null)
        .map(({ id, name, title, roleDescription }) => ({ id, name, title, roleDescription }));
    },
    auditStore: bootAuditStore,
    authoriseRun: async (run) => {
      const rows = await database.execute<{ id: string }>(sql`select id from local_runs
        where id=${run.runId} and user_id=${run.actorId} and agent_id=${run.botId}
          and status in ('running','waiting') and stop_requested=false`);
      return rows.length > 0 ? sourceForCoordinationRun(run) : null;
    },
    route: async (question) => {
      const { source, signal, ...asked } = question;
      if (!source)
        return {
          refusal: "That question could not reach its source conversation.",
        };
      signal?.throwIfAborted();
      const key = `${question.runId.length}:${question.runId}:${question.toolCallId}`;
      const queued = await database.transaction(async transaction => {
        const current = await transaction.execute<{ id: string }>(sql`select id from local_runs
          where id=${question.runId} and user_id=${question.actorId} and agent_id=${question.botId}
            and status in ('running','waiting') and stop_requested=false for update`);
        if (!current.length) throw new RunStoppedError("The question's source work was cancelled.");
        const [inserted] = await transaction.insert(workItems).values({
          kind: "person.question", key,
          payload: {
            ...asked, sourceBotId: source.botId, channelId: source.channelId,
            mode: "completed_question", toolName: "ask_person",
            args: { question: question.question, ...(question.why ? { why: question.why } : {}) },
          },
        }).onConflictDoNothing().returning({ key: workItems.key });
        if (inserted) await transaction.execute(sql`select pg_notify(${WORK_OFFERED_TOPIC}, ${"person.question"})`);
        return inserted ? "queued" : "already";
      });
      if (queued === "already")
        return { reached: "the person in the source conversation; this tool call already has its question saved" };
      signal?.throwIfAborted();
      await channelStore.recordActivity(
        await actorFor(question.actorId),
        source.channelId,
        {
          text: `A question needs your answer: ${question.question}`,
          agentId: source.botId,
          at: new Date(),
        },
        { id: `question:${key}` },
      );
      if (question.threadId) {
        // A person reads this in Slack or on their phone, where "general-assistant" is an id, not a name.
        const botName =
          (
            await agentProfileStore
              .get(await actorFor(question.actorId), question.botId)
              .catch(() => null)
          )?.name ?? question.botId;
        await deps.notify(
          {
            ownerUserId: question.actorId,
            channelId: source.channelId,
            agentId: source.botId,
            threadId: question.threadId,
          },
          {
            id: key,
            text: `${botName} asks: ${question.question}`,
            kind: "question",
            requestId: key,
          },
        );
      }
      return {
        reached:
          "the person in the source conversation; the question is saved awaiting their reply",
      };
    },
  });
  const coordinationForActor =
    (
      actorId: string,
      initiator: AuditInitiator = PERSON_INITIATOR,
      baseDepth = 0,
    ) =>
    async (botId: string, input: import("@ag-ui/client").RunAgentInput) => {
      const assertion = readRunAssertion(
        input.forwardedProps?.openbotRun,
        config.keyEncryptionKey,
      );
      if (
        assertion &&
        (assertion.botId !== botId || assertion.actorId !== actorId)
      )
        throw new Error("The run assertion does not match this Bot and owner.");
      const run: RunAssertion = {
        botId, actorId, runId: input.runId, threadId: input.threadId,
        depth: assertion?.depth ?? baseDepth, initiator: assertion?.initiator ?? initiator,
      };
      const tools = await coordination.toolsForRun(run);
      return tools.map((tool) => ({
        ...tool,
        execute: async (args: unknown, context?: ToolExecutionContext) => {
          if (!args || typeof args !== "object" || Array.isArray(args))
            return `${REFUSAL_MARKER} Tool arguments must be an object.`;
          const result = await coordination.call({
            name: tool.name,
            args: args as Record<string, unknown>,
            run,
            context,
          });
          if (!result)
            throw new Error("A coordination tool was not dispatched.");
          /*
           * A responsibility's question pauses its run, the way an approval does.
           *
           * Left running, the run ended "succeeded" the moment the question was saved, and the answer
           * came back to a run that was already over: the Bot read it, and then the store refused its
           * progress because it was not from the responsibility's current run, so the goal stayed
           * open for ever. Suspended, the run waits, and the answer resumes that same run as this
           * tool's result, with the right to record progress and finish.
           */
          const snapshot = currentApprovalContext();
          if (
            tool.name === "ask_person" &&
            run.initiator?.kind === "responsibility" &&
            snapshot &&
            !result.text.startsWith(REFUSAL_MARKER)
          )
            throw new HeadlessToolSuspension(
              "This responsibility is waiting for the person's answer.",
              {
                kind: PERSON_QUESTION_WAITING,
                continuation: snapshot,
              },
            );
          return result.text;
        },
      }));
    };
  return { coordination, coordinationForActor };
}
