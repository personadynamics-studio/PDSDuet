import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useConversationSession } from "@/lib/chat/active-bot";
import { supplySecret, type ControlState } from "@/lib/computers/control";
import { useComputerControl } from "@/lib/computers/use-control";
import { LiveScreen } from "./live-screen";

type Acknowledgement = {
  threadId: string;
  toolCallId: string;
  kind: "computer_handoff" | "computer_secret";
  value: { completed: true } | { cancelled: true } | { supplied: true };
};

/** Display the live browser and acknowledge only the current conversation's real waiting call. */
export function ComputerView({ computerId, name }: { computerId: string; name?: string }) {
  const { control, busy, problem, change, refresh } = useComputerControl(computerId);
  const session = useConversationSession();
  const [screenProblem, setScreenProblem] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [secret, setSecret] = useState("");
  const [sending, setSending] = useState(false);
  const [secretProblem, setSecretProblem] = useState<string | null>(null);
  const [pendingAck, setPendingAck] = useState<Acknowledgement | null>(null);
  const [resumeProblem, setResumeProblem] = useState<string | null>(null);
  const driving = control?.holder === "human";
  const waitingFor = (toolCallId: string, kind: Acknowledgement["kind"]) => session?.activeRun?.waiting?.find((item) =>
    item.answerable && item.toolCallId === toolCallId && item.metadata?.botId === computerId && item.metadata?.kind === kind,
  );
  const acknowledge = async (ack: Acknowledgement) => {
    if (!session || ack.threadId !== session.threadId || !waitingFor(ack.toolCallId, ack.kind)) return;
    try {
      await session.answer(ack.toolCallId, ack.value);
      setPendingAck(null);
      setResumeProblem(null);
    } catch (failure) {
      setPendingAck(ack);
      setResumeProblem(failure instanceof Error ? failure.message : "未能繼續機械人的工作。");
    }
  };
  const resume = async (state: ControlState | null, kind: Acknowledgement["kind"], value: Acknowledgement["value"]) => {
    const callId = state?.request?.toolCallId;
    if (session && callId && waitingFor(callId, kind)) await acknowledge({ threadId: session.threadId, toolCallId: callId, kind, value });
  };
  const controlAction = async (action: "take" | "release" | "cancel") => {
    try {
      const state = await change(action);
      if (action === "release" && state.request?.status === "completed") await resume(state, "computer_handoff", { completed: true });
      if (action === "cancel" && state.request?.status === "cancelled") await resume(state, "computer_handoff", { cancelled: true });
    } catch { /* useComputerControl exposes the mutation's error below. */ }
  };
  const retryAck = pendingAck && pendingAck.threadId === session?.threadId && waitingFor(pendingAck.toolCallId, pendingAck.kind) ? pendingAck : null;
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="min-w-0 truncate font-semibold">{name ? name + " 的瀏覽器" : "瀏覽器"}</h2>
        <Button className="min-h-11" size="sm" disabled={!control || busy} onClick={() => { void controlAction(driving ? "release" : "take"); }}>{driving ? "交回控制權" : "接管控制權"}</Button>
      </div>
      {problem ? <p role="alert" className="text-sm text-destructive">{problem}</p> : null}
      {resumeProblem && retryAck ? <div role="alert" className="text-sm text-destructive">{resumeProblem}<Button variant="link" onClick={() => { void acknowledge(retryAck); }}>重送完成回報</Button></div> : null}
      <div className="relative min-h-52 overflow-hidden rounded-lg border bg-black">
        <LiveScreen computerId={computerId} driving={driving} onProblem={setScreenProblem} retryKey={retry} />
      </div>
      {screenProblem ? <div role="alert" className="flex flex-wrap items-center gap-2 text-sm"><span>{screenProblem}</span><Button size="sm" variant="outline" onClick={() => { setScreenProblem(null); setRetry((value) => value + 1); }}>重新連線</Button></div> : null}
      <p className="text-sm text-muted-foreground">{driving ? "你已接管，可直接在畫面按下、捲動及輸入。" : "正在顯示瀏覽器；接管後即可操作。"}</p>
      {control?.requested ? <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-muted p-3"><span>{control.reason || "機械人需要你操作瀏覽器。"}</span><Button variant="outline" size="sm" disabled={busy} onClick={() => { void controlAction("cancel"); }}>取消要求</Button></div> : null}
      {control?.secretWanted ? <form className="grid gap-2 border-t pt-3" onSubmit={async (event) => {
        event.preventDefault();
        if (!secret || sending) return;
        setSending(true);
        setSecretProblem(null);
        try {
          await supplySecret(computerId, secret);
          await resume(control, "computer_secret", { supplied: true });
          await refresh();
        } catch (failure) { setSecretProblem(failure instanceof Error ? failure.message : "未能傳送資料。"); }
        finally { setSecret(""); setSending(false); }
      }}>
        <label className="grid gap-1 text-sm">網頁需要你提供 {control.secretWanted}<input type="password" className="min-h-11 rounded-lg border bg-background px-3" value={secret} onChange={(event) => setSecret(event.target.value)} autoComplete="off" /></label>
        <p className="text-xs text-muted-foreground">資料直接送往網頁，不會放入對話。</p>
        {secretProblem ? <p role="alert" className="text-sm text-destructive">{secretProblem}</p> : null}
        <Button type="submit" size="sm" disabled={!secret || sending}>{sending ? "正在傳送…" : "傳送至網頁"}</Button>
      </form> : null}
    </div>
  );
}
