import { useQuery } from "@tanstack/react-query";
import type * as React from "react";
import { PageShell } from "@/components/layout/page-shell";
import { type AgentProfile, agentQueryOptions } from "@/lib/agents/queries";

/**
 * The frame of every `/bots/$agentId/<area>` page: back to the Bot by name, then the area.
 *
 * One frame so each area page is only its own rows, and so a Bot the person cannot reach says so in
 * the same words everywhere.
 */
export function BotSubpage({
  agentId,
  title,
  description,
  children,
}: {
  agentId: string;
  title: string;
  description: string;
  children: (agent: AgentProfile) => React.ReactNode;
}) {
  const agent = useQuery(agentQueryOptions(agentId));
  return (
    <PageShell
      backButton={{
        label: agent.data?.name ?? "機械人",
        linkProps: { params: { agentId }, to: "/bots/$agentId" },
      }}
      description={description}
      title={title}
    >
      {agent.isPending ? null : agent.error ? (
        <p className="mt-6 text-destructive text-sm" role="alert">
          無法開啟這個機械人，它或未與你共用。
        </p>
      ) : (
        children(agent.data)
      )}
    </PageShell>
  );
}
