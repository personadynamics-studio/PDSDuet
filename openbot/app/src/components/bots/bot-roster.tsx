import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Fragment, useState } from "react";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import { PageEmpty, PageRows, PageSection } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { type AgentProfile, agentListQueryOptions } from "@/lib/agents/queries";
import { useSelectedBot } from "@/lib/agents/selected-bot";

export function BotRoster() {
  const agents = useQuery(agentListQueryOptions());
  const hidden = useQuery(agentListQueryOptions(true));
  const [showHidden, setShowHidden] = useState(false);
  if (agents.isPending) return <p role="status" className="mt-6">正在載入機械人…</p>;
  if (!agents.data) return <p role="alert" className="mt-6 text-destructive">{agents.error?.message}</p>;
  return <>
    <PageSection title="機械人">
      {agents.data.length ? <RosterRows agents={agents.data} /> : <PageEmpty>你尚未有機械人，請按「新增機械人」建立。</PageEmpty>}
    </PageSection>
    {hidden.data?.length ? <PageSection title="已隱藏" action={<Button variant="ghost" onClick={() => setShowHidden(!showHidden)}>{showHidden ? "收起" : "顯示"}</Button>}>{showHidden ? <RosterRows agents={hidden.data} hidden /> : null}</PageSection> : null}
  </>;
}
function RosterRows({ agents, hidden = false }: { agents: readonly AgentProfile[]; hidden?: boolean }) {
  const { selectBot } = useSelectedBot();
  return <PageRows>{agents.map((agent, index) => <Fragment key={agent.id}>
    {index ? <Separator /> : null}
    <Item size="sm">
      <ItemMedia><AbstractAvatar id={agent.id} name={agent.name} seed={agent.avatarSeed} size={28} /></ItemMedia>
      <ItemContent>
        <ItemTitle>{hidden ? agent.name : <Link to="/" onClick={() => selectBot(agent.id)} className="rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{agent.name}</Link>}</ItemTitle>
        <ItemDescription>{agent.title}</ItemDescription>
      </ItemContent>
      <ItemActions><Button variant="ghost" size="sm" render={<Link to="/bots/$agentId" params={{ agentId: agent.id }} />}>設定</Button></ItemActions>
    </Item>
  </Fragment>)}</PageRows>;
}
