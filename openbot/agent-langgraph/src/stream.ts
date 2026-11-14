import type { BaseEvent, RunAgentInput } from "@ag-ui/core";
import type { AIMessage } from "@langchain/core/messages";
import { textOfChunk } from "./deltas";

export const EMPTY_REPLY_FALLBACK =
  "The model returned an empty reply and the run ended without an answer. This can happen with a strict provider; try asking again.";

export interface RunStreamEvent {
  event: string;
  name?: string;
  data?: { chunk?: { content?: unknown }; output?: unknown };
}

/** One model segment, with the complete tool batch handed to the server's executor. */
export async function streamRun(
  makeEvents: () => Promise<AsyncIterable<RunStreamEvent>>,
  input: Pick<RunAgentInput, "runId" | "threadId">,
  send: (event: BaseEvent) => void,
): Promise<void> {
  const messageId = crypto.randomUUID();
  const pending = new Map<string, { name: string; args: Record<string, unknown> }>();
  let textOpen = false;
  let visible = false;
  const closeText = () => {
    if (!textOpen) return;
    send({ type: "TEXT_MESSAGE_END", messageId } as BaseEvent);
    textOpen = false;
  };
  try {
    for await (const event of await makeEvents()) {
      if (event.event === "on_chat_model_stream") {
        const text = textOfChunk(event.data?.chunk?.content);
        if (!text) continue;
        if (!textOpen) {
          send({ type: "TEXT_MESSAGE_START", messageId, role: "assistant" } as BaseEvent);
          textOpen = true;
        }
        send({ type: "TEXT_MESSAGE_CONTENT", messageId, delta: text } as BaseEvent);
        visible = true;
      }
      if (event.event === "on_chat_model_end") {
        for (const call of (event.data?.output as AIMessage | undefined)?.tool_calls ?? []) {
          if (!call.id) throw new Error("The model returned a tool call without an ID.");
          pending.set(call.id, { name: call.name, args: (call.args ?? {}) as Record<string, unknown> });
        }
      }
    }
    closeText();
    for (const [id, call] of pending) {
      send({ type: "TOOL_CALL_START", toolCallId: id, toolCallName: call.name, parentMessageId: messageId } as BaseEvent);
      send({ type: "TOOL_CALL_ARGS", toolCallId: id, delta: JSON.stringify(call.args) } as BaseEvent);
      send({ type: "TOOL_CALL_END", toolCallId: id } as BaseEvent);
    }
    if (!visible && !pending.size) {
      send({ type: "TEXT_MESSAGE_START", messageId, role: "assistant" } as BaseEvent);
      send({ type: "TEXT_MESSAGE_CONTENT", messageId, delta: EMPTY_REPLY_FALLBACK } as BaseEvent);
      send({ type: "TEXT_MESSAGE_END", messageId } as BaseEvent);
    }
    send({
      type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId,
      ...(pending.size ? { outcome: { type: "interrupt", interrupts: [...pending.keys()].map(id => ({
        id, toolCallId: id, reason: "tool_execution", message: "Waiting for the server tool executor.",
      })) } } : {}),
    } as BaseEvent);
  } catch (error) {
    closeText();
    send({ type: "RUN_ERROR", message: error instanceof Error ? error.message : "The Bot could not answer." } as BaseEvent);
  }
}
