import { useQuery } from "@tanstack/react-query";
import { useCallback, useSyncExternalStore } from "react";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { agentListQueryOptions } from "./queries";

const CHANGED = "pdsduet:selected-bot";

function subscribe(listener: () => void) {
  window.addEventListener("storage", listener);
  window.addEventListener(CHANGED, listener);
  return () => {
    window.removeEventListener("storage", listener);
    window.removeEventListener(CHANGED, listener);
  };
}

/** The Bot this person explicitly selected, shared by the workspace screens. */
export function useSelectedBot() {
  const person = useQuery(currentUserQueryOptions());
  const agents = useQuery(agentListQueryOptions());
  const key = person.data ? `pdsduet:selected-bot:${person.data.id}` : null;
  const selectedId = useSyncExternalStore(subscribe, () => {
    if (!key) return null;
    try { return window.localStorage.getItem(key); } catch { return null; }
  }, () => null);
  const selectBot = useCallback((id: string) => {
    if (!key) return;
    if (id) window.localStorage.setItem(key, id);
    else window.localStorage.removeItem(key);
    window.dispatchEvent(new Event(CHANGED));
  }, [key]);
  return {
    bot: agents.data?.find((agent) => agent.id === selectedId),
    agents,
    selectBot,
    loading: person.isPending || agents.isPending,
    error: (person.data ? null : person.error) ?? (agents.data ? null : agents.error),
  };
}
