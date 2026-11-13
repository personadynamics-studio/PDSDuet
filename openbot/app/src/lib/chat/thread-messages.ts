import type { Message } from "@ag-ui/core";
import { client } from "@/lib/client";
export type StoredThread = { messages: Message[]; unreadable: number; availability: "ready" | "unavailable" };
export async function readThreadMessages(threadId: string, agentId: string): Promise<StoredThread> {
  try {
    const response = await client(`/api/threads/${encodeURIComponent(threadId)}/messages?agentId=${encodeURIComponent(agentId)}`, { fallback: "無法載入對話。" });
    const data = await response.json() as { messages: Message[] };
    if (!Array.isArray(data.messages)) throw new Error("無法讀取對話資料。");
    return { messages: data.messages, unreadable: 0, availability: "ready" };
  } catch { return { messages: [], unreadable: 0, availability: "unavailable" }; }
}
