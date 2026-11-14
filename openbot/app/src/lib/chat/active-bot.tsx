import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import type { ThreadMessage, ThreadRun } from "@openbot/shared/thread-events";

type ConversationSession = {
  threadId: string;
  botId?: string;
  messages: readonly ThreadMessage[];
  activeRun?: ThreadRun;
  answer(toolCallId: string, value: unknown): Promise<void>;
};
type Current = { session: ConversationSession | null; publish(session: ConversationSession | null): void };
const ActiveBotContext = createContext<Current | null>(null);

export function ActiveBotProvider({ children }: { children: ReactNode }) {
  const [session, publish] = useState<ConversationSession | null>(null);
  const value = useMemo(() => ({ session, publish }), [session]);
  return <ActiveBotContext.Provider value={value}>{children}</ActiveBotContext.Provider>;
}

/** The mounted conversation shares its real waiting tool with its browser controls. */
export function useActiveConversation(session: ConversationSession): void {
  const publish = useContext(ActiveBotContext)?.publish;
  const value = useMemo(() => session, [session.threadId, session.botId, session.messages, session.activeRun, session.answer]);
  useEffect(() => { publish?.(value); }, [value, publish]);
  useEffect(() => () => publish?.(null), [publish]);
}
export function useConversationSession() {
  return useContext(ActiveBotContext)?.session ?? null;
}
export function useActiveBotId(): string | undefined {
  return useConversationSession()?.botId;
}

