import { Link } from "@tanstack/react-router";
import { IconChevronRight } from "@tabler/icons-react";
import { PageSection } from "@/components/layout/page-shell";
import type { AgentProfile } from "@/lib/agents/queries";

const SECTIONS = [
  ["技能與權限", "/bots/$agentId/access"],
  ["記憶", "/bots/$agentId/memory"],
  ["共用", "/bots/$agentId/sharing"],
  ["設定", "/bots/$agentId/setup"],
] as const;

export function BotSettingsRows({ agent }: { agent: AgentProfile }) {
  return <PageSection title="機械人設定"><ul className="divide-y">{SECTIONS.map(([label, to]) => <li key={to}><Link className="flex min-h-12 items-center justify-between gap-3 rounded-lg px-3 py-2 hover:bg-muted" to={to} params={{ agentId: agent.id }}><span>{label}</span><IconChevronRight className="size-4" /></Link></li>)}</ul></PageSection>;
}

