import { IconChevronRight } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Fragment, useState } from "react";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import {
  attentionSummary,
  needsInput,
} from "@/components/bot-profile/attention";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { type AgentProfile, agentListQueryOptions } from "@/lib/agents/queries";
import { groupRoster } from "@/lib/agents/roster";
import {
  type BotAttention,
  botAttentionQueryOptions,
} from "@/lib/bot-lifecycle/queries";

/**
 * Every Bot the person can reach, in the one place they are listed: pinned first, then their own,
 * then the ones shared with them, and the ones they hid folded away at the end.
 *
 * This replaces three screens — Bots, Agents and Team Bots — that listed the same Bots three ways.
 */
export function BotRoster() {
  const agents = useQuery(agentListQueryOptions());
  const hidden = useQuery(agentListQueryOptions(true));
  const attention = useQuery(botAttentionQueryOptions());
  const byId = new Map((attention.data ?? []).map((bot) => [bot.agentId, bot]));

  if (agents.isPending) return null;
  // Only when nothing ever loaded: a failed background refetch keeps the roster it had.
  if (agents.data === undefined) {
    return (
      <p className="mt-6 text-destructive text-sm" role="alert">
        無法載入你的機械人，請重新整理頁面。
      </p>
    );
  }
  const { needsYou, pinned, yours, shared } = groupRoster(
    agents.data,
    (agentId) => {
      const state = byId.get(agentId);
      return state ? needsInput(state) : 0;
    },
  );
  const yoursPinned = pinned.some((agent) => agent.mine);
  const yoursWaiting = needsYou.some((agent) => agent.mine);

  return (
    <>
      {needsYou.length ? (
        <PageSection title="等待你處理">
          <RosterRows agents={needsYou} byId={byId} />
        </PageSection>
      ) : null}
      {pinned.length ? (
        <PageSection title="已置頂">
          <RosterRows agents={pinned} byId={byId} />
        </PageSection>
      ) : null}
      <PageSection title="你的機械人">
        {yours.length ? (
          <RosterRows agents={yours} byId={byId} />
        ) : (
          <PageEmpty>
            {yoursPinned
              ? "你的機械人均已置頂。"
              : yoursWaiting
                ? "你的機械人均在「等待你處理」之下。"
                : "你尚未有機械人，請按「新增機械人」建立。"}
          </PageEmpty>
        )}
      </PageSection>
      <PageSection title="與你共用">
        {shared.length ? (
          <RosterRows agents={shared} byId={byId} />
        ) : (
          <PageEmpty>暫未有人與你共用機械人。</PageEmpty>
        )}
      </PageSection>
      {hidden.data?.length ? (
        <HiddenSection agents={hidden.data} byId={byId} />
      ) : null}
    </>
  );
}

/**
 * The Bots this person hid, folded until asked for: a way back for somebody who hid something, not
 * a fourth list everybody reads past. A Bot's page is where Unhide lives.
 */
function HiddenSection({
  agents,
  byId,
}: {
  agents: AgentProfile[];
  byId: Map<string, BotAttention>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <PageSection
      action={
        <Button onClick={() => setOpen(!open)} size="sm" variant="ghost">
          {open ? "隱藏" : "顯示"}
        </Button>
      }
      description={`你已隱藏 ${agents.length} 個機械人，只影響你的清單。`}
      title="已隱藏"
    >
      {open ? <RosterRows agents={agents} byId={byId} /> : null}
    </PageSection>
  );
}

function RosterRows({
  agents,
  byId,
}: {
  agents: AgentProfile[];
  byId: Map<string, BotAttention>;
}) {
  return (
    <PageRows>
      {agents.map((agent, index) => {
        const state = byId.get(agent.id);
        const summary = state
          ? [state.paused ? "已暫停" : "", attentionSummary(state)]
              .filter(Boolean)
              .join(" · ")
          : "";
        return (
          <Fragment key={agent.id}>
            {index > 0 ? <Separator /> : null}
            <Item
              render={
                <Link params={{ agentId: agent.id }} to="/bots/$agentId" />
              }
              size="sm"
            >
              <ItemMedia>
                <AbstractAvatar
                  id={agent.id}
                  name={agent.name}
                  seed={agent.avatarSeed}
                  size={28}
                />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{agent.name}</ItemTitle>
                <ItemDescription>{summary || agent.title}</ItemDescription>
              </ItemContent>
              <ItemActions>
                {state && needsInput(state) > 0 ? (
                  <span className="type-caption grid h-[18px] min-w-[18px] place-items-center rounded-full bg-duet-accent px-1.5 font-medium text-duet-on-accent tabular-nums">
                    {needsInput(state)}
                  </span>
                ) : null}
                <IconChevronRight className="size-4 text-muted-foreground" />
              </ItemActions>
            </Item>
          </Fragment>
        );
      })}
    </PageRows>
  );
}
