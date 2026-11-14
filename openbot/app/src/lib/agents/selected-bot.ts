import { useQuery } from "@tanstack/react-query";
import { createContext, createElement, type ReactNode, useCallback, useContext, useEffect, useState } from "react";
import { agentListQueryOptions } from "./queries";

type Selection = { userId: string; selectedId: string | null; selectBot(id: string): void };
const SelectedBotContext = createContext<Selection | null>(null);

/** React owns the current choice; storage only remembers the person's preference. */
export function SelectedBotProvider({ userId, children }: { userId: string; children: ReactNode }) {
  const key = "pdsduet:selected-bot:" + userId;
  const [selectedId, setSelectedId] = useState<string | null>(() => {
    try { return userId ? window.localStorage.getItem(key) : null; } catch { return null; }
  });
  const selectBot = useCallback((id: string) => {
    setSelectedId(id || null);
    try { if (id) window.localStorage.setItem(key, id); else window.localStorage.removeItem(key); }
    catch { /* The explicit choice remains usable when persistence is unavailable. */ }
  }, [key]);
  useEffect(() => {
    const changed = (event: StorageEvent) => { if (event.key === key) setSelectedId(event.newValue); };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, [key]);
  return createElement(SelectedBotContext.Provider, { value: { userId, selectedId, selectBot } }, children);
}
export function useSelectedBot() {
  const selection = useContext(SelectedBotContext);
  if (!selection) throw new Error("Bot selection requires ChatProvider.");
  const agents = useQuery(agentListQueryOptions());
  return {
    userId: selection.userId,
    bot: agents.data?.find((agent) => agent.id === selection.selectedId),
    agents,
    selectBot: selection.selectBot,
    loading: agents.isPending,
    error: agents.data ? null : agents.error,
  };
}

