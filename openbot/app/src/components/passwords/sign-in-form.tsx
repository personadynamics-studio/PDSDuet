import {
  IconKey,
  IconLock,
  IconPointer,
  IconShieldCheck,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useId, useState } from "react";
import { PageRows, PageSection } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import {
  cancelSignInMutationOptions,
  confirmSavedLoginMutationOptions,
  finishSignInMutationOptions,
  submitSignInCodeMutationOptions,
  submitSignInMutationOptions,
  takeOverSignInMutationOptions,
} from "@/lib/passwords/mutations";
import {
  FINAL_SIGN_IN,
  signInRequestQueryOptions,
} from "@/lib/passwords/queries";
import { queryClient } from "@/query-client";

/**
 * The private sign-in form.
 *
 * Outside the conversation on purpose: what is typed here goes to the server in one request and from
 * there straight into the Bot's browser. It is never a chat message, a tool argument or a tool
 * result, so the model never sees it, and the transcript never holds it. The password lives in this
 * component's state until it is sent and is cleared the moment it is.
 *
 * Four answers: type a login, confirm a saved one, take over the browser, or decline.
 *
 * A verification code is never asked for here up front. If the site, once it has the password, sends
 * one, the server reports `code_required` and this form asks for that code alone, then sends it on
 * its own, cleared from state the same way.
 */
