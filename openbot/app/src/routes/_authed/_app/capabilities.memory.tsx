import { createFileRoute } from "@tanstack/react-router";
import { CapabilitiesShell } from "@/components/capabilities/capabilities-shell";
import { MemoryList, RememberFact } from "@/components/memory/memories";

export const Route = createFileRoute("/_authed/_app/capabilities/memory")({
  component: MemoryPage,
});

function MemoryPage() {
  return (
    <CapabilitiesShell>
      <MemoryList
        action={<RememberFact />}
        description="查看機械人對你的了解。你新增的資料會供所有機械人使用；機械人自行學到的內容則只供它自己使用。"
      />
    </CapabilitiesShell>
  );
}
