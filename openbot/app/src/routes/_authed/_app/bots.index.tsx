import { IconPlus } from "@tabler/icons-react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { z } from "zod";
import { NewBotSheet } from "@/components/agents/new-bot-sheet";
import { BotRoster } from "@/components/bots/bot-roster";
import { PageShell } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { useSelectedBot } from "@/lib/agents/selected-bot";

/** Creating a Bot is a search-parameter state, so the roster stays mounted and Back closes it. */
export const Route = createFileRoute("/_authed/_app/bots/")({
  validateSearch: z.object({ new: z.boolean().optional() }),
  component: BotsPage,
});

function BotsPage() {
  const { selectBot } = useSelectedBot();
  const { new: creating } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <PageShell
      action={
        <Button
          render={(props) => (
            <Link {...props} search={{ new: true }} to="/bots" />
          )}
          className="min-h-11"
          variant="ghost"
        >
          <IconPlus />
          新增機械人
        </Button>
      }
      description="選擇機械人開始對話，或管理機械人的設定。"
      title="機械人"
    >
      <BotRoster />
      <NewBotSheet
        onClose={() => void navigate({ search: {} })}
        onCreated={(agentId) => {
          selectBot(agentId);
          void navigate({ to: "/", replace: true });
        }}
        open={creating === true}
      />
    </PageShell>
  );
}
