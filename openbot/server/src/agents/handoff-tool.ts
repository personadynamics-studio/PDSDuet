/**
 * The tool one Bot uses to hand work to another.
 *
 * Offered beside a Bot's granted tools rather than through a new transport, so which Bots may reach
 * which other Bots is an ordinary grant an administrator makes. A Bot with no such grant is offered
 * nothing and cannot address anybody, which is the correct default.
 *
 * WHAT IT TAKES IS TYPED, and that is the one place this departs from the obvious build. The natural
 * shape is `message_bot(target, message)` and free text is the commonest way a multi-agent system
 * goes quietly wrong: the receiving Bot infers the intent, re-derives the constraints and guesses
 * what shape of answer was wanted, and when it guesses wrong it does not fail, it returns something
 * else confidently. Naming the parts costs the asking model a little effort and removes most of that.
 */

import { z } from "zod";
import { HANDED_OVER } from "@openbot/shared/handoff-markers";
import {
  type ApprovalGate,
  ApprovalRefusedError,
  currentApprovalContext,
} from "../approvals/types";
import { type AuditStore, recordAuditEvent } from "../audit";
import type { GrantedTool, ToolExecutionContext } from "@openbot/toolkit/granted-tool";
import { REFUSAL_MARKER } from "../plugins/tools";
import type {
  CheckPrivateShare,
  PrivateShareInput,
  ShareAudience,
} from "../proactive/private-share";
import type { RunAssertion } from "./callback-token";
import {
  ESCALATE_TOOL,
  type EscalationRoute,
  escalationTool,
  PUT_TO,
} from "./escalation";
import type { AddressableBot, CoordinationSource, HandoffCaps, HandoffDesk } from "./handoff";

/** What the model is offered. One name, so a transcript can find every hop by searching for it. */
export const HANDOFF_TOOL = "message_bot";

const parameters = z.object({
  bot: z.string().min(1).describe("The exact Bot ID from the available Bots list."),
  task: z.string().min(1).describe("What the other Bot should do."),
  constraints: z.string().optional().describe("Any limits on that work."),
  expecting: z.string().optional().describe("What a useful answer should contain."),
});

type HandoffExecution = {
  desk: HandoffDesk;
  from: RunAssertion;
  approvalGate?: ApprovalGate;
  privateShare?: PrivateShareGate;
};

async function executeHandoff(options: HandoffExecution, args: unknown, context?: ToolExecutionContext): Promise<string> {
  context?.signal?.throwIfAborted();
  const parsed = parameters.safeParse(args);
  if (!parsed.success) return "Nothing was sent: provide a Bot ID and its task.";
  if (!context?.toolCallId) throw new Error("The delegation is missing its tool call ID.");
  const { from, desk, approvalGate, privateShare } = options;
  const outcome = await desk.send({
    from, target: parsed.data.bot, envelope: parsed.data,
    toolCallId: context.toolCallId, signal: context.signal,
    beforeSend: async (target) => {
      if (approvalGate) {
        try {
          const approval = await approvalGate({
            actorId: from.actorId, botId: from.botId, toolRef: `bot/${HANDOFF_TOOL}`,
            effect: "delegate", scope: target.id, args: parsed.data,
            target: { bot: target.id }, continuation: currentApprovalContext(),
          }, context);
          if (approval && "replay" in approval)
            return typeof approval.replay === "string" ? approval.replay : JSON.stringify(approval.replay);
        } catch (error) {
          if (error instanceof ApprovalRefusedError) return `Nothing was sent: ${error.message}`;
          throw error;
        }
      }
      context.signal?.throwIfAborted();
      if (privateShare && target.ownerUserId && target.ownerUserId !== from.actorId) {
        const held = await sharePermission(privateShare, {
          from,
          audience: { kind: "handoff", id: target.ownerUserId, recipientUserIds: [target.ownerUserId], label: target.name },
          origin: { kind: "private_conversation" },
          content: [parsed.data.task, parsed.data.constraints, parsed.data.expecting],
          refused: "Nothing was sent",
        });
        context.signal?.throwIfAborted();
        if (held) return held;
      }
    },
  });
  if ("handled" in outcome) return outcome.handled;
  return outcome.ok
    ? `${HANDED_OVER}${outcome.toName}. Its answer will appear here under its own name. Say who you asked and what for, then end your turn.`
    : outcome.refusal;
}

/** Offer the same formal Bot IDs the desk accepts; names and roles are descriptive data. */
export function handoffTool(options: HandoffExecution & HandoffCaps & { reachable: readonly AddressableBot[] }): GrantedTool | null {
  if (options.maxDepth <= 0 || options.maxPerRun <= 0 || (options.from.depth ?? 0) >= options.maxDepth)
    return null;
  const [first, ...rest] = options.reachable;
  if (!first) return null;
  return {
    name: HANDOFF_TOOL, ref: `bot/${HANDOFF_TOOL}`,
    description: "Ask another Bot to do work that fits its role. Choose an exact ID from this descriptive list: " +
      JSON.stringify(options.reachable) + ". Its answer is delivered to this conversation under that Bot's name.",
    parameters: parameters.extend({ bot: z.enum([first.id, ...rest.map(bot => bot.id)]) }),
    execute: (args, context) => executeHandoff(options, args, context),
  };
}

/**
 * The private-information check for the already-resolved recipient and source audience.
 */
