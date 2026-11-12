import { IconKey, IconTrash } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { deleteSavedLoginMutationOptions } from "@/lib/passwords/mutations";
import { savedLoginsQueryOptions } from "@/lib/passwords/queries";
import { queryClient } from "@/query-client";

export const Route = createFileRoute("/_authed/settings/passwords")({
  component: PasswordsPage,
});

/**
 * The logins you saved from a private sign-in form.
 *
 * The site and username only: a password is write-only, and this page can delete one but never show
 * it. A saved login is used only when you confirm it in a sign-in form.
 */
function PasswordsPage() {
  const logins = useQuery(savedLoginsQueryOptions());
  const remove = useMutation(deleteSavedLoginMutationOptions(queryClient));
  return (
    <PageShell
      title="密碼"
      description="代機械人登入網站時儲存的登入資料。機械人無法查看，每次使用前都須由你確認。"
    >
      <PageSection title="已儲存的登入資料">
        {logins.isPending ? null : logins.error ? (
          <p className="text-destructive text-sm" role="alert">
            無法載入你的密碼，請重新整理頁面。
          </p>
        ) : !logins.data.passwordManager ? (
          <PageEmpty>
            管理員已關閉儲存密碼功能。你的登入資料仍會保留，
            但暫不供使用。
          </PageEmpty>
        ) : logins.data.logins.length === 0 ? (
          <PageEmpty>
            尚未儲存登入資料。代機械人登入網站時，
            可選擇「儲存至密碼」。
          </PageEmpty>
        ) : (
          <PageRows>
            {logins.data.logins.map((login, index) => (
              <div key={login.id}>
                {index > 0 ? <Separator /> : null}
                <Item size="sm">
                  <ItemMedia variant="icon">
                    <IconKey />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{login.origin}</ItemTitle>
                    <ItemDescription>
                      {login.username}
                      {login.lastUsedAt
                        ? ` · 上次使用：${new Date(login.lastUsedAt).toLocaleDateString("zh-HK")}`
                        : " · 尚未使用"}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Button
                      aria-label={`刪除 ${login.origin} 的登入資料`}
                      size="sm"
                      variant="ghost"
                      disabled={remove.isPending}
                      onClick={() => remove.mutate(login.id)}
                    >
                      <IconTrash />
                    </Button>
                  </ItemActions>
                </Item>
              </div>
            ))}
          </PageRows>
        )}
        {remove.error ? (
          <p className="mt-2 text-destructive text-sm" role="alert">
            {remove.error.message}
          </p>
        ) : null}
      </PageSection>
    </PageShell>
  );
}
