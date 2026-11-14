import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { BotSelector } from "@/components/agents/bot-selector";
import { useSelectedBot } from "@/lib/agents/selected-bot";
import { searchTextEntry } from "@/lib/search-text";

/** Existing Bot links select the same current Bot used by the main Chat. */
export const Route = createFileRoute("/_authed/_app/bot")({
  validateSearch: (search: Record<string, unknown>): { agent?: string } => searchTextEntry("agent", search.agent),
  component: BotLink,
});
function BotLink() {
  const { agent } = Route.useSearch();
  const { bot, agents, selectBot, loading } = useSelectedBot();
  const navigate = Route.useNavigate();
  const chosen = agent ? agents.data?.find((candidate) => candidate.id === agent) : bot;
  useEffect(() => {
    if (!chosen) return;
    selectBot(chosen.id);
    void navigate({ to: "/", replace: true });
  }, [chosen?.id, navigate, selectBot]);
  if (loading) return <p role="status" className="p-6">正在載入機械人…</p>;
  return <div className="p-6"><BotSelector />{agent && !chosen ? <p role="alert" className="mt-4">你目前的機械人清單沒有「{agent}」。</p> : null}</div>;
}
