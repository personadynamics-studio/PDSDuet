import { useQuery } from "@tanstack/react-query";
import { Link, useCanGoBack, useNavigate, useRouter } from "@tanstack/react-router";
import { type ComponentProps, type ReactNode } from "react";
import { DuetIcon } from "@/components/duet/icons";
import { MicOrb } from "@/components/duet/mic-orb";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { appConfig } from "@/lib/generated/application-config";
import { cn } from "@/lib/utils";
import { usePageChromeState } from "./page-chrome";

const DISC = "pointer-events-auto grid size-11 shrink-0 place-items-center rounded-full bg-duet-card text-duet-ink shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-duet-accent";
export function initialOf(user: { name?: string | null; email: string }) {
  return ((user.name || user.email).match(/\p{L}|\p{N}/u)?.[0] ?? "?").toUpperCase();
}
export function ShellHeader({ menuOpen, onMenu, computerAction, floating = false }: { menuOpen: boolean; onMenu(): void; computerAction?: ReactNode; floating?: boolean }) {
  const { data: user } = useQuery(currentUserQueryOptions());
  return (
    <header className={cn("z-20 flex h-[88px] shrink-0 items-start justify-between gap-3 px-4 pt-3", floating && "pointer-events-none absolute inset-x-0 top-0 bg-gradient-to-b from-duet-surface to-transparent")}>
      <button className={DISC} type="button" aria-label="選單" aria-expanded={menuOpen} onClick={onMenu}><DuetIcon name="menu" size={22} /></button>
      <Link className="pointer-events-auto grid size-12 shrink-0 place-items-center rounded-full" to="/" aria-label={appConfig.brand.productName + " 對話"}><MicOrb size={46} still /></Link>
      <div className="pointer-events-auto flex min-w-0 items-center gap-2">{computerAction}<Link className={DISC} to="/settings" aria-label="你的設定">{user ? initialOf(user) : ""}</Link></div>
    </header>
  );
}
export function useBack(): () => void {
  const chrome = usePageChromeState();
  const router = useRouter();
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();
  return () => { if (canGoBack) router.history.back(); else void navigate(chrome?.backTo ?? { to: "/" }); };
}
export function PageHeader({ computerAction }: { computerAction?: ReactNode }) {
  const chrome = usePageChromeState();
  const back = useBack();
  return (
    <header className="pointer-events-none absolute inset-x-0 top-0 z-20 flex h-[88px] shrink-0 items-start justify-between gap-3 bg-gradient-to-b from-duet-surface to-transparent px-4 pt-3">
      <button className={DISC} type="button" aria-label="返回" onClick={back}><DuetIcon name="chevronLeft" size={22} /></button>
      <div className="mt-1 min-w-0 rounded-full bg-duet-card px-4 py-2 font-semibold">{chrome?.title}</div>
      <div className="pointer-events-auto flex items-center gap-2">{computerAction}{chrome?.actions}</div>
    </header>
  );
}
export function MoreDisc(props: ComponentProps<"button">) {
  return <button type="button" aria-label="更多" {...props} className={cn(DISC, props.className)}><DuetIcon name="more" size={22} /></button>;
}

