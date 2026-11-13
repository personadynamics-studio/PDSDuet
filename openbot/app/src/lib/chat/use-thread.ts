import type { Message } from "@ag-ui/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { client } from "@/lib/client";
import { newId } from "@/lib/new-id";

type Run = { id: string; status: string };
type Snapshot = { messages: Message[]; activeRun?: Run; cursor: number };
type Event = Record<string, unknown> & { type: string; seq?: number };

function upsert(rows: Message[], row: Message): Message[] {
  const index = rows.findIndex((item) => item.id === row.id);
  return index < 0 ? [...rows, row] : rows.map((item, at) => at === index ? row : item);
}

/** Apply the persisted event format shared by browser and background executions. */
function receive(rows: Message[], event: Event): Message[] {
  const id = typeof event.messageId === "string" ? event.messageId : "";
  if (event.type === "MESSAGES_SNAPSHOT" && Array.isArray(event.messages)) return event.messages as Message[];
  if (event.type === "TEXT_MESSAGE_START") return upsert(rows, { id, role: "assistant", content: "" });
  if (event.type === "TEXT_MESSAGE_CONTENT") {
    const found = rows.find((row) => row.id === id);
    return upsert(rows, { ...(found?.role === "assistant" ? found : { id, role: "assistant" as const }), content: `${typeof found?.content === "string" ? found.content : ""}${typeof event.delta === "string" ? event.delta : ""}` });
  }
  if (event.type === "TOOL_CALL_START") {
    const parent = typeof event.parentMessageId === "string" ? event.parentMessageId : `tool-parent:${String(event.toolCallId)}`;
    const found = rows.find((row) => row.id === parent);
    const calls = found?.role === "assistant" ? found.toolCalls ?? [] : [];
    if (calls.some((call) => call.id === event.toolCallId)) return rows;
    return upsert(rows, { ...(found?.role === "assistant" ? found : { id: parent, role: "assistant" as const, content: "" }), toolCalls: [...calls, { id: String(event.toolCallId), type: "function", function: { name: String(event.toolCallName), arguments: "" } }] });
  }
  if (event.type === "TOOL_CALL_ARGS") return rows.map((row) => row.role !== "assistant" ? row : ({ ...row, toolCalls: row.toolCalls?.map((call) => call.id === event.toolCallId ? { ...call, function: { ...call.function, arguments: call.function.arguments + String(event.delta ?? "") } } : call) }));
  if (event.type === "TOOL_CALL_RESULT") return upsert(rows, { id: id || `tool-result:${String(event.toolCallId)}`, role: "tool", toolCallId: String(event.toolCallId), content: typeof event.content === "string" ? event.content : JSON.stringify(event.content ?? null) });
  if (event.type === "ACTIVITY_SNAPSHOT" && id && typeof event.activityType === "string" && event.content && typeof event.content === "object") return upsert(rows, { id, role: "activity", activityType: event.activityType, content: event.content as Record<string, unknown> });
  return rows;
}

