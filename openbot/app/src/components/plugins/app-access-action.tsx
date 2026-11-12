import { useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { useConnectInNewTab } from "@/components/plugins/connect-in-new-tab";
import { Button } from "@/components/ui/button";
import {
  cancelAppAccessRequestMutationOptions,
  requestAppAccessMutationOptions,
} from "@/lib/app-access/mutations";
import { type AppAccess, appAccessKeys } from "@/lib/app-access/queries";
import { queryClient } from "@/query-client";

/**
 * One work app's state for the person looking, and the one thing they can do about it.
 *
 * ONE PIECE, DRAWN IN TWO PLACES. A Bot's page lists every app the Bot holds with a row each, and a
 * conversation draws a card when the Bot needed an app it could not use. Both say the same thing —
 * whether this person can use this app through this Bot, whose move it is if not, and the button
 * for that move — so both draw it from here, and a sentence corrected for one is corrected for both.
 *
 * WHO CAN FIX IT IS THE WHOLE SENTENCE. Seven states reduce to four answers: nothing to do, a step
 * that is yours (connect, reconnect), a step only an administrator can take (switch it on, finish
 * setting it up, grant it, connect or approve the team account), and on somebody else's Team Bot a
 * step only its owner can take (reconnect the account the Bot runs on). The copy names which,
 * because "Gmail is unavailable" sends somebody hunting through their own settings for a switch that
 * is not there.
 *
 * THE STATE IS THE SERVER'S. It arrives on `access` and is drawn as it is; nothing here works out
 * from `granted` or `accountMode` what the state ought to be. The one exception is the caller's: a
 * card may hand in an `access` whose state it overrode from the refusal it was drawn for — see
 * `AppAccessCard` — and that is the caller's decision, made where the refusal is in hand.
 */

/** What the person is told about one app, in words that say whose move it is. */
export function appAccessSentence(access: AppAccess): string {
  const name = access.displayName;
  const owners = access.accountHolder === "owner";
  switch (access.state) {
    case "ready":
      if (owners)
        return `已可使用。這個機械人會使用擁有者的 ${name} 帳戶。`;
      if (access.asksFirst)
        return `已可使用你的 ${name} 帳戶，首次使用時會先徵求你的同意。`;
      return "已可使用。";
    case "not_connected":
      return `你尚未連接 ${name} 帳戶。`;
    case "reconnect":
      return owners
        ? `這個機械人所用的擁有者 ${name} 帳戶需要重新連接，只有機械人擁有者可處理。`
        : `你的 ${name} 帳戶需要重新連接。`;
    case "shared_not_connected":
      return `機構的 ${name} 帳戶尚未連接，只有管理員可處理。`;
    case "shared_not_approved":
      return `這個機械人的使用對象超出管理員為機構 ${name} 帳戶批准的範圍，須由管理員批准。`;
    case "disabled":
      return disabledSentence(access);
    case "not_granted":
      return `這個機械人尚未獲授權使用 ${name}，只有管理員可授予權限。`;
  }
}

/**
 * Switched off, in the words for why. "Turned off by an admin" was true of one reason in five: an
 * app nobody switched on, and a set-up somebody has not finished, are not a decision anybody took.
 * The unconfigured-broker case says what the app's page under Connections says about the same app,
 * so the two screens never disagree about it.
 */
function disabledSentence(access: AppAccess): string {
  const name = access.displayName;
  switch (access.unavailable) {
    case "composio_unconfigured":
      return `${name} 尚未設定，須由管理員啟用。`;
    case "scheme_unreadable":
    case "oauth_client_missing":
    case "token_missing":
      return `${name} 尚未完成設定，須由管理員處理。`;
    default:
      return `${name} 尚未啟用，只有管理員可啟用。`;
  }
}

/**
 * The button for the person's next move, and what it says while it happens.
 *
 * - `ready` — nothing.
 * - `shared_not_approved` — nothing either: the call that was refused already filed the
 *   administrator's request, so there is no second one to make.
 * - `reconnect` on an account the Bot's owner holds — nothing. Only the owner can reconnect their
 *   own account, and nobody else's press could do it for them.
 * - `not_connected` / `reconnect` — the person's own connection. Connect starts it in a new tab
 *   with the connect route Settings presses; an app connected with a typed key, and a Composio app
 *   that already has a row (which the connect route refuses until it is disconnected), go to the
 *   app's own page in Settings instead, where the form and Disconnect are.
 * - the three an administrator fixes — Request access, which files the request the server decides
 *   the kind of, and then Requested with a way to withdraw it.
 */
export function AppAccessAction({
  agentId,
  access,
}: {
  agentId: string;
  access: AppAccess;
}) {
  if (access.state === "ready" || access.state === "shared_not_approved")
    return null;
  if (access.state === "reconnect" && access.accountHolder === "owner")
    return null;
  if (access.state === "not_connected" || access.state === "reconnect")
    return <ConnectAction access={access} />;
  return <RequestAction agentId={agentId} access={access} />;
}

/** The person's own account: connect it, or reconnect it. */
function ConnectAction({ access }: { access: AppAccess }) {
  const label = access.state === "reconnect" ? "重新連接" : "連接";
  const tab = useConnectInNewTab();
  const { waiting, stopWaiting } = tab;

  /*
   * WATCHING THE SERVER WHILE A CONSENT IS OPEN in the other tab, because the return trip proves
   * nothing. The whole app-access view is refreshed every two seconds until this app stops being
   * this person's to connect — which is what unmounts this component — and then everything once,
   * because the grants a Bot is offered are read per conversation and the turn after this has to
   * be asked against a store that knows about the new account.
   */
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => {
      void queryClient.invalidateQueries({ queryKey: appAccessKeys.all });
    }, 2_000);
    return () => clearInterval(timer);
  }, [waiting]);
  const waited = useRef(false);
  waited.current ||= waiting;
  useEffect(
    () => () => {
      if (waited.current) void queryClient.invalidateQueries();
    },
    [],
  );

  /*
   * A FORM, OR A CONNECTION THAT ALREADY HAS A ROW, IS SETTINGS' JOB. A typed key has nowhere to be
   * typed but the app's page, and a Composio app whose row still stands — a refused key, an account
   * the vendor lost — is refused by the connect route until it is disconnected there. Only this
   * deployment's own OAuth flow takes a fresh consent over a withdrawn one.
   */
  const viaSettings =
    access.connect === "key" ||
    (access.state === "reconnect" && access.connect !== "oauth") ||
    tab.needsKey;
  if (viaSettings)
    return (
      <Button
        render={<Link params={{ key: access.key }} to="/connections/$key" />}
        aria-label={`${label} ${access.displayName}`}
        size="sm"
        variant="outline"
      >
        {label}
      </Button>
    );

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {tab.error ? (
        <p className="text-destructive text-xs" role="alert">
          {tab.error}
        </p>
      ) : null}
      {tab.blockedUrl ? (
        <p className="text-xs" role="status">
          瀏覽器已封鎖新分頁。{" "}
          <a
            className="underline underline-offset-2"
            href={tab.blockedUrl}
            rel="noreferrer"
            target="_blank"
          >
            開啟 {access.displayName} 登入頁面
          </a>
          .
        </p>
      ) : waiting ? (
        <p className="text-muted-foreground text-xs" role="status">
          請在已開啟的分頁完成授權。
        </p>
      ) : null}
      <Button
        // Named for the app while it is idle; while waiting, the visible words already name it.
        aria-label={waiting ? undefined : `${label} ${access.displayName}`}
        disabled={tab.pending}
        onClick={() => {
          stopWaiting();
          tab.open(access.key);
        }}
        size="sm"
        variant="outline"
      >
        {waiting ? `等待 ${access.displayName}…` : label}
      </Button>
    </div>
  );
}

