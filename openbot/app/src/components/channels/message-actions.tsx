import { useState } from "react";
import { DuetIcon } from "@/components/duet/icons";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function MessageActions({
  text,
  align,
}: {
  text: string;
  align: "start" | "end";
}) {
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  return (
    <div className={`flex items-center gap-2 ${align === "end" ? "self-end" : "self-start"}`}>
      <DropdownMenu onOpenChange={(open) => { if (open) { setNotice(""); setError(""); } }}>
        <DropdownMenuTrigger
          render={<Button aria-label="訊息選項" title="複製或轉發訊息" variant="ghost" size="icon-sm" className="min-h-11 min-w-11 text-muted-foreground"><DuetIcon name="more" size={18} /></Button>}
        />
        <DropdownMenuContent align={align}>
          <DropdownMenuItem className="min-h-11 px-3" onClick={async () => {
            try {
              await navigator.clipboard.writeText(text);
              setNotice("已複製全文");
            } catch {
              setError("無法複製，請選取訊息文字後複製。");
            }
          }}>複製全文</DropdownMenuItem>
          <DropdownMenuItem className="min-h-11 px-3" onClick={async () => {
            if (!navigator.share) {
              setError("此瀏覽器不支援原生分享，請先複製全文。");
              return;
            }
            try {
              await navigator.share({ text });
            } catch (cause) {
              if (cause instanceof Error && cause.name === "AbortError") return;
              setError("無法開啟分享，請重試或複製全文。");
            }
          }}>轉發</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {notice ? <span className="text-xs text-muted-foreground" role="status">{notice}</span> : null}
      {error ? <span className="text-xs text-destructive" role="alert">{error}</span> : null}
    </div>
  );
}
