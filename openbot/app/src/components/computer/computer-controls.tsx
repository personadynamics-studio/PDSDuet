import { IconDeviceDesktop } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";

export function ComputerChatControls({ computerId, open, onOpenChange, label }: { computerId?: string; open: boolean; onOpenChange(open: boolean): void; label?: string }) {
  return <Button aria-expanded={open} aria-label={open ? "關閉瀏覽器" : "開啟瀏覽器"} disabled={!computerId} onClick={() => onOpenChange(!open)} size={label ? "sm" : "icon"} variant="ghost"><IconDeviceDesktop className="size-4.5" />{label}</Button>;
}
