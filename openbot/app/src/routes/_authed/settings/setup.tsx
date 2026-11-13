import {
  createFileRoute,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { PageShell } from "@/components/layout/page-shell";
import { SetupChecklist } from "@/components/onboarding/setup-checklist";

export const Route = createFileRoute("/_authed/settings/setup")({
  /*
   * `?connected=failed` is how a Gmail consent started here comes back when it did not go through
   * (`settings-setup` in `connectedAccountsUrlFor` on the server). Read once, then dropped.
   */
  validateSearch: (
    search: Record<string, unknown>,
  ): { connected?: "failed" } =>
    search.connected === "failed" ? { connected: "failed" } : {},
  component: SetupPage,
});

/** Optional setup information. */
function SetupPage() {
  const router = useRouter();
  const navigate = useNavigate();
  const search = Route.useSearch();
  const [failed] = useState(() => search.connected === "failed");
  useEffect(() => {
    if (search.connected === undefined) return;
    navigate({ to: "/settings/setup", search: {}, replace: true });
  }, [navigate, search.connected]);
  return (
    <PageShell
      description="查看已完成及尚待處理的設定。"
      title="初始設定"
    >
      <div className="mt-8">
        <SetupChecklist
          notice={
            failed
              ? "無法連接你的 Gmail 和日曆，請重試。"
              : undefined
          }
          openPage={(path) => router.history.push(path)}
          returnTo="settings-setup"
        />
      </div>
    </PageShell>
  );
}
