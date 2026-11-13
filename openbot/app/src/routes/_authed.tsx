import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { currentUserQueryOptions } from "../lib/auth/queries";
import { ChatProvider } from "../lib/chat/provider";
import { AppHotkeys } from "../lib/hotkeys/app-hotkeys";

export const Route = createFileRoute("/_authed")({
  beforeLoad: async ({ context }) => {
    const user = await context.queryClient.ensureQueryData(
      currentUserQueryOptions(),
    );
    if (!user) {
      throw redirect({ to: "/sign" });
    }

  },
  // Mounted INSIDE the authed boundary, not at the root: the runtime endpoint requires a session, so
  // a provider above the sign-in gate would open a run for a visitor who has not signed in yet.
  component: () => (
    <ChatProvider>
      <AppHotkeys />
      <Outlet />
    </ChatProvider>
  ),
});
