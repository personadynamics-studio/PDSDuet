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
  requestedCallId,
  initiallyOpen,
}: {
  bot?: { id: string; name: string } | null;
  children: (computerAction: ReactNode, onOpenComputer?: () => void) => ReactNode;
  requestedCallId?: string;
  initiallyOpen: boolean;
}) {
  const [open, setOpen] = useState(
    () =>
      initiallyOpen && typeof window !== "undefined" && window.matchMedia(DESKTOP_QUERY).matches,
  );
  useEffect(() => {
    const media = window.matchMedia(DESKTOP_QUERY);
    const change = (event: MediaQueryListEvent) => { if (!event.matches) setOpen(false); };
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  useEffect(() => { if (requestedCallId) setOpen(true); }, [requestedCallId]);

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      <DetailPanel
        open={Boolean(bot) && open}
        onClose={() => setOpen(false)}
        title="電腦畫面"
        detailWidth={512}
        expandable
        detail={
          bot ? <ComputerViewPanel agentId={bot.id} name={bot.name} /> : null
        }
      >
        {children(
          bot ? <ComputerChatControls
            computerId={bot.id}
            open={open}
            onOpenChange={setOpen}
            label="瀏覽器"
          /> : null,
          bot ? () => setOpen(true) : undefined,
        )}
      </DetailPanel>
    </div>
  );
}
