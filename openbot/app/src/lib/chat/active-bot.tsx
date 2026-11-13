import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";

type ActiveBot = { botId: string | undefined; select: (id: string | undefined) => void };
const ActiveBotContext = createContext<ActiveBot | null>(null);

/** The real Bot driving the mounted conversation; absence is not a placeholder Bot. */
export function ActiveBotProvider({ children }: { children: ReactNode }) {
  const [botId, select] = useState<string>();
  const value = useMemo(() => ({ botId, select }), [botId]);
  return <ActiveBotContext.Provider value={value}>{children}</ActiveBotContext.Provider>;
}

export function useActiveBot(botId: string | undefined): void {
  const select = useContext(ActiveBotContext)?.select;
  useEffect(() => {
    select?.(botId);
    return () => select?.(undefined);
  }, [botId, select]);
}

export function useActiveBotId(): string | undefined {
  return useContext(ActiveBotContext)?.botId;
}
