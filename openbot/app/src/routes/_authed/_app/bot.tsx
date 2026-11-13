import { IconPlus } from "@tabler/icons-react";
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ChannelChat } from "@/components/channels/channel-chat";
import { ConversationView } from "@/components/channels/conversation-view";
import { stashFirstMessage } from "@/components/channels/transcript-messages";
import { createChannelMutationOptions } from "@/lib/channels/mutations";
import { ongoingChannel } from "@/lib/channels/ongoing";
import { type AgentChannel, channelListQueryOptions } from "@/lib/channels/queries";
import { queryClient } from "@/query-client";
import { createFileRoute } from "@tanstack/react-router";
import { ComputerChatControls } from "@/components/computer/computer-controls";
import { ComputerViewPanel } from "@/components/computer/computer-panel";
import { DetailPanel } from "@/components/layout/detail-panel";
import { SidebarToggleBar } from "@/components/layout/sidebar-toggle";
import { Button } from "@/components/ui/button";
import { defaultAgentId } from "@/lib/agents/default-agent";
import {
  type AgentProfile,
  agentKeys,
  agentListQueryOptions,
} from "@/lib/agents/queries";
import { tryClient } from "@/lib/client";
import { searchTextEntry } from "@/lib/search-text";

export const Route = createFileRoute("/_authed/_app/bot")({
  component: RouteComponent,
  /*
   * `?agent=` is read as text whatever the router parsed it into (`searchText`), because search
   * values are JSON-parsed and a Bot id made of digits would otherwise arrive as a number and open
   * this deployment's default Bot rather than the named one. `?watch=` is a flag and is read as the
   * boolean it is parsed into: anything else is not the flag being set.
   */
  validateSearch: (
    search: Record<string, unknown>,
  ): { agent?: string; watch?: boolean } => ({
    ...searchTextEntry("agent", search.agent),
    ...(search.watch === true ? { watch: true } : {}),
  }),
});

/**
 * Which Bot this screen is for.
 *
 * WHATEVER THIS DEPLOYMENT ACTUALLY HAS. The default used to be a hardcoded `risk-analyst`, a name
 * from a tenant package this one is not: on a clone that ships anything else, opening this screen
 * without naming a Bot took the whole page down to an unstyled error boundary, because the chat
 * throws when asked for an agent the runtime never synced. OpenBot exists to be forked, so a Bot
 * name written into a route is a defect on every fork but the one it came from.
 *
 * A named Bot that this deployment does not have is answered in a sentence rather than thrown,
 * for the same reason: a mistyped link is not a crash.
 */
type BotDetailLookup =
  | { bot: AgentProfile; status: "found" }
  | { status: "missing" };

function isAgentEnvelope(body: unknown): body is { agent: AgentProfile } {
  if (body === null || typeof body !== "object") return false;
  const agent = (body as { agent?: unknown }).agent;
  return (
    agent !== null &&
    typeof agent === "object" &&
    typeof (agent as { id?: unknown }).id === "string" &&
    typeof (agent as { name?: unknown }).name === "string"
  );
}

async function loadExplicitBot(agentId: string): Promise<BotDetailLookup> {
  const response = await tryClient(
    `/api/agents/${encodeURIComponent(agentId)}`,
  );
  if (response.status === 404) return { status: "missing" };
  if (!response.ok) throw new Error("Couldn't load this Bot.");

  const body: unknown = await response.json().catch(() => null);
  if (!isAgentEnvelope(body)) throw new Error("Couldn't load this Bot.");
  return { bot: body.agent, status: "found" };
}

function RouteComponent() {
  const search = Route.useSearch();
  const agent = search.agent === "" ? undefined : search.agent;
  const {
    data: agents,
    isError,
    isPending,
  } = useQuery(agentListQueryOptions());
  const agentId = agent ?? defaultAgentId(agents);
  const listedBot = agents?.find((candidate) => candidate.id === agentId);
  const detailAgentId = agent ?? "";
  const shouldLoadExplicitBot =
    Boolean(agent) && agents !== undefined && listedBot === undefined;
  const {
    data: detail,
    isError: isDetailError,
    isPending: isDetailPending,
  } = useQuery({
    enabled: shouldLoadExplicitBot,
    queryKey: agentKeys.botRouteDetail(detailAgentId),
    queryFn: () => loadExplicitBot(detailAgentId),
    retry: false,
  });
  const bot =
    listedBot ?? (detail?.status === "found" ? detail.bot : undefined);
  const known = bot !== undefined;

  if (isPending || (shouldLoadExplicitBot && isDetailPending)) return null;
  if (isError && agents === undefined) {
    return (
      <div className="flex h-screen items-center justify-center p-6">
        <p className="text-destructive text-sm" role="alert">
          Couldn't load your Bots. Reload the page.
        </p>
      </div>
    );
  }
  if (shouldLoadExplicitBot && isDetailError) {
    return (
      <div className="flex h-screen items-center justify-center p-6">
        <p className="text-destructive text-sm" role="alert">
          Couldn't load this Bot. Reload the page.
        </p>
      </div>
    );
  }
  if (!agentId || !known) {
    return (
      <div className="flex h-screen items-center justify-center p-6">
        <p className="text-muted-foreground text-sm">
          {agent
            ? `There's no Bot called "${agent}".`
            : "There are no Bots yet."}
        </p>
      </div>
    );
  }

  /*
   * Keyed on the Bot, so the hooks below never see it change under them. They cannot be called
   * conditionally, and the guards above return before any of them run.
   */
  return <BotChat agentId={agentId} key={agentId} name={bot.name} />;
}

function BotChat({ agentId, name }: { agentId: string; name: string }) {
  const channels = useInfiniteQuery(channelListQueryOptions());
  const [started, setStarted] = useState<AgentChannel | null>(null);
  const channel = started ?? ongoingChannel(channels.data, agentId);
  const create = useMutation(createChannelMutationOptions(queryClient));
  const { watch } = Route.useSearch();
  const navigate = Route.useNavigate();
  const showComputer = (open: boolean) => navigate({ search: (previous) => ({ ...previous, watch: open ? true : undefined }) });
  const start = async (text?: string) => {
    const next = await create.mutateAsync([agentId]);
    if (text) stashFirstMessage(next.id, text);
    setStarted(next);
  };
  return (
    <DetailPanel title="電腦" open={watch === true} onClose={() => showComputer(false)} detail={<ComputerViewPanel agentId={agentId} name={name} />}>
      <div className="flex h-full min-h-0 flex-col">
        <SidebarToggleBar />
        <header className="flex items-center justify-between gap-3 border-b px-6 py-3">
          <h1 className="text-lg font-semibold">{name}</h1>
          <div className="flex gap-2"><ComputerChatControls botId={agentId} open={watch === true} onOpenChange={showComputer} /><Button onClick={() => { void start().catch(() => {}); }} disabled={create.isPending} size="sm" variant="ghost"><IconPlus />新增對話</Button></div>
        </header>
        {create.error ? <p role="alert" className="px-6 py-2 text-destructive text-sm">{create.error.message}</p> : null}
        {channel ? <ChannelChat channel={channel} runtimeAgentId={agentId} /> : <ConversationView messages={[]} restoring={channels.isPending} busy={create.isPending} disabled={channels.isPending || create.isPending} notice={channels.error?.message} placeholder={`傳送訊息給 ${name}`} onSubmit={(draft) => start(draft.text)} />}
      </div>
    </DetailPanel>
  );
}
