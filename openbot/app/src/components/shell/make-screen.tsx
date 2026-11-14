import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { PageShell } from "@/components/layout/page-shell";
import { pageListQueryOptions } from "@/lib/pages/queries";

export function MakeScreen() {
  const pages = useQuery(pageListQueryOptions());
  return <PageShell title="已保存頁面" description="在對話中建立並保存的內容。">
    {pages.isPending ? <p role="status">正在載入…</p> : pages.error && !pages.data ? <p role="alert" className="text-destructive">{pages.error.message}</p> : !pages.data?.length ? <p className="text-muted-foreground">尚未有已保存的頁面。</p> : <ul className="divide-y">{pages.data.map((page) => <li key={page.id}><Link className="block rounded-lg px-3 py-4 hover:bg-muted" to="/make/$pageId" params={{ pageId: page.id }}><h2 className="font-medium">{page.title}</h2>{page.summary ? <p className="mt-1 text-sm text-muted-foreground">{page.summary}</p> : null}</Link></li>)}</ul>}
  </PageShell>;
}

