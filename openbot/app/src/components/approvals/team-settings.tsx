import { IconEyeCheck, IconTerminal2, IconUserCog } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
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
  createTeamApprovalRuleMutationOptions,
  revokeTeamApprovalRuleMutationOptions,
  teamApprovalSettingsMutationOptions,
  updateTeamApprovalRuleMutationOptions,
} from "@/lib/approvals";
import { queryClient } from "@/query-client";
import { HOST_LABELS, LabelSelect, RuleForm, RuleRow } from "./rules";
import { SharedUseRequests } from "./shared-use-requests";

/**
 * What every member's Bots must do, set by an administrator: the team-wide controls, the rules that
 * apply to everyone, and requests to use a shared account. Members read the team rules, locked, in
 * Settings → Approvals.
 */
export function TeamApprovalSettings() {
  const inbox = useQuery(approvalInboxOptions());
  const team = useMutation(teamApprovalSettingsMutationOptions(queryClient));
  const addTeamRule = useMutation(
    createTeamApprovalRuleMutationOptions(queryClient),
  );
  const changeTeamRule = useMutation(
    updateTeamApprovalRuleMutationOptions(queryClient),
  );
  const revokeTeam = useMutation(
    revokeTeamApprovalRuleMutationOptions(queryClient),
  );
  const error =
    inbox.error ?? team.error ?? changeTeamRule.error ?? revokeTeam.error;
  if (inbox.isPending && !error) return null;
  const settings = inbox.data?.team;
  const teamRules = inbox.data?.teamRules ?? [];

  return (
    <>
      {error ? (
        <p className="mt-6 text-destructive text-sm" role="alert">
          {error.message}
        </p>
      ) : null}
      {settings ? (
        <PageSection title="團隊設定">
          <PageRows>
            <Item size="sm">
              <ItemMedia variant="icon">
                <IconEyeCheck />
              </ItemMedia>
              <ItemContent>
                <ItemTitle id="enforce-auto-review-title">
                  要求所有成員使用自動審查
                </ItemTitle>
              </ItemContent>
              <ItemActions>
                <Switch
                  aria-labelledby="enforce-auto-review-title"
                  checked={settings.enforceAutoReview}
                  disabled={team.isPending}
                  onCheckedChange={(enforceAutoReview) =>
                    team.mutate({ enforceAutoReview })
                  }
                />
              </ItemActions>
            </Item>
            <Separator />
            <Item size="sm">
              <ItemMedia variant="icon">
                <IconUserCog />
              </ItemMedia>
              <ItemContent>
                <ItemTitle id="custom-rules-title">
                  允許成員設定個人規則
                </ItemTitle>
              </ItemContent>
              <ItemActions>
                <Switch
                  aria-labelledby="custom-rules-title"
                  checked={settings.customRulesEnabled}
                  disabled={team.isPending}
                  onCheckedChange={(customRulesEnabled) =>
                    team.mutate({ customRulesEnabled })
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
                <ItemTitle>成員電腦指令的最高權限</ItemTitle>
                <ItemDescription>
                  成員自行設定的更嚴格限制仍然適用。
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <LabelSelect
                  disabled={team.isPending}
                  label="成員電腦指令的最高權限"
                  labels={HOST_LABELS}
                  onChange={(hostCommandsCap) =>
                    team.mutate({ hostCommandsCap })
                  }
                  value={settings.hostCommandsCap}
                />
              </ItemActions>
            </Item>
          </PageRows>
        </PageSection>
      ) : null}
      <PageSection
        description="適用於所有成員的機械人，成員無法修改。"
        title="團隊規則"
      >
        {teamRules.length === 0 ? <PageEmpty>尚未設定團隊規則。</PageEmpty> : null}
        <PageRows>
          {teamRules.map((rule) => (
            <Fragment key={rule.id}>
              <RuleRow
                disabled={revokeTeam.isPending || changeTeamRule.isPending}
                onChange={(behaviour) =>
                  changeTeamRule.mutate({ id: rule.id, behaviour })
                }
                onRevoke={() => revokeTeam.mutate(rule.id)}
                rule={rule}
                team
              />
              <Separator />
            </Fragment>
          ))}
          <RuleForm label="新增團隊規則" save={addTeamRule} />
        </PageRows>
      </PageSection>
      <SharedUseRequests />
    </>
  );
}
