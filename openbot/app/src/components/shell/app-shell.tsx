import { useRouterState } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { useChannelEvents } from "@/lib/channels/use-channel-events";
import { useSelectedBot } from "@/lib/agents/selected-bot";
import { useConversationSession } from "@/lib/chat/active-bot";
import { ChatWorkspace } from "./chat-workspace";
import { PageHeader, ShellHeader } from "./header";
import { MenuSheet } from "./menu-sheet";
import { PageChromeProvider } from "./page-chrome";

/** Navigation and the current conversation's browser do not depend on background jobs. */
export function AppShell({ children }: { children: ReactNode }) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const { bot, agents } = useSelectedBot();
  const session = useConversationSession();
  const waiting = session?.activeRun?.waiting?.find((item) => item.metadata?.kind === "computer_handoff" || item.metadata?.kind === "computer_secret");
  const requestedBot = typeof waiting?.metadata?.botId === "string" ? waiting.metadata.botId : undefined;
  const [menuOpen, setMenuOpen] = useState(false);
  useChannelEvents();
  const mainChat = pathname === "/";
  const conversation = mainChat || pathname === "/bot" || /^\/(channels?|group)\/[^/]+$/.test(pathname) && pathname !== "/channel/new" && pathname !== "/group/new";
  const computerId = requestedBot ?? session?.botId ?? (mainChat ? bot?.id : undefined);
  const computer = computerId ? { id: computerId, name: agents.data?.find((item) => item.id === computerId)?.name ?? computerId } : undefined;
  const layout = (computerAction?: ReactNode) => conversation ? (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <ShellHeader floating={mainChat} menuOpen={menuOpen} onMenu={() => setMenuOpen(true)} computerAction={computerAction} />
      <main className="flex min-h-0 flex-1 flex-col">{children}</main>
    </div>
  ) : (
    <PageChromeProvider>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <PageHeader computerAction={computerAction} />
        <main className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</main>
      </div>
    </PageChromeProvider>
  );
  return (
    <div className="duet-touch flex h-svh min-h-0 flex-col overflow-hidden bg-duet-surface text-duet-ink">
      {conversation ? <ChatWorkspace bot={computer} requestedCallId={waiting?.toolCallId}>{layout}</ChatWorkspace> : layout()}
      <MenuSheet open={menuOpen} onOpenChange={setMenuOpen} />
    </div>
  );
}

