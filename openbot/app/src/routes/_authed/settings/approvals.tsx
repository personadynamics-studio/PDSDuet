import { createFileRoute } from "@tanstack/react-router";
import { ApprovalSettings } from "@/components/approvals/settings";
import { PageShell } from "@/components/layout/page-shell";
import { TeamBotConsents } from "@/components/settings/team-bot-consents";

export const Route = createFileRoute("/_authed/settings/approvals")({
  component: ApprovalsSettingsPage,
});

function ApprovalsSettingsPage() {
  return (
    <PageShell
      description="設定機械人何時須先徵求同意才可進行變更。這裏的規則適用於所有機械人。"
      // Named as the Settings row that opens it.
      title="審批規則"
    >
      <ApprovalSettings />
      <TeamBotConsents />
    </PageShell>
  );
}
