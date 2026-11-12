import { createFileRoute } from "@tanstack/react-router";
import { PageShell } from "@/components/layout/page-shell";
import { NativeDevices, RecentDeliveries } from "@/components/settings/devices";
import { UpdateRoutingSection } from "@/components/settings/update-routing";

export const Route = createFileRoute("/_authed/settings/notifications")({
  component: NotificationsPage,
});

/** Where your Bots' updates reach you, for all of your Bots at once. Each Bot's own page says how much. */
function NotificationsPage() {
  return (
    <PageShell
      description="設定你離開時接收機械人通知的方式。各機械人的通知頻率可在其頁面設定。"
      title="通知"
    >
      <UpdateRoutingSection />
      <NativeDevices />
      <RecentDeliveries />
    </PageShell>
  );
}
