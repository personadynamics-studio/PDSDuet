import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import { PageSection } from "@/components/layout/page-shell";
import { SharedAppNotice } from "@/components/plugins/shared-app-notice";
import { Button } from "@/components/ui/button";
import type { AgentProfile } from "@/lib/agents/queries";
import { useSelectedBot } from "@/lib/agents/selected-bot";

export function BotProfile({ agent, settings, manage }: { agent: AgentProfile; settings?: ReactNode; manage?: ReactNode }) {
  const { selectBot } = useSelectedBot();
  return <>
    <div className="mt-6 flex items-center gap-3">
      <AbstractAvatar id={agent.id} name={agent.name} seed={agent.avatarSeed} size={40} />
      <div className="min-w-0"><p className="truncate font-medium">{agent.title}</p><p className="text-sm text-muted-foreground">{agent.roleDescription}</p></div>
    </div>
    <PageSection title="對話與權限">
      <Button render={<Link to="/" onClick={() => selectBot(agent.id)} />}>傳送訊息給 {agent.name}</Button>
      <SharedAppNotice botId={agent.id} reason="publish" />
    </PageSection>
    {settings}{manage}
  </>;
}
