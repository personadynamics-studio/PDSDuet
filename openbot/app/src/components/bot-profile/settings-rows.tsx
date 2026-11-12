import {
  IconBrain,
  IconChecks,
  IconChevronRight,
  IconDeviceMobile,
  IconTargetArrow,
  IconClock,
  IconPuzzle,
  IconSettings,
  IconUsersGroup,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Fragment } from "react";
import { PageRows, PageSection } from "@/components/layout/page-shell";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import {
  accessSummary,
  countLabel,
  memorySummary,
  reachSummary,
  setupSummary,
  sharingSummary,
} from "@/lib/agents/bot-summaries";
import type { AgentProfile } from "@/lib/agents/queries";
import { approvalInboxOptions, ruleCoversBot } from "@/lib/approvals";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { deliveryQueryOptions } from "@/lib/delivery";
import { memorySourcesQueryOptions } from "@/lib/memory";
import { proactiveSettingsQueryOptions } from "@/lib/proactive";
import { responsibilitiesQueryOptions } from "@/lib/responsibilities";
import { agentPluginsQueryOptions } from "@/lib/plugins/queries";
import { routinesQueryOptions } from "@/lib/routines/queries";
import { teamBotsQueryOptions } from "@/lib/team-bots";
import { connectorCount } from "./access";

type Row = {
  to:
    | "/bots/$agentId/responsibilities"
    | "/bots/$agentId/reach"
    | "/bots/$agentId/memory"
    | "/bots/$agentId/approvals"
    | "/bots/$agentId/routines"
    | "/bots/$agentId/access"
    | "/bots/$agentId/sharing"
    | "/bots/$agentId/setup";
  title: string;
  icon: typeof IconClock;
  summary: string;
};

/**
 * One row per area of this Bot's configuration, each stating its current answer and opening the page
 * that changes it. Sharing is for its owner, administrators, and anyone it is published to.
 */
export function BotSettingsRows({ agent }: { agent: AgentProfile }) {
  const me = useQuery(currentUserQueryOptions()).data;
  const routines = useQuery(routinesQueryOptions());
  const plugins = useQuery(agentPluginsQueryOptions(agent.id));
  const teamBots = useQuery(teamBotsQueryOptions());
  const published = teamBots.data?.teamBots.find((bot) => bot.id === agent.id);
  // Its owner and administrators change it there; anyone it is published to finds its link there.
  const canShare =
    agent.mine || me?.role === "admin" || published !== undefined;

  const goals = useQuery(responsibilitiesQueryOptions());
  const reach = useQuery(deliveryQueryOptions());
  const sources = useQuery(memorySourcesQueryOptions());
  const research = useQuery(proactiveSettingsQueryOptions());
  const approvals = useQuery(approvalInboxOptions());

  const rows: Row[] = [
    {
      to: "/bots/$agentId/responsibilities",
      title: "職責",
      icon: IconTargetArrow,
      summary: goals.data
        ? countLabel(
            goals.data.filter(
              (goal) => goal.agentId === agent.id && goal.status === "active",
            ).length,
            "項啟用中",
            "項啟用中",
            "尚未啟用職責",
          )
        : "",
    },
    {
      to: "/bots/$agentId/reach",
      title: "聯絡方式",
      icon: IconDeviceMobile,
      summary: reach.data
        ? reachSummary(
            reach.data.bindings
              .filter(
                (binding) => binding.enabled && binding.agentId === agent.id,
              )
              .map((binding) => binding.transport),
          )
        : "",
    },
    {
      to: "/bots/$agentId/memory",
      title: "記憶",
      icon: IconBrain,
      summary:
        sources.data && research.data
          ? memorySummary(
              sources.data.filter((source) => source.agentId === agent.id)
                .length,
              research.data.some(
                (setting) => setting.agentId === agent.id && setting.enabled,
              ),
            )
          : "",
    },
    {
      to: "/bots/$agentId/approvals",
      title: "審批規則",
      icon: IconChecks,
      summary: approvals.data
        ? countLabel(
            approvals.data.rules.filter(
              (rule) =>
                rule.botId !== "*" && ruleCoversBot(rule.botId, agent.id),
            ).length,
            "項規則",
            "項規則",
            "尚未設定規則",
          )
        : "",
    },
    {
      to: "/bots/$agentId/routines",
      title: "例行工作",
      icon: IconClock,
      summary: routines.data
        ? countLabel(
            routines.data.routines.filter((row) => row.agentId === agent.id)
              .length,
            "項例行工作",
            "項例行工作",
            "尚未設定例行工作",
          )
        : "",
    },
    {
      to: "/bots/$agentId/access",
      title: "技能與權限",
      icon: IconPuzzle,
      summary: plugins.data
        ? accessSummary(
            plugins.data.skills.length,
            connectorCount(plugins.data),
          )
        : "",
    },
    ...(canShare
      ? [
          {
            to: "/bots/$agentId/sharing" as const,
            title: "共用",
            icon: IconUsersGroup,
            summary: teamBots.data
              ? sharingSummary(published, agent.visibility)
              : "",
          },
        ]
      : []),
    {
      to: "/bots/$agentId/setup",
      title: "初始設定",
      icon: IconSettings,
      summary: setupSummary(agent),
    },
  ];

  return (
    <PageSection title="這個機械人的設定">
      <PageRows>
        {rows.map(({ to, title, icon: Icon, summary }, index) => (
          <Fragment key={to}>
            {index > 0 ? <Separator /> : null}
            <Item
              render={<Link params={{ agentId: agent.id }} to={to} />}
              size="sm"
            >
              <ItemMedia variant="icon">
                <Icon />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{title}</ItemTitle>
                <ItemDescription>{summary}</ItemDescription>
              </ItemContent>
              <ItemActions>
                <IconChevronRight className="size-4 text-muted-foreground" />
              </ItemActions>
            </Item>
          </Fragment>
        ))}
      </PageRows>
    </PageSection>
  );
}
