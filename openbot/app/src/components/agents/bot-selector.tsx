import { useSelectedBot } from "@/lib/agents/selected-bot";
import { useState } from "react";
import { NewBotSheet } from "./new-bot-sheet";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";

export function BotSelector() {
  const { bot, agents, selectBot, loading, error } = useSelectedBot();
  const [dismissed, setDismissed] = useState(false);
  const [creating, setCreating] = useState(false);
  return (
    <><div className="flex min-w-0 items-center gap-3 text-sm">
      <span className="shrink-0">對話機械人</span>
      <select
        aria-label="選擇對話機械人"
        className="min-h-11 min-w-0 flex-1 rounded-lg border border-input bg-background px-3 text-foreground"
        disabled={loading}
        value={bot?.id ?? ""}
        onChange={(event) => { setDismissed(false); selectBot(event.target.value); }}
      >
        <option value="">請選擇機械人</option>
        {(agents.data ?? []).map((agent) => (
          <option key={agent.id} value={agent.id}>{agent.name} — {agent.title}</option>
        ))}
      </select>
      <Button type="button" variant="outline" onClick={() => { if (bot) setCreating(true); else setDismissed(false); }}>{bot ? "新增" : "選擇／建立"}</Button>
    </div>
    <Dialog open={!loading && !error && !bot && !dismissed && !creating} onOpenChange={(open) => { if (!open) setDismissed(true); }}>
      <DialogContent>
        <DialogTitle>選擇機械人</DialogTitle>
        <DialogDescription>{agents.data?.length ? "選擇你要對話的機械人。" : "目前沒有可用的機械人，請先建立一個。"}</DialogDescription>
        <div className="flex flex-col gap-2">
          {(agents.data ?? []).map((agent) => <Button key={agent.id} variant="outline" onClick={() => selectBot(agent.id)}>{agent.name} — {agent.title}</Button>)}
          <Button onClick={() => setCreating(true)}>新增機械人</Button>
        </div>
      </DialogContent>
    </Dialog>
    <NewBotSheet open={creating} onClose={() => setCreating(false)} onCreated={(id) => { selectBot(id); setCreating(false); setDismissed(false); }} />
    </>
  );
}
