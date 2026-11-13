import type { Message, RunAgentInput } from "@ag-ui/client";
import type { ToolExecutionOptions } from "ai";
import { withApprovalContext } from "./continuation";
import type { ApprovalContinuation } from "./continuation";
import { HeadlessToolSuspension } from "./headless-tools";
import type { AuditInitiator } from "./initiator";

export { OPENBOT_WAITING_METADATA } from "./headless-tools";

/** The SDK execution and its owning run, passed directly to the tool. */
export type NativeToolExecution = ToolExecutionOptions & {
  input: RunAgentInput;
  initialMessageCount: number;
  run: { waiting?: HeadlessToolSuspension };
};

export function nativeMessageId(runId: string, step: number): string {
  return `native:${runId}:${step}`;
}

/** SDK history contains previous steps; the current call comes from its execution arguments. */
function continuationMessages(execution: NativeToolExecution): Message[] {
  const messages = [...execution.input.messages];
  let step = 0;
  for (const message of execution.messages.slice(execution.initialMessageCount)) {
    if (message.role === "assistant") {
      const parts = typeof message.content === "string"
        ? [{ type: "text" as const, text: message.content }]
        : message.content;
      messages.push({
        id: nativeMessageId(execution.input.runId, step++),
        role: "assistant",
        content: parts.flatMap((part) => part.type === "text" ? [part.text] : []).join(""),
        toolCalls: parts.flatMap((part) => part.type === "tool-call" ? [{
          id: part.toolCallId,
          type: "function" as const,
          function: { name: part.toolName, arguments: JSON.stringify(part.input) },
        }] : []),
      });
    } else if (message.role === "tool") {
      for (const part of message.content) {
        if (part.type !== "tool-result") continue;
        messages.push({
          id: `tool-result:${part.toolCallId}`,
          role: "tool",
          toolCallId: part.toolCallId,
          content: part.output.type === "text" || part.output.type === "error-text"
            ? part.output.value
            : JSON.stringify(part.output),
        });
      }
    }
  }
  return messages;
}

export async function executeNativeApprovalTool<T>(
  name: string,
  args: unknown,
  execution: NativeToolExecution,
  initiator: AuditInitiator | undefined,
  execute: () => Promise<T>,
): Promise<T> {
  execution.abortSignal?.throwIfAborted();
  if (execution.run.waiting) throw execution.run.waiting;
  const messages = continuationMessages(execution);
  const step = execution.messages.slice(execution.initialMessageCount)
    .filter((message) => message.role === "assistant").length;
  messages.push({
    id: nativeMessageId(execution.input.runId, step),
    role: "assistant",
    content: "",
    toolCalls: [{
      id: execution.toolCallId,
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    }],
  });
  const continuation: ApprovalContinuation = {
      runId: execution.input.runId,
      threadId: execution.input.threadId,
      toolCallId: execution.toolCallId,
      toolName: name,
      args,
      messages,
      state: execution.input.state,
      context: execution.input.context,
      forwardedProps: execution.input.forwardedProps,
      initiator,
  };
  try {
    return await withApprovalContext(continuation, execute);
  } catch (error) {
    if (error instanceof HeadlessToolSuspension) {
      error.waiting.continuation ??= continuation;
      execution.run.waiting ??= error;
    }
    throw error;
  }
}
