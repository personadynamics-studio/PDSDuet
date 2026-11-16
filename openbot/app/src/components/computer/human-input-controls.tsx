import { useState } from "react";
import { Button } from "@/components/ui/button";
import { type HumanInput, sendHumanInput } from "@/lib/computers/control";

const KEYS = [["Enter", "Enter"], ["Tab", "Tab"], ["Backspace", "退格"], ["Escape", "Esc"]] as const;

/** Touch and assistive input for the same browser the person has taken over. */
export function HumanInputControls({ computerId, disabled }: { computerId: string; disabled: boolean }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const busy = disabled || sending;
  const send = async (input: HumanInput) => {
    if (busy) return false;
    setSending(true);
    setProblem(null);
    try {
      await sendHumanInput(computerId, input);
      return true;
    } catch (failure) {
      setProblem(failure instanceof Error ? failure.message : "未能操作網頁。");
      return false;
    } finally {
      setSending(false);
    }
  };

  return (
    <details className="rounded-lg border">
      <summary className="min-h-11 cursor-pointer px-3 py-3 text-sm font-medium">文字、按鍵與捲動</summary>
      <div className="grid gap-3 border-t p-3">
        <form className="grid gap-2" onSubmit={async (event) => {
          event.preventDefault();
          if (text && await send({ kind: "type", text })) setText("");
        }}>
          <label className="grid gap-1 text-sm">
            輸入網頁文字
            <textarea rows={2} className="min-h-20 rounded-lg border bg-background px-3 py-2 text-base" value={text} onChange={(event) => setText(event.target.value)} disabled={busy} autoComplete="off" />
          </label>
          <p className="text-xs text-muted-foreground">先點選網頁中的欄位，再輸入。文字直接送往網頁，不會放入對話。</p>
          <Button className="min-h-11" type="submit" size="sm" disabled={!text || busy}>輸入網頁</Button>
        </form>
        <div className="flex flex-wrap gap-2">
          {KEYS.map(([key, label]) => <Button className="min-h-11" key={key} size="sm" variant="outline" disabled={busy} onClick={() => { void send({ kind: "key", key }); }}>{label}</Button>)}
          <Button className="min-h-11" size="sm" variant="outline" disabled={busy} onClick={() => { void send({ kind: "scroll", deltaY: -400 }); }}>向上捲動</Button>
          <Button className="min-h-11" size="sm" variant="outline" disabled={busy} onClick={() => { void send({ kind: "scroll", deltaY: 400 }); }}>向下捲動</Button>
        </div>
        {problem ? <p role="alert" className="text-sm text-destructive">{problem}</p> : null}
      </div>
    </details>
  );
}
