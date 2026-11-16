import { useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { useChannelEvents } from "@/lib/channels/use-channel-events";
import { useSelectedBot } from "@/lib/agents/selected-bot";
import { agentQueryOptions } from "@/lib/agents/queries";
import { useConversationSession } from "@/lib/chat/active-bot";
import { ChatWorkspace } from "./chat-workspace";
import { PageHeader, ShellHeader } from "./header";
import { MenuSheet } from "./menu-sheet";
import { PageChromeProvider } from "./page-chrome";

/** Navigation and the selected Bot's browser stay available throughout the shell. */
export function AppShell({ children }: { children: ReactNode }) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const { bot } = useSelectedBot();
  const session = useConversationSession();
  const waiting = session?.activeRun?.waiting?.find((item) => item.metadata?.kind === "computer_handoff" || item.metadata?.kind === "computer_secret");
  const requestedBot = typeof waiting?.metadata?.botId === "string" ? waiting.metadata.botId : undefined;
  const [menuOpen, setMenuOpen] = useState(false);
  useChannelEvents();
  const mainChat = pathname === "/";
  const conversation = mainChat || pathname === "/bot" || /^\/(channels?|group)\/[^/]+$/.test(pathname) && pathname !== "/channel/new" && pathname !== "/group/new";
  const computerId = conversation
    ? requestedBot ?? session?.botId ?? (mainChat ? bot?.id : undefined)
    : bot?.id;
  const profile = useQuery({ ...agentQueryOptions(computerId ?? ""), enabled: Boolean(computerId) });
  const computer = profile.data?.canControlComputer ? profile.data : undefined;
  const computerHint = !computerId ? "請先選擇機械人。"
    : profile.isPending ? "正在載入電腦入口…"
    : profile.error ? "無法載入這個機械人的電腦入口。"
    : !computer ? "這個機械人未向你開放電腦畫面。"
    : computer.name;
  const layout = (computerAction?: ReactNode, onOpenComputer?: () => void) => <>
    {conversation ? (
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <ShellHeader floating={mainChat} menuOpen={menuOpen} onMenu={() => setMenuOpen(true)} computerAction={computerAction} />
        <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">{children}</main>
      </div>
    ) : (
      <PageChromeProvider>
        <div className="relative flex min-h-0 flex-1 flex-col">
          <PageHeader menuOpen={menuOpen} onMenu={() => setMenuOpen(true)} computerAction={computerAction} />
          <main className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</main>
        </div>
      </PageChromeProvider>
    )}
    <MenuSheet open={menuOpen} onOpenChange={setMenuOpen} onOpenComputer={onOpenComputer} computerHint={computerHint} />
  </>;
  return (
    <div className="duet-touch flex h-dvh min-h-0 min-w-0 flex-col overflow-hidden bg-duet-surface text-duet-ink">
      <ChatWorkspace bot={computer} initiallyOpen={conversation} requestedCallId={conversation ? waiting?.toolCallId : undefined}>{layout}</ChatWorkspace>
    </div>
  );
}