export function useThread(threadId: string, agentId: string) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [activeRun, setActiveRun] = useState<Run>();
  const [restoring, setRestoring] = useState(true);
  const [reconnecting, setReconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const cursor = useRef(0);
  const source = useRef<EventSource | null>(null);
  const alive = useRef(false);
  const refreshing = useRef(false);
  const revision = useRef(0);
  const watch = useRef<() => void>(() => {});
  const base = `/api/threads/${encodeURIComponent(threadId)}`;

  const refresh = useCallback(async () => {
    if (refreshing.current) return;
    refreshing.current = true;
    const requestedRevision = revision.current;
    try {
      const response = await client(`${base}/messages?agentId=${encodeURIComponent(agentId)}`, { fallback: "無法載入對話，請稍後重試。" });
      const data = await response.json() as Snapshot;
      if (!Array.isArray(data.messages) || typeof data.cursor !== "number") throw new Error("無法讀取對話資料。");
      if (!alive.current || requestedRevision !== revision.current || data.cursor < cursor.current) return;
      setMessages(data.messages);
      cursor.current = Math.max(cursor.current, data.cursor);
      setActiveRun(data.activeRun);
      setRestoring(false);
      if (!data.activeRun || data.activeRun.status === "waiting") setReconnecting(false);
      if (data.activeRun && ["running", "pending"].includes(data.activeRun.status) && !source.current) watch.current();
      if ((!data.activeRun || data.activeRun.status === "waiting") && source.current) { source.current.close(); source.current = null; }
    } catch (failure) {
      if (alive.current && requestedRevision === revision.current) { setError(failure instanceof Error ? failure.message : "無法載入對話。"); setRestoring(false); }
    } finally { refreshing.current = false; }
  }, [base, agentId]);

  useEffect(() => {
    alive.current = true;
    cursor.current = 0;
    setMessages([]);
    setActiveRun(undefined);
    setRestoring(true);
    setError(null);
    watch.current = () => {
      if (!alive.current || source.current) return;
      const stream = new EventSource(`${base}/events?after=${cursor.current}`, { withCredentials: true });
      source.current = stream;
      stream.onopen = () => { if (alive.current) setReconnecting(false); };
      stream.onerror = () => { if (alive.current && source.current === stream) setReconnecting(true); };
      stream.onmessage = (received) => {
        if (!alive.current || source.current !== stream) return;
        try {
          const event = JSON.parse(received.data) as Event;
          const seq = typeof event.seq === "number" ? event.seq : Number(received.lastEventId);
          if (Number.isFinite(seq) && seq > 0) {
            if (seq <= cursor.current) return;
            cursor.current = seq;
          }
          setMessages((rows) => receive(rows, event));
          if (event.type === "RUN_STARTED") { revision.current++; setActiveRun({ id: String(event.runId), status: "running" }); }
          if (event.type === "RUN_ERROR") setError(typeof event.message === "string" ? event.message : "這次執行未完成，請重試。");
          if (event.type === "RUN_FINISHED" || event.type === "RUN_ERROR") {
            revision.current++; stream.close(); source.current = null; setActiveRun(undefined); setReconnecting(false); void refresh();
          }
        } catch { setError("無法讀取最新進度，正在重新載入對話。"); void refresh(); }
      };
    };
    void refresh();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 3000);
    const resumed = () => { if (document.visibilityState === "visible") { setReconnecting(false); void refresh(); } };
    window.addEventListener("online", resumed);
    document.addEventListener("visibilitychange", resumed);
    return () => {
      alive.current = false;
      window.clearInterval(timer);
      window.removeEventListener("online", resumed);
      document.removeEventListener("visibilitychange", resumed);
      source.current?.close(); source.current = null;
    };
  }, [base, refresh]);

  const submit = useCallback(async (incoming: Message[], context: { description: string; value: string }[] = [], resume?: unknown) => {
    revision.current++;
    setError(null);
    setActiveRun({ id: "starting", status: "running" });
    try {
      const response = await client(`${base}/runs`, { method: "POST", body: { agentId, messages: incoming, context, ...(resume ? { resume } : {}) }, fallback: "未能傳送訊息，請重試。" });
      const data = await response.json() as { runId: string };
      if (typeof data.runId !== "string") throw new Error("後端未能開始這次工作。");
      if (alive.current) {
        setActiveRun({ id: data.runId, status: "running" });
        setMessages((rows) => incoming.reduce(upsert, rows));
        watch.current();
      }
      return data.runId;
    } catch (failure) {
      if (alive.current) { setActiveRun(undefined); setError(failure instanceof Error ? failure.message : "未能傳送訊息。"); void refresh(); }
      throw failure;
    }
  }, [base, agentId, refresh]);
  const stop = useCallback(async () => {
    if (!activeRun || activeRun.id === "starting") return;
    try {
      await client(`${base}/runs/${encodeURIComponent(activeRun.id)}/stop`, { method: "POST", fallback: "無法停止工作，請重試。" });
      await refresh();
    } catch (failure) { if (alive.current) setError(failure instanceof Error ? failure.message : "無法停止工作。"); }
  }, [activeRun, base, refresh]);
  const answer = useCallback(async (toolCallId: string, result: unknown) => {
    await submit([{ id: newId(), role: "tool", toolCallId, content: typeof result === "string" ? result : JSON.stringify(result) }]);
  }, [submit]);
  return { messages, messagesRef, activeRun, busy: activeRun !== undefined, restoring, reconnecting, error, submit, stop, answer, refresh };
}
