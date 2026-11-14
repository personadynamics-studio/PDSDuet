import type { Message } from "@ag-ui/core";
import { projectThreadEvent, type ThreadEvent, type ThreadMessage, type ThreadRun } from "@openbot/shared/thread-events";
import { useCallback, useEffect, useRef, useState } from "react";
import { client } from "@/lib/client";
import { newId } from "@/lib/new-id";

type Snapshot = { messages: ThreadMessage[]; activeRun?: ThreadRun; lastRun?: ThreadRun; cursor: number };

export function useThread(threadId: string, agentId?: string) {
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [activeRun, setActiveRun] = useState<ThreadRun>();
  const [submitting, setSubmitting] = useState(false);
  const [restoring, setRestoring] = useState(true);
  const [reconnecting, setReconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const cursor = useRef(0);
  const source = useRef<EventSource | null>(null);
  const requests = useRef<AbortController | null>(null);
  const snapshotRequest = useRef<AbortController | null>(null);
  const watch = useRef<() => void>(() => {});
  const base = `/api/threads/${encodeURIComponent(threadId)}`;

  const refresh = useCallback(async () => {
    const lifetime = requests.current;
    if (!lifetime || lifetime.signal.aborted || !navigator.onLine) return;
    snapshotRequest.current?.abort();
    const request = new AbortController();
    snapshotRequest.current = request;
    source.current?.close();
    source.current = null;
    try {
      const response = await client(`${base}/messages${agentId ? `?agentId=${encodeURIComponent(agentId)}` : ""}`, {
        signal: AbortSignal.any([lifetime.signal, request.signal]),
        fallback: "無法載入對話，請稍後重試。",
      });
      const data = await response.json() as Snapshot;
      if (request.signal.aborted || lifetime.signal.aborted) return;
      setMessages(data.messages);
      cursor.current = data.cursor;
      setActiveRun(data.activeRun);
      setError(data.lastRun?.error ?? (data.lastRun?.status === "stopped" ? "工作已停止。" : null));
      setRestoring(false);
      setReconnecting(false);
      watch.current();
    } catch (failure) {
      if (!request.signal.aborted && !lifetime.signal.aborted) {
        setError(failure instanceof Error ? failure.message : "無法載入對話。");
        setRestoring(false);
      }
    }
  }, [base, agentId]);

  useEffect(() => {
    requests.current = new AbortController();
    cursor.current = 0;
    setMessages([]);
    setActiveRun(undefined);
    setRestoring(true);
    setError(null);
    setRequestError(null);
    watch.current = () => {
      if (!requests.current || requests.current.signal.aborted || source.current || !navigator.onLine) return;
      const stream = new EventSource(`${base}/events?after=${cursor.current}`, { withCredentials: true });
      source.current = stream;
      let recovering = false;
      stream.onopen = () => {
        if (source.current !== stream) return;
        if (recovering) { recovering = false; void refresh(); }
        else setReconnecting(false);
      };
      stream.onerror = () => {
        if (source.current !== stream) return;
        recovering = true;
        setReconnecting(true);
      };
      stream.onmessage = (received) => {
        if (source.current !== stream) return;
        try {
          const event = JSON.parse(received.data) as ThreadEvent;
          const sequence = Number(received.lastEventId || event.seq);
          if (sequence <= cursor.current) return;
          cursor.current = sequence;
          setMessages((rows) => projectThreadEvent(rows, event));
          if (event.type === "RUN_STARTED") setActiveRun({ id: String(event.runId), status: "running" });
          if (event.type === "RUN_FINISHED" || event.type === "RUN_ERROR") void refresh();
        } catch {
          setError("無法讀取最新進度，正在重新載入對話。");
          void refresh();
        }
      };
    };
    const offline = () => {
      requests.current?.abort();
      source.current?.close();
      source.current = null;
      setReconnecting(true);
      setSubmitting(false);
    };
    const online = () => {
      requests.current = new AbortController();
      void refresh();
    };
    const visible = () => { if (document.visibilityState === "visible") void refresh(); };
    if (navigator.onLine) void refresh();
    else { offline(); setRestoring(false); }
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);
    document.addEventListener("visibilitychange", visible);
    return () => {
      requests.current?.abort();
      snapshotRequest.current?.abort();
      source.current?.close();
      source.current = null;
      requests.current = null;
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", online);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [base, refresh]);

  const submit = useCallback(async (incoming: Message[], context: { description: string; value: string }[] = []) => {
    const lifetime = requests.current;
    if (!lifetime || lifetime.signal.aborted || !navigator.onLine) {
      const failure = new Error("目前離線，請連線後再傳送。");
      setRequestError(failure.message);
      throw failure;
    }
    setSubmitting(true);
    setRequestError(null);
    try {
      const response = await client(`${base}/runs`, {
        method: "POST", body: { ...(agentId && incoming.some((message) => message.role === "user") ? { agentId } : {}), messages: incoming, context }, signal: lifetime.signal,
        fallback: "未能傳送訊息，請重試。",
      });
      const data = await response.json() as { runId: string };
      if (!lifetime.signal.aborted) {
        setActiveRun({ id: data.runId, status: "running" });
        await refresh();
      }
      return data.runId;
    } catch (failure) {
      if (!lifetime.signal.aborted) {
        setRequestError(failure instanceof Error ? failure.message : "未能傳送訊息。");
        void refresh();
      }
      throw failure;
    } finally { if (!lifetime.signal.aborted) setSubmitting(false); }
  }, [base, agentId, refresh]);

  const stop = useCallback(async () => {
    const lifetime = requests.current;
    if (!activeRun) return;
    if (!lifetime || lifetime.signal.aborted || !navigator.onLine) { setRequestError("目前離線，請連線後再停止工作。"); return; }
    setRequestError(null);
    try {
      await client(`${base}/runs/${encodeURIComponent(activeRun.id)}/stop`, {
        method: "POST", signal: lifetime.signal, fallback: "無法停止工作，請重試。",
      });
      await refresh();
    } catch (failure) {
      if (!lifetime.signal.aborted) setRequestError(failure instanceof Error ? failure.message : "無法停止工作。");
    }
  }, [activeRun, base, refresh]);
  const answer = useCallback(async (toolCallId: string, result: unknown) => {
    await submit([{ id: newId(), role: "tool", toolCallId, content: typeof result === "string" ? result : JSON.stringify(result) }]);
  }, [submit]);
  return { messages, messagesRef, activeRun, busy: submitting || activeRun !== undefined, restoring, reconnecting, error: requestError ?? error, submit, stop, answer, refresh };
}
