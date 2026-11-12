import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Fragment } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import { Separator } from "@/components/ui/separator";
import {
  approvalInboxOptions,
  createApprovalRuleMutationOptions,
  revokeApprovalRuleMutationOptions,
  ruleCoversBot,
  updateApprovalRuleMutationOptions,
} from "@/lib/approvals";
import { queryClient } from "@/query-client";
import { RuleForm, RuleRow } from "./rules";

/**
 * The person's approval rules for one Bot, and the team rules that reach it, locked, as one card of
 * rows ending in the row that adds one. Rules for every Bot are in Settings → Approvals. A rule's
 * `botId` is the Bot's id, or a pattern covering it.
 */
export function BotApprovalRules({ agentId }: { agentId: string }) {
  const inbox = useQuery(approvalInboxOptions());
  const addRule = useMutation(createApprovalRuleMutationOptions(queryClient));
  const changeRule = useMutation(
    updateApprovalRuleMutationOptions(queryClient),
  );
  const revoke = useMutation(revokeApprovalRuleMutationOptions(queryClient));
  const error = inbox.error ?? changeRule.error ?? revoke.error;
  if (inbox.isPending && !error) return null;
  const rulesOff = inbox.data?.team?.customRulesEnabled === false;
  // Rules naming this Bot, including a pattern that covers it; rules for every Bot are in Settings.
  const mine = (inbox.data?.rules ?? []).filter(
    (rule) => rule.botId !== "*" && ruleCoversBot(rule.botId, agentId),
  );
  const team = (inbox.data?.teamRules ?? []).filter(
    (rule) => rule.botId === "*" || rule.botId === agentId,
  );
  const canAdd = Boolean(inbox.data?.preferences) && !rulesOff;
  const saved = team.length + mine.length;

  return (
    <PageSection
      description={
        <>
          會採用最嚴格的相符規則，「詢問」優先於「允許」。適用於所有機械人的規則可在此設定：{" "}
          <Link
            className="underline underline-offset-4"
            to="/settings/approvals"
          >
            設定 → 審批
          </Link>
          .
          {rulesOff
            ? "管理員已關閉個人規則，你的規則會保留，但暫不生效。"
            : ""}
        </>
      }
      title="規則"
    >
      {error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {error.message}
        </p>
      ) : null}
      {saved === 0 ? <PageEmpty>尚未為這個機械人設定規則。</PageEmpty> : null}
      {saved > 0 || canAdd ? (
        <PageRows>
          {team.map((rule, index) => (
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
          {mine.map((rule, index) => (
            <Fragment key={rule.id}>
              {team.length + index > 0 ? <Separator /> : null}
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
              <RuleForm
                botField={false}
                forBot={agentId}
                label="新增規則"
                save={addRule}
              />
            </>
          ) : null}
        </PageRows>
      ) : null}
    </PageSection>
  );
}
