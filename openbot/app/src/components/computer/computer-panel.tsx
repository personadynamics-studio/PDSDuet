import { ActivityLog } from "./activity-log";
import { ComputerView } from "./computer-view";

/** The current live computer, separate from screenshots kept in historical tool results. */
export function ComputerViewPanel({
  agentId,
  name,
}: {
  agentId: string;
  name?: string;
}) {
  return (
    <section aria-label="電腦側欄" className="p-4">
      <ComputerView active computerId={agentId} name={name} minWidth={0} />
      <div className="mt-8">
        <h3 className="mb-2 font-medium text-sm">動態</h3>
        <ActivityLog computerId={agentId} />
      </div>
    </section>
  );
}