export function SignInForm({ requestId }: { requestId: string }) {
  const request = useQuery({
    ...signInRequestQueryOptions(requestId),
    // Polled so a takeover finishing elsewhere, or the request expiring, shows here.
    refetchInterval: (query) =>
      query.state.data && FINAL_SIGN_IN.includes(query.state.data.status)
        ? false
        : 3_000,
  });
  const submit = useMutation(submitSignInMutationOptions(queryClient));
  const submitCode = useMutation(submitSignInCodeMutationOptions(queryClient));
  const confirmSaved = useMutation(
    confirmSavedLoginMutationOptions(queryClient),
  );
  const takeOver = useMutation(takeOverSignInMutationOptions(queryClient));
  const finish = useMutation(finishSignInMutationOptions(queryClient));
  const cancel = useMutation(cancelSignInMutationOptions(queryClient));
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [save, setSave] = useState(false);
  const id = useId();

  if (request.isPending) return null;
  if (request.error)
    return (
      <p className="text-destructive text-sm" role="alert">
        {request.error.message}
      </p>
    );
  const data = request.data;
  const busy =
    submit.isPending ||
    submitCode.isPending ||
    confirmSaved.isPending ||
    takeOver.isPending ||
    finish.isPending ||
    cancel.isPending;
  const failure =
    submitCode.error ??
    submit.error ??
    confirmSaved.error ??
    takeOver.error ??
    finish.error ??
    cancel.error;

  if (FINAL_SIGN_IN.includes(data.status))
    return (
      <PageSection title={data.status === "signed_in" ? "已登入" : "已關閉"}>
        <p className="text-muted-foreground text-sm">
          {data.outcome ?? "這次登入已結束。"}
        </p>
      </PageSection>
    );

  if (data.status === "code_required")
    return (
      <PageSection
        title="輸入驗證碼"
        description="網站已傳送驗證碼，請輸入以完成登入。"
      >
        <form
          className="flex flex-col gap-3"
          autoComplete="off"
          onSubmit={(event) => {
            event.preventDefault();
            const value = code.trim();
            if (!value) return;
            submitCode.mutate(
              { id: requestId, code: value },
              // Cleared whatever happened: a code is good once, and a wrong one is retyped.
              { onSettled: () => setCode("") },
            );
          }}
        >
          <label className="flex flex-col gap-1 text-sm" htmlFor={`${id}-code`}>
            驗證碼
            <Input
              id={`${id}-code`}
              autoComplete="one-time-code"
              inputMode="numeric"
              name="code"
              required
              autoFocus
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
          </label>
          {failure || data.outcome ? (
            <p className="text-destructive text-sm" role="alert">
              {failure?.message ?? data.outcome}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" type="submit" disabled={busy || !code.trim()}>
              <IconShieldCheck />
              {submitCode.isPending ? "讀取中…" : "完成登入"}
            </Button>
            <Button
              size="sm"
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => takeOver.mutate(requestId)}
            >
              <IconPointer />
              接手完成登入
            </Button>
            <Button
              size="sm"
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => cancel.mutate(requestId)}
            >
              取消
            </Button>
          </div>
        </form>
      </PageSection>
    );

  if (data.status === "taken_over")
    return (
      <PageSection
        title="手動登入"
        description="開啟機械人的瀏覽器並自行登入，然後選擇「我已登入」，機械人便會繼續工作。"
      >
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            render={
              <Link to="/bot" search={{ agent: data.botId, watch: true }} />
            }
          >
            開啟機械人的瀏覽器
          </Button>
          <Button
            size="sm"
            disabled={busy}
            onClick={() => finish.mutate(requestId)}
          >
            {finish.isPending ? "正在完成…" : "我已登入"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => cancel.mutate(requestId)}
          >
            取消
          </Button>
        </div>
        {failure ? (
          <p className="mt-2 text-destructive text-sm" role="alert">
            {failure.message}
          </p>
        ) : null}
      </PageSection>
    );

  return (
    <>
      {data.outcome ? (
        <p className="text-destructive text-sm" role="alert">
          {data.outcome}
        </p>
      ) : null}
      {data.savedLogins.length > 0 ? (
        <PageSection
          title="使用已儲存的登入資料"
          description={`選擇登入資料，用於本次登入 ${data.origin}。`}
        >
          <PageRows>
            {data.savedLogins.map((login, index) => (
              <div key={login.id}>
                {index > 0 ? <Separator /> : null}
                <Item size="sm">
                  <ItemMedia variant="icon">
                    <IconKey />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{login.username}</ItemTitle>
                    <ItemDescription>{data.origin}</ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        confirmSaved.mutate({
                          id: requestId,
                          loginId: login.id,
                        })
                      }
                    >
                      確認並登入
                    </Button>
                  </ItemActions>
                </Item>
              </div>
            ))}
          </PageRows>
        </PageSection>
      ) : null}
      <PageSection
        title="輸入登入資料"
        description="資料會直接輸入機械人的瀏覽器，機械人只會知道登入是否成功。"
      >
        <form
          className="flex flex-col gap-3"
          autoComplete="off"
          onSubmit={(event) => {
            event.preventDefault();
            if (!password) return;
            submit.mutate(
              {
                id: requestId,
                input: {
                  ...(username ? { username } : {}),
                  password,
                  save,
                },
              },
              {
                // Cleared whatever happened: a failed attempt is retyped, never kept.
                onSettled: () => setPassword(""),
              },
            );
          }}
        >
          <label
            className="flex flex-col gap-1 text-sm"
            htmlFor={`${id}-username`}
          >
            用戶名稱或電郵
            <Input
              id={`${id}-username`}
              autoComplete="username"
              name="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
          </label>
          <label
            className="flex flex-col gap-1 text-sm"
            htmlFor={`${id}-password`}
          >
            密碼
            <Input
              id={`${id}-password`}
              autoComplete="current-password"
              name="password"
              type="password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          {data.passwordManager ? (
            <label
              className="flex items-center gap-2 text-sm"
              htmlFor={`${id}-save`}
            >
              <Checkbox
                id={`${id}-save`}
                checked={save}
                onCheckedChange={(checked) => setSave(checked === true)}
              />
              儲存至密碼
            </label>
          ) : null}
          {failure ? (
            <p className="text-destructive text-sm" role="alert">
              {failure.message}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" type="submit" disabled={busy || !password}>
              <IconLock />
              {submit.isPending ? "登入中…" : "登入"}
            </Button>
            <Button
              size="sm"
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => takeOver.mutate(requestId)}
            >
              <IconPointer />
              接手登入
            </Button>
            <Button
              size="sm"
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => cancel.mutate(requestId)}
            >
              拒絕
            </Button>
          </div>
        </form>
      </PageSection>
    </>
  );
}