/** A step only an administrator can take: ask for it, and withdraw the ask. */
function RequestAction({
  agentId,
  access,
}: {
  agentId: string;
  access: AppAccess;
}) {
  const request = useMutation(requestAppAccessMutationOptions(queryClient));
  const cancel = useMutation(
    cancelAppAccessRequestMutationOptions(queryClient),
  );
  const error = request.error ?? cancel.error;

  /*
   * FOCUS FOLLOWS THE PRESS. Request access and Withdraw replace each other, so the button somebody
   * pressed leaves the page the moment the server's answer is drawn, and the focus with it — onto
   * the body, where a keyboard user starts again from the top. The press is remembered, and when
   * the other button arrives in its place it takes the focus. A refused press leaves the same
   * button standing, which gets it back.
   */
  const control = useRef<HTMLButtonElement>(null);
  const pressed = useRef(false);
  const requested = access.request !== null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on the swap between the two buttons.
  useEffect(() => {
    if (!pressed.current) return;
    pressed.current = false;
    control.current?.focus();
  }, [requested]);
  const refocus = {
    onError: () => {
      pressed.current = false;
      control.current?.focus();
    },
  };

  /*
   * Nothing to ask for where the server names no request: a state a caller overrode from a refusal
   * the server does not know about (the team account lost at the vendor), which the server would
   * answer 409 because as far as it knows nothing is wrong. The sentence still says whose move it is.
   */
  if (!access.request && !access.requestKind) return null;

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {error ? (
        <p className="text-destructive text-xs" role="alert">
          {error.message}
        </p>
      ) : null}
      {access.request ? (
        <>
          <span className="text-muted-foreground text-xs" role="status">
            已提出申請
          </span>
          <Button
            aria-label={
              cancel.isPending
                ? undefined
                : `撤回 ${access.displayName} 的申請`
            }
            disabled={cancel.isPending}
            onClick={() => {
              request.reset();
              pressed.current = true;
              if (access.request) cancel.mutate(access.request.id, refocus);
            }}
            ref={control}
            size="sm"
            variant="ghost"
          >
            {cancel.isPending ? "撤回中…" : "撤回"}
          </Button>
        </>
      ) : (
        <Button
          aria-label={
            request.isPending
              ? undefined
              : `申請使用 ${access.displayName}`
          }
          disabled={request.isPending}
          onClick={() => {
            cancel.reset();
            pressed.current = true;
            request.mutate({ agentId, app: access.key }, refocus);
          }}
          ref={control}
          size="sm"
          variant="outline"
        >
          {request.isPending ? "申請中…" : "申請權限"}
        </Button>
      )}
    </div>
  );
}
