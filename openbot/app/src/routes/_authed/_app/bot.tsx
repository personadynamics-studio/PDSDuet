import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { BotSelector } from "@/components/agents/bot-selector";
import { useSelectedBot } from "@/lib/agents/selected-bot";
import { agentQueryOptions } from "@/lib/agents/queries";
import { searchTextEntry } from "@/lib/search-text";

/** Existing Bot links select the same current Bot used by the main Chat. */
export const Route = createFileRoute("/_authed/_app/bot")({
  validateSearch: (search: Record<string, unknown>): { agent?: string } => searchTextEntry("agent", search.agent),
  component: BotLink,
});
function BotLink() {
  const { agent } = Route.useSearch();
  const { bot, selectBot, loading } = useSelectedBot();
  const navigate = Route.useNavigate();
  const profile = useQuery({ ...agentQueryOptions(agent ?? ""), enabled: Boolean(agent) });
  const chosen = agent ? profile.data : bot;
  useEffect(() => {
    if (!chosen) return;
    selectBot(chosen.id);
    void navigate({ to: "/", replace: true });
  }, [chosen?.id, navigate, selectBot]);
  if (agent ? profile.isPending : loading) return <p role="status" className="p-6">正在載入機械人…</p>;
  return <div className="p-6"><BotSelector />{agent && !chosen ? <p role="alert" className="mt-4">無法開啟「{agent}」，它可能已刪除或未與你共用。</p> : null}</div>;
}
