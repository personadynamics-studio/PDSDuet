import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useSelectedBot } from "@/lib/agents/selected-bot";
import { channelListQueryOptions } from "@/lib/channels/queries";
import { appConfig } from "@/lib/generated/application-config";
import { cn } from "@/lib/utils";

const ROW = "flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-duet-tile focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-duet-accent";

/** Bot choice and ordinary conversation history are direct navigation. */
export function MenuSheet({ open, onOpenChange }: { open: boolean; onOpenChange(open: boolean): void }) {
  const { bot, agents, selectBot } = useSelectedBot();
  const conversations = useInfiniteQuery({ ...channelListQueryOptions(), enabled: open });
  const close = () => onOpenChange(false);
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="left" className="w-[340px] gap-0 p-0 sm:max-w-[340px]">
        <SheetHeader className="px-5 py-5">
          <SheetTitle>{appConfig.brand.productName}</SheetTitle>
          <SheetDescription>選擇機械人或繼續已有對話。</SheetDescription>
        </SheetHeader>
        <nav aria-label="選單" className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 pb-5">
          <section aria-label="機械人">
            <h2 className="px-3 py-2 text-sm font-medium text-muted-foreground">機械人</h2>
            {agents.isPending ? <p role="status" className="px-3 py-2">正在載入…</p> : agents.error && !agents.data ? <p role="alert" className="px-3 py-2 text-destructive">無法載入機械人。</p> : (agents.data ?? []).map((agent) => (
              <Link key={agent.id} to="/" aria-current={bot?.id === agent.id ? "page" : undefined} className={cn(ROW, bot?.id === agent.id && "bg-duet-tile")} onClick={() => { selectBot(agent.id); close(); }}>
                <AbstractAvatar id={agent.id} name={agent.name} size={28} /><span className="min-w-0 truncate">{agent.name}</span>
              </Link>
            ))}
            {!agents.isPending && agents.data?.length === 0 ? <p className="px-3 py-2 text-sm">尚未有機械人。</p> : null}
            <Link className={ROW} to="/bots" search={{ new: true }} onClick={close}>新增機械人</Link>
          </section>
          <section aria-label="對話">
            <h2 className="px-3 py-2 text-sm font-medium text-muted-foreground">對話</h2>
            <Link className={ROW} to="/channel/new" onClick={close}>新增對話／群聊</Link>
            {(conversations.data ?? []).map((channel) => <Link key={channel.id} className={ROW} to={channel.agentIds.length > 1 ? "/group/$channelId" : "/channel/$channelId"} params={{ channelId: channel.id }} onClick={close}><span className="truncate">{channel.summary || channel.lastMessage || channel.name}</span></Link>)}
            {conversations.error ? <p role="alert" className="px-3 py-2 text-sm text-destructive">無法載入對話。</p> : null}
            {conversations.hasNextPage ? <Button variant="ghost" disabled={conversations.isFetchingNextPage} onClick={() => { void conversations.fetchNextPage(); }}>更多對話</Button> : null}
          </section>
          <section aria-label="工具與設定" className="border-t pt-3">
            <Link className={ROW} to="/connections" onClick={close}>應用程式連接</Link>
            <Link className={ROW} to="/routines" onClick={close}>日程</Link>
            <Link className={ROW} to="/make" onClick={close}>已保存頁面</Link>
            <Link className={ROW} to="/bots" onClick={close}>管理機械人</Link>
            <Link className={ROW} to="/settings" onClick={close}>設定</Link>
          </section>
        </nav>
      </SheetContent>
    </Sheet>
  );
}

