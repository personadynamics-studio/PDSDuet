import type { GrantedTool } from "@openbot/toolkit/granted-tool";
import { HeadlessToolSuspension } from "@openbot/toolkit/headless-tools";
import type { Execution } from "../runtime/execution";
import { z } from "zod";
import type { AuditInitiator } from "../audit";
import type { AgentProfileStore } from "./profile-store";
import type { AgentActor } from "./profile-types";

/** Bot collaboration uses the same visible roster and executor as a person's turn. */
export function createBotTools(options: {
  profiles: AgentProfileStore;
  execution: Execution;
}) {
  return async (source: {
    actor: AgentActor;
    botId: string;
    threadId: string;
    runId: string;
    initiator?: AuditInitiator;
  }): Promise<GrantedTool[]> => {
    const roster = (await options.profiles.list(source.actor))
      .filter(bot => bot.id !== source.botId)
      .map(({ id, name, title, roleDescription }) => ({ id, name, title, roleDescription }));
    const questionParameters = z.object({ question: z.string().trim().min(1), why: z.string().optional() });
    const tools: GrantedTool[] = [{
      name: "list_bots",
      ref: "bot/list_bots",
      description: "List the other Bots visible to this person, with their exact IDs, names and roles. This list excludes you; use message_bot to ask one of these peers for help.",
      parameters: z.object({}),
      execute: async (_args, context) => {
        context?.signal?.throwIfAborted();
        return JSON.stringify(roster);
      },
    }, {
      name: "ask_person",
      ref: "bot/ask_person",
      description: "Ask the person a question and wait for their actual answer.",
      parameters: questionParameters,
      execute: async (args, context) => {
        context?.signal?.throwIfAborted();
        const question = questionParameters.parse(args);
        if (!context?.toolCallId) throw new Error("The question is missing its tool call ID.");
        throw new HeadlessToolSuspension(question.question, {
          kind: "person_question",
          toolName: "ask_person",
          toolCallId: context.toolCallId,
        });
      },
    }];
    const [first, ...rest] = roster;
    if (first) {
      const parameters = z.object({
        botId: z.enum([first.id, ...rest.map(bot => bot.id)]),
        message: z.string().trim().min(1),
      });
      tools.push({
        name: "message_bot",
        ref: "bot/message_bot",
        description: "Delegate an internal task to another Bot. Use its exact ID from this list: " +
          JSON.stringify(roster) +
          ". Its response returns to you as private tool data and is not delivered directly to the person. Use the peer's findings to finish the task and answer your requester; do not merely announce that you forwarded it.",
        parameters,
        execute: async (args, context) => {
          context?.signal?.throwIfAborted();
          const input = parameters.parse(args);
          const result = await options.execution.run({
            actor: source.actor,
            botIds: [input.botId],
            threadId: source.threadId,
            parentRunId: source.runId,
            instruction: input.message,
            signal: context?.signal,
            initiator: {
              kind: "handoff",
              id: source.runId,
              ...(source.initiator ? { origin: source.initiator } : {}),
            },
          });
          if (result.status === "waiting") throw new HeadlessToolSuspension(
            "The other Bot is waiting for the person in this conversation.",
            { kind: "bot_wait", childRunId: result.runId },
          );
          return JSON.stringify({
            requesterBotId: source.botId,
            botId: input.botId,
            runId: result.runId,
            status: result.status,
            ...(result.error ? { error: result.error } : {}),
            answer: result.replyText,
          });
        },
      });
    }
    return tools;
  };
}
