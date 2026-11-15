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
        description="保存你的電話和聯絡人，讓機械人按需要搜尋取用。每項資料都可編輯、停用或刪除。"
      />
    </CapabilitiesShell>
  );
}