export type PrivateShareGate = {
  check: CheckPrivateShare;
  /**
   * Who besides the owner would read an `ask_person` question from this run, and where the run's
   * content came from. Null when only the owner reads it, which is the ordinary case.
   */
  questionAudience?: (from: RunAssertion, source: CoordinationSource) => Promise<{
    audience: ShareAudience;
    origin: PrivateShareInput["origin"];
  } | null>;
};

/**
 * Asks the private-share check and turns a hold into what the tool answers. Undefined means go
 * ahead. A turn nobody is watching waits durably and resumes on the decision; a person's own turn is
 * answered, so the model tells them what it is waiting for.
 */
async function sharePermission(
  gate: PrivateShareGate,
  input: {
    from: RunAssertion;
    audience: ShareAudience;
    origin: PrivateShareInput["origin"];
    content: (string | undefined)[];
    refused: string;
  },
): Promise<string | undefined> {
  const continuation = currentApprovalContext();
  const verdict = await gate.check({
    ownerUserId: input.from.actorId,
    botId: input.from.botId,
    audience: input.audience,
    content: input.content.filter(Boolean).join("\n\n"),
    origin: input.origin,
    ...(continuation ? { continuation } : {}),
  });
  if (verdict.status === "allowed") return undefined;
  if (verdict.status === "denied")
    return `${input.refused}: ${verdict.message}`;
  const initiator = continuation?.initiator;
  if (initiator && initiator.kind !== "person") throw verdict.suspension;
  return `${input.refused} yet: ${verdict.message} Tell the person you are waiting for their permission on your page in OpenBot.`;
}

/** Re-exported so callers of this module do not need to know where it is declared. */
export { HANDED_OVER };

/** Shared definitions and execution for built-in runs and authenticated remote callbacks. */
export function createCoordinationTools(options: {
  desk: HandoffDesk;
  caps: HandoffCaps;
  addressableBots: (run: RunAssertion) => Promise<readonly AddressableBot[]>;
  route: EscalationRoute;
  auditStore: AuditStore;
  authoriseRun: (run: RunAssertion) => Promise<CoordinationSource | null>;
  approvalGate?: ApprovalGate;
  privateShare?: PrivateShareGate;
}) {
  const asking = (from: RunAssertion, source: CoordinationSource): GrantedTool => {
    const tool = escalationTool({
      from,
      route: question => options.route({ ...question, source }),
      auditStore: options.auditStore,
    });
    const gate = options.privateShare;
    if (!gate?.questionAudience) return tool;
    const questionAudience = gate.questionAudience;
    return {
      ...tool,
      /*
       * A question that would reach somebody besides the owner, a group conversation or a shared
       * channel, carries the owner's private work to them, so it waits for the owner's permission
       * like a handoff to another person's Bot. Nothing is put to anybody while it waits.
       */
      execute: async (args: unknown, context?: ToolExecutionContext) => {
        context?.signal?.throwIfAborted();
        const reach = await questionAudience(from, source);
        if (reach) {
          const input = (args ?? {}) as { question?: unknown; why?: unknown };
          const held = await sharePermission(gate, {
            from,
            audience: reach.audience,
            origin: reach.origin,
            content: [
              typeof input.question === "string" ? input.question : undefined,
              typeof input.why === "string" ? input.why : undefined,
            ],
            refused: "That was not put to anybody",
          });
          if (held) return held;
        }
        context?.signal?.throwIfAborted();
        return tool.execute(args, context);
      },
    };
  };
  return {
    async toolsForRun(from: RunAssertion): Promise<GrantedTool[]> {
      // Offer coordination only to this runtime's live or approved waiting execution.
      const source = await options.authoriseRun(from);
      if (!source) return [];
      const canHandOn =
        options.caps.maxDepth > 0 &&
        options.caps.maxPerRun > 0 &&
        (from.depth ?? 0) < options.caps.maxDepth;
      const passing = canHandOn
        ? handoffTool({
            desk: options.desk, from, reachable: await options.addressableBots(from), ...options.caps,
            approvalGate: options.approvalGate, privateShare: options.privateShare,
          })
        : null;
      return passing ? [passing, asking(from, source)] : [asking(from, source)];
    },
    async call(input: {
      name: string;
      args: Record<string, unknown>;
      run: RunAssertion;
      context?: ToolExecutionContext;
    }): Promise<{ text: string; isError: boolean } | null> {
      const name = input.name.replace(/^bot\//, "");
      if (name !== HANDOFF_TOOL && name !== ESCALATE_TOOL) return null;
      input.context?.signal?.throwIfAborted();
      const source = await options.authoriseRun(input.run);
      if (!source) {
        const text = `${REFUSAL_MARKER} This run no longer has permission to coordinate work in this conversation.`;
        await recordAuditEvent(options.auditStore, {
          eventType: "mcp.callback_refused",
          targetType: "agent",
          targetId: input.run.botId,
          actorUserId: input.run.actorId,
          ...(input.run.initiator ? { initiator: input.run.initiator } : {}),
          payload: {
            bot: input.run.botId,
            run: input.run.runId,
            tool: name,
            reason: "coordination_scope_refused",
          },
        });
        return { text, isError: true };
      }
      input.context?.signal?.throwIfAborted();
      const text = name === HANDOFF_TOOL
        ? await executeHandoff({
            desk: options.desk, from: input.run,
            approvalGate: options.approvalGate, privateShare: options.privateShare,
          }, input.args, input.context)
        : await asking(input.run, source).execute(input.args, input.context);
      const isError = !text.startsWith(
        name === HANDOFF_TOOL ? HANDED_OVER : PUT_TO,
      );
      return { text: isError ? `${REFUSAL_MARKER} ${text}` : text, isError };
    },
  };
}
