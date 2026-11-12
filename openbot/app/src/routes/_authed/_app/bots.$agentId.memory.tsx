import { createFileRoute, Link } from "@tanstack/react-router";
import { BotSubpage } from "@/components/bot-profile/bot-subpage";
import { MemorySources } from "@/components/memory/sources";
import { ProactiveResearchSettings } from "@/components/suggestions/proactive-panel";

export const Route = createFileRoute("/_authed/_app/bots/$agentId/memory")({
  component: MemoryPage,
});

function MemoryPage() {
  const { agentId } = Route.useParams();
  return (
    <BotSubpage
      agentId={agentId}
      description="The apps this Bot learns from, and the research it does for you in the background."
      title="記憶"
    >
      {(agent) => (
        <>
          <p className="mt-6 text-muted-foreground text-sm">
            What your Bots remember about you is in{" "}
            <Link
              className="underline underline-offset-4"
              to="/capabilities/memory"
            >
              功能
            </Link>
            .
          </p>
          <MemorySources agentId={agent.id} />
          <ProactiveResearchSettings agentId={agent.id} />
        </>
      )}
    </BotSubpage>
  );
}
