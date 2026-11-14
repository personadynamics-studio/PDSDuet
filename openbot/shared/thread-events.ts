import type { BaseEvent, Message } from "@ag-ui/core";

export type ThreadMessage = Message & { senderBotId?: string; senderUserId?: string; createdAt?: string };
export type ThreadEvent = BaseEvent & Record<string, unknown> & { seq?: number; senderBotId?: string };
export type RunStatus = "running" | "waiting" | "completed" | "failed" | "stopped" | "interrupted";
export type ThreadRun = { id: string; status: RunStatus; error?: string; waiting?: { toolCallId: string; toolName: string; answerable?: boolean; metadata?: Record<string, unknown> }[] };

function put(rows: readonly ThreadMessage[], message: ThreadMessage): ThreadMessage[] {
  return rows.some((row) => row.id === message.id) ? rows.map((row) => row.id === message.id ? message : row) : [...rows, message];
}

/** Persisted events and live views consume the same message identities and authors. */
export function projectThreadEvent(rows: readonly ThreadMessage[], event: ThreadEvent): ThreadMessage[] {
  if (event.type === "MESSAGES_SNAPSHOT") return event.messages as ThreadMessage[];
  if (event.type === "CUSTOM" && event.name === "thread.message") return put(rows, event.value as ThreadMessage);
  const id = typeof event.messageId === "string" ? event.messageId : undefined;
  const sender = event.senderBotId ? { senderBotId: event.senderBotId } : {};
  if (event.type === "TEXT_MESSAGE_START" && id) return rows.some((row) => row.id === id) ? [...rows] : put(rows, { id, role: "assistant", content: "", ...sender });
  if (event.type === "TEXT_MESSAGE_CONTENT" && id) {
    const row = rows.find((item) => item.id === id);
    return put(rows, { ...(row?.role === "assistant" ? row : { id, role: "assistant" as const, content: "" }), ...sender,
      content: `${typeof row?.content === "string" ? row.content : ""}${String(event.delta ?? "")}` });
  }
  if (event.type === "TOOL_CALL_START" && typeof event.parentMessageId === "string") {
    const parent = event.parentMessageId;
    const row = rows.find((item) => item.id === parent);
    const calls = row?.role === "assistant" ? row.toolCalls ?? [] : [];
    if (calls.some((call) => call.id === event.toolCallId)) return [...rows];
    return put(rows, { ...(row?.role === "assistant" ? row : { id: parent, role: "assistant" as const, content: "" }), ...sender,
      toolCalls: [...calls, { id: String(event.toolCallId), type: "function", function: { name: String(event.toolCallName), arguments: "" } }] });
  }
  if (event.type === "TOOL_CALL_ARGS") return rows.map((row) => row.role !== "assistant" || !row.toolCalls?.some((call) => call.id === event.toolCallId) ? row : ({ ...row,
    toolCalls: row.toolCalls?.map((call) => call.id === event.toolCallId ? { ...call, function: { ...call.function, arguments: call.function.arguments + String(event.delta ?? "") } } : call) }));
  if (event.type === "TOOL_CALL_RESULT" && id) return put(rows, { id, role: "tool", toolCallId: String(event.toolCallId),
    content: typeof event.content === "string" ? event.content : JSON.stringify(event.content ?? null), ...sender });
  if (event.type === "ACTIVITY_SNAPSHOT" && id) return put(rows, { id, role: "activity", activityType: String(event.activityType), content: event.content as Record<string, unknown>, ...sender });
  return [...rows];
}
