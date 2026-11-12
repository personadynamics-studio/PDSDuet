import { type ReactNode, useEffect, useState } from "react";
import { ComputerChatControls } from "@/components/computer/computer-controls";
import { ComputerViewPanel } from "@/components/computer/computer-panel";
import { DetailPanel } from "@/components/layout/detail-panel";

// Match Tailwind's lg breakpoint: a narrow window must never open a sheet on arrival.
const DESKTOP_QUERY = "(min-width: 1024px)";

/** Layout only: the caller keeps its existing Chat, channel, draft and message handlers. */
export function ChatWorkspace({
  bot,
  children,
}: {
  bot?: { id: string; name: string } | null;
  children: (computerAction: ReactNode) => ReactNode;
}) {
  const [open, setOpen] = useState(
    () =>
      typeof window !== "undefined" && window.matchMedia(DESKTOP_QUERY).matches,
  );
  useEffect(() => {
    const media = window.matchMedia(DESKTOP_QUERY);
    const change = (event: MediaQueryListEvent) => setOpen(event.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-[1600px] flex-1 flex-col">
      <DetailPanel
        open={Boolean(bot) && open}
        onClose={() => setOpen(false)}
        title="電腦畫面"
        detailWidth={512}
        detail={
          bot ? <ComputerViewPanel agentId={bot.id} name={bot.name} /> : null
        }
      >
        {children(
          <ComputerChatControls
            computerId={bot?.id}
            open={Boolean(bot) && open}
            onOpenChange={setOpen}
            label="電腦"
          />,
        )}
      </DetailPanel>
    </div>
  );
}
