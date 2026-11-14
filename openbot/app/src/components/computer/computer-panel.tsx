import { ComputerView } from "./computer-view";

export function ComputerViewPanel({ agentId, name }: { agentId: string; name?: string }) {
  return <section aria-label="瀏覽器畫面" className="min-w-0 p-4"><ComputerView computerId={agentId} name={name} /></section>;
}

