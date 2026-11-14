import { createFileRoute } from "@tanstack/react-router";
import { SharedUseRequests } from "@/components/approvals/shared-use-requests";
import { PageShell } from "@/components/layout/page-shell";

export const Route = createFileRoute("/_authed/admin/approvals")({
  component: () => <PageShell title="共用帳戶申請" description="處理機械人使用團隊共用帳戶的授權申請。"><SharedUseRequests /></PageShell>,
});
