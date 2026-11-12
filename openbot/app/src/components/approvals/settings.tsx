import { IconEyeCheck, IconHandStop, IconTerminal2 } from "@tabler/icons-react";
import { appConfig } from "@/lib/generated/application-config";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Fragment } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import {
  approvalInboxOptions,
  approvalPreferencesMutationOptions,
  createApprovalRuleMutationOptions,
  revokeApprovalRuleMutationOptions,
  ruleCoversBot,
  updateApprovalRuleMutationOptions,
} from "@/lib/approvals";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { queryClient } from "@/query-client";
import { HOST_LABELS, LabelSelect, RuleForm, RuleRow } from "./rules";

/**
 * The person's own approval settings: whether their Bots ask before changing things, and the rules
 * that apply to every one of their Bots. Team rules are listed so the person can see them, locked;
 * administrators change them in Admin → Approvals. Rules for a single Bot are on 該機械人頁面設定.
 */
export function ApprovalSettings() {
  const inbox = useQuery(approvalInboxOptions());
  const me = useQuery(currentUserQueryOptions()).data;
  const agents = useQuery(agentListQueryOptions());
  const hiddenAgents = useQuery(agentListQueryOptions(true));
  const preferences = useMutation(
    approvalPreferencesMutationOptions(queryClient),
  );
  const addRule = useMutation(createApprovalRuleMutationOptions(queryClient));
  const changeRule = useMutation(
    updateApprovalRuleMutationOptions(queryClient),
  );
  const revoke = useMutation(revokeApprovalRuleMutationOptions(queryClient));
  const error =
    inbox.error ?? preferences.error ?? changeRule.error ?? revoke.error;
  if (inbox.isPending && !error) return null;
  const enforced = inbox.data?.team?.enforceAutoReview ?? false;
  const rulesOff = inbox.data?.team?.customRulesEnabled === false;
  const everyBot = (inbox.data?.rules ?? []).filter(
    (rule) => rule.botId === "*",
  );
  /*
   * Rules that name no Bot this person can open — a Bot since deleted, or a name typed where an id
   * belonged. They are still enforced, so they are listed here where they can be removed.
   */
  const reachable = [...(agents.data ?? []), ...(hiddenAgents.data ?? [])];
  const otherBots = (inbox.data?.rules ?? []).filter(
    (rule) =>
      rule.botId !== "*" &&
      (agents.data === undefined ||
        !reachable.some((agent) => ruleCoversBot(rule.botId, agent.id))),
  );
  const teamRules = inbox.data?.teamRules ?? [];
  const canAdd = Boolean(inbox.data?.preferences) && !rulesOff;
  const saved = teamRules.length + everyBot.length;

  return (
    <>
      {error ? (
        <p className="mt-6 text-destructive text-sm" role="alert">
          {error.message}
        </p>
      ) : null}
      {me?.role === "admin" ? (
        <p className="mt-6 text-muted-foreground text-sm">
          團隊設定及共用帳戶申請可在此處理：{" "}
          <Link className="underline underline-offset-4" to="/admin/approvals">
            管理員 → 審批
          </Link>
          .
        </p>
      ) : null}
      <PageSection title="機械人執行前">
        <PageRows>
          <Item size="sm">
            <ItemMedia variant="icon">
              <IconHandStop />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>變更前先詢問</ItemTitle>
              <ItemDescription>
                審閱機械人對網站、已連接應用程式及檔案的變更。
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Switch
                aria-label="變更前先詢問"
                checked={inbox.data?.enabled ?? false}
                disabled={inbox.isLoading || preferences.isPending}
                onCheckedChange={(enabled) => preferences.mutate({ enabled })}
              />
            </ItemActions>
          </Item>
          {inbox.data?.preferences ? (
            <>
              <Separator />
              <Item size="sm">
                <ItemMedia variant="icon">
                  <IconEyeCheck />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle id="auto-review-title">自動審查</ItemTitle>
                  <ItemDescription
                    className="line-clamp-none"
                    id="auto-review-description"
                  >
                    {enforced ? "管理員已要求開啟此功能。" : ""}
                    機械人執行可能影響帳戶或分享資料的操作前，{appConfig.brand.productName} 會按你的要求及規則審查。如無法判斷，就會詢問你。
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Switch
                    // Named by its title alone and described by the sentence beside it, so the name
                    // stays short however long the description grows.
                    aria-describedby="auto-review-description"
                    aria-labelledby="auto-review-title"
                    checked={enforced || inbox.data.preferences.autoReview}
                    disabled={enforced || preferences.isPending}
                    onCheckedChange={(autoReview) =>
                      preferences.mutate({ autoReview })
                    }
                  />
                </ItemActions>
              </Item>
              <Separator />
              <Item size="sm">
                <ItemMedia variant="icon">
                  <IconTerminal2 />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>你電腦上的指令</ItemTitle>
                  <ItemDescription className="line-clamp-none">
                    {inbox.data.hostCommands &&
                    inbox.data.hostCommands !==
                      inbox.data.preferences.hostCommands
                      ? `管理員將此限制為「${HOST_LABELS[inbox.data.hostCommands]}」。`
                      : ""}
                    {appConfig.brand.productName} 桌面應用程式仍會在執行前向你顯示每項指令。
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <LabelSelect
                    disabled={preferences.isPending}
                    label="你電腦上的指令"
                    labels={HOST_LABELS}
                    onChange={(hostCommands) =>
                      preferences.mutate({ hostCommands })
                    }
                    value={inbox.data.preferences.hostCommands}
                  />
                </ItemActions>
              </Item>
            </>
          ) : null}
        </PageRows>
      </PageSection>
      <PageSection
        description={
          <>
            會採用最嚴格的相符規則，「詢問」優先於「允許」。團隊規則已鎖定。密碼、安全設定及付款一律交由你處理。個別機械人的規則可在{" "}
            <Link className="underline underline-offset-4" to="/bots">
              該機械人頁面設定
            </Link>
            .
            {rulesOff
              ? "管理員已關閉個人規則，你的規則會保留，但暫不生效。"
              : ""}
          </>
        }
        title="適用於所有機械人的規則"
      >
        {saved === 0 ? <PageEmpty>尚未設定規則。</PageEmpty> : null}
        {saved > 0 || canAdd ? (
          <PageRows>
            {teamRules.map((rule, index) => (
              <Fragment key={rule.id}>
                {index > 0 ? <Separator /> : null}
                <RuleRow
                  disabled
                  locked
                  onChange={() => {}}
                  onRevoke={() => {}}
                  rule={rule}
                  team
                />
              </Fragment>
            ))}
            {everyBot.map((rule, index) => (
              <Fragment key={rule.id}>
                {teamRules.length + index > 0 ? <Separator /> : null}
                <RuleRow
                  disabled={revoke.isPending || changeRule.isPending}
                  locked={rulesOff}
                  onChange={(behaviour) =>
                    changeRule.mutate({ id: rule.id, behaviour })
                  }
                  onRevoke={() => revoke.mutate(rule.id)}
                  rule={rule}
                />
              </Fragment>
            ))}
            {canAdd ? (
              <>
                {saved > 0 ? <Separator /> : null}
                <RuleForm botField={false} label="新增規則" save={addRule} />
              </>
            ) : null}
          </PageRows>
        ) : null}
      </PageSection>
      {agents.data !== undefined && otherBots.length > 0 ? (
        <PageSection
          description="以下規則未對應至你可開啟的機械人，但仍會套用至相符的機械人。你可移除不需要的規則。"
          title="其他機械人的規則"
        >
          <PageRows>
            {otherBots.map((rule, index) => (
              <Fragment key={rule.id}>
                {index > 0 ? <Separator /> : null}
                <RuleRow
                  disabled={revoke.isPending || changeRule.isPending}
                  locked={rulesOff}
                  onChange={(behaviour) =>
                    changeRule.mutate({ id: rule.id, behaviour })
                  }
                  onRevoke={() => revoke.mutate(rule.id)}
                  rule={rule}
                />
              </Fragment>
            ))}
          </PageRows>
        </PageSection>
      ) : null}
    </>
  );
}
