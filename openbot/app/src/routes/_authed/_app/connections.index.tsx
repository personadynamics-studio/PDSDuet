import {
  IconBrandGmail,
  IconBrandGoogleDrive,
  IconBrandNotion,
  IconCheck,
  IconPlug,
  IconSearch,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import * as React from "react";
import {
  PageEmpty,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { RowMark } from "@/components/layout/row-mark";
import { PluginLogo } from "@/components/plugins/plugin-logo";
import { providerIcon } from "@/components/settings/linked-accounts";
import {
  linkedNotice,
  visibleLinkedNotice,
} from "@/components/settings/linked-notice";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { type ConnectionRow, connectionRows } from "@/lib/connections/rows";
import { appConfig } from "@/lib/generated/application-config";
import {
  identityProvidersQueryOptions,
  linkedAccountsQueryOptions,
} from "@/lib/identity/queries";
import { keyedLookup } from "@/lib/lookup";
import {
  connectionsQueryOptions,
  type PluginServer,
  personalConnections,
  pluginsPageQueryOptions,
} from "@/lib/plugins/queries";
import { searchTextEntry } from "@/lib/search-text";

/**
 * The services a Bot reads as you.
 *
 * Yours, not the deployment's. An administrator decides which vendors this deployment may reach at
 * all; this is the other half of that decision, and it is one nobody can make for you — there is no
 * endpoint for an administrator to connect an account on somebody's behalf. A Bot calling one of
 * these runs on your own grant, so it sees exactly what you can see and nothing else.
 */
export const Route = createFileRoute("/_authed/_app/connections/")({
  component: RouteComponent,
  /*
   * `?connected=` is how the OAuth callback reports back, carrying a server key on success and
   * `failed` otherwise. `?linked=` is the same for the GitHub account-link callback: `github` on
   * success, `github-taken` when that GitHub account belongs to another OpenBot user, `failed`
   * otherwise (see linked-notice.ts). Each is the only channel available: the callback is a
   * redirect from another company's server, so there is no response body to read.
   *
   * The key is omitted rather than set to undefined. Present-but-undefined makes `search` a required
   * prop on every Link to this route, which is a lot of ripple for a parameter only the callback sets.
   *
   * EACH IS READ AS TEXT WHATEVER THE ROUTER PARSED IT INTO (`searchText`): the router JSON-parses
   * search values, so a server key or reason code that happens to be digits or JSON-shaped arrives
   * as a number or an object, and a `typeof` guard would quietly turn the callback's report into
   * no report at all.
   */
  validateSearch: (
    search: Record<string, unknown>,
  ): { connected?: string; authorized?: string; linked?: string } => ({
    ...searchTextEntry("connected", search.connected),
    /*
     * A CHANNEL OF ITS OWN, BESIDE `?connected=` AND NEVER FOLDED INTO IT. That one is the Composio
     * OAuth callback's and carries a server key or `failed`; this one is the brokered per-action
     * verifier's and carries a reason code. Two senders answering different questions on one
     * parameter is how a notice comes to be drawn for the wrong thing.
     */
    ...searchTextEntry("authorized", search.authorized),
    ...searchTextEntry("linked", search.linked),
  }),
});

/**
 * WHAT THE VERIFIER REFUSED, IN WORDS — AND THE WORDS LIVE HERE AND NOWHERE ELSE.
 *
 * THE SENTENCE NEVER TRAVELS IN THE URL. A message rendered from a query string is a message
 * anybody can author on this deployment's own origin: a link could be sent around carrying whatever
 * sentence its author liked, shown in this page's own voice under this deployment's own address.
 * What travels is an opaque code the server chose from a closed set, and this map is the only place
 * it becomes something a person reads — which is also what keeps one sentence from being maintained
 * in two places that drift apart.
 *
 * AN UNRECOGNISED CODE DRAWS NOTHING, deliberately. A code this build does not know is either
 * somebody probing the parameter or a deployment mid-upgrade, and a generic "something went wrong"
 * for both would be a sentence that tells a person nothing and an invitation to keep trying.
 *
 * A MAP, NOT AN OBJECT, BECAUSE THE KEY COMES OUT OF A URL. An object literal inherits from
 * `Object.prototype`, so an object lookup answers `toString`, `constructor` and `__proto__` with
 * members nobody put here — none of them nullish, so no `?? null` turns them back into "draws
 * nothing", and `Record<string, string>` says they cannot happen so the compiler never asks. What
 * reached the page was a function (an alert with nothing in it) or, for `__proto__`, an object,
 * which React refuses to draw: "Objects are not valid as a React child" took the whole Connected
 * accounts screen down for whoever opened the link. A `Map` holds only what was put in it, so the
 * unrecognised code and the borrowed member are once again the same case, by construction rather
 * than by a list of names to keep out.
 */
export const AUTHORIZATION_NOTICES: ReadonlyMap<string, string> = new Map([
  [
    "no-broker",
    "尚未設定應用程式連接，因此未有記錄任何授權。請聯絡管理員設定。",
  ],
  [
    "not-supported",
    "請在應用程式頁面按「連接」一次授權，這裏不支援逐項操作授權。",
  ],
  [
    "missing-handle",
    "連結未能識別要完成的授權，因此未有進行變更。請從應用程式頁面重新開始。",
  ],
  [
    "no-attempt",
    "沒有等待你完成的授權，授權或已過期，或在另一個工作階段開始。請從應用程式頁面重新開始。",
  ],
  [
    "vendor-unavailable",
    `${appConfig.brand.productName} 完成授權時未收到應用程式回應，因此未有記錄。請稍後再次開啟連結。`,
  ],
  [
    "not-your-authorization",
    "連結與進行中的授權不符，因此未有記錄。請在開始授權的分頁完成，或從應用程式頁面重新開始。",
  ],
  [
    "not-finished",
    "授權尚未完成，因此未有記錄。請先在應用程式完成授權，再開啟連結。",
  ],
  [
    "authorization-failed",
    "應用程式未有完成授權，因此未有記錄。請從應用程式頁面重新開始。",
  ],
  [
    "context-changed",
    "授權期間應用程式帳戶已變更，因此未有記錄，舊帳戶獲授予的權限亦已移除。請從應用程式頁面重新開始。",
  ],
  [
    "not-permitted",
    "授權期間你的權限或應用程式設定已變更，現時無法連接帳戶，因此未有記錄。如仍需完成授權，請聯絡管理員。",
  ],
  [
    "cancelled",
    "授權在完成期間已被取消，因此未有記錄，已授予的權限亦已移除。",
  ],
  [
    "cancelled-left-live",
    "授權在完成期間已被取消，因此未有記錄。但已授予的權限無法移除，應用程式或仍允許你已取消的操作。請在應用程式頁面中斷連接，再重新連接並只授權所需項目。",
  ],
  [
    "not-recorded",
    "無法記錄授權，因此未有儲存。請從應用程式頁面重新開始；如問題持續，請聯絡管理員。",
  ],
]);

/** The sentence for a code the verifier sent back, or null for one this build does not know. */
export function authorizationNoticeFor(
  authorized: string | undefined,
): string | null {
  return authorized
    ? (keyedLookup(AUTHORIZATION_NOTICES, authorized) ?? null)
    : null;
}

/** The same marks the admin connector list uses: these are the same vendors seen from your side. */
const MARKS: ReadonlyMap<
  string,
  React.ComponentType<{ className?: string }>
> = new Map([
  ["google-drive", IconBrandGoogleDrive],
  ["google-workspace", IconBrandGmail],
  ["notion", IconBrandNotion],
]);

/* A Map for the same reason the notices above are one: a lookup answers with what was put in it and
 * nothing a plain object would have inherited, so a catalogue key called `toString` draws the
 * fallback mark rather than handing React `Object.prototype.toString` to render as a component.
 * The read goes through `keyedLookup` so the rule has one home rather than one comment per page;
 * see `app/src/lib/lookup.ts`. The `?? IconPlug` stays here, because what a missing key draws is
 * this page's decision. */
const markFor = (key: string) => keyedLookup(MARKS, key) ?? IconPlug;

/**
 * Whether a row came through a broker. A deployment only ever holds rows from one provider, so the
 * page needs to recognise "brokered", not to know which broker.
 */
const isBrokered = (server: PluginServer): boolean =>
  server.provenance === "composio" || server.provenance === "arcade";

/**
 * The brokered apps this page lists, which is not every brokered row.
 *
 * Exported as a function rather than left inline in the render, for the reason `matchingApps` on the
 * Composio picker is: the rule is the thing worth pinning and pinning it needs no DOM, no router and
 * no query client. See its one clause below.
 */
export function brokeredAccountsListedOn(
  servers: PluginServer[],
): PluginServer[] {
  return servers.filter(
    (server) =>
      isBrokered(server) &&
      server.authScheme !== "NO_AUTH" &&
      server.accountMode !== "shared",
  );
}

/**
 * The servers this page may list at all: none reached through Composio when the deployment has no
 * Composio key.
 *
 * An app an administrator enabled while a key was set keeps its row after the key is removed, and
 * listing it offered a person an account they cannot connect, under a sentence about an environment
 * variable only an administrator can set. Without the broker there is nothing for them to decide.
 */
export function serversListedFor(page: {
  servers: PluginServer[];
  composioConfigured: boolean;
}): PluginServer[] {
  return page.composioConfigured
    ? page.servers
    : page.servers.filter((server) => server.provenance !== "composio");
}

/** Apps whose account is the organisation's, shown so a person knows a Bot does not act as them there. */
export function sharedAccountsListedOn(
  servers: PluginServer[],
): PluginServer[] {
  return servers.filter(
    (server) => isBrokered(server) && server.accountMode === "shared",
  );
}

function RouteComponent() {
  const { connected: outcome, authorized, linked } = Route.useSearch();
  /*
   * ALL THREE READ ONCE HERE, AND ALL THREE DROPPED FROM THE URL BELOW — not just `?linked=`.
   *
   * Every parameter this screen accepts is a report of something that has already happened: the
   * Composio callback's `?connected=`, the brokered verifier's `?authorized=` and the GitHub
   * account-link callback's `?linked=`. A report is news exactly once. Left in the address bar it
   * is read again on every reload and on every back-navigation, so a failure that is minutes old
   * is redrawn as though it had just happened — somebody is told again that their account could
   * not be connected, or that there is no authorization in progress, about an attempt they have
   * since finished successfully. Only `?linked=` was ever cleaned, which is how the other two came
   * to replay.
   *
   * THE SNAPSHOT IS WHAT THE PAGE DRAWS FROM, and it is why the strip can be unconditional. Read
   * live off the search, the notice would vanish the instant the parameter did; held here, the
   * sentence outlives the URL it arrived in. That is what `?linked=` was already doing, and the
   * other two now do it for the same reason rather than by accident.
   */
  const [arrival] = React.useState(() => ({
    outcome,
    authorizationNotice: authorizationNoticeFor(authorized),
    linked: linkedNotice(linked),
  }));
  /* The same cached list the Linked accounts section reads, so a Disconnect there retracts a success here. */
  const links = useQuery(linkedAccountsQueryOptions());
  const providers = useQuery(identityProvidersQueryOptions());
  const notice = visibleLinkedNotice(arrival.linked, links.data);
  const navigate = Route.useNavigate();
  /*
   * ONE NAVIGATE FOR ALL THREE, never one per parameter. `search` replaces the whole object, so two
   * effects each dropping their own key race: whichever lands second rebuilds from a snapshot taken
   * before the first, and puts the key the first had just removed back.
   */
  React.useEffect(() => {
    if (
      outcome === undefined &&
      authorized === undefined &&
      linked === undefined
    ) {
      return;
    }
    navigate({
      search: ({ connected: _c, authorized: _a, linked: _l, ...rest }) => rest,
      replace: true,
    });
  }, [outcome, authorized, linked, navigate]);
  const [search, setSearch] = React.useState("");
  const plugins = useQuery(pluginsPageQueryOptions());
  const connections = useQuery(connectionsQueryOptions());

  /*
   * ONLY THE PERSON'S OWN. A Shared app's row is the deployment's, not this person's, and the
   * "已連接" badge this set feeds would otherwise tell them they hold an account they don't.
   */
  const connected = new Set(
    personalConnections(connections.data?.connections ?? []).map(
      (row) => row.serverId,
    ),
  );
  const added = new Set((plugins.data?.servers ?? []).map((s) => s.id));

  /*
   * Only vendors reached as a person, and only ones an administrator has enabled.
   *
   * A vendor with a shared token has nothing for you to decide: it answers the same for everybody,
   * so listing it here would offer a choice you do not have. And a vendor nobody has enabled cannot
   * be connected at all, because there is no OAuth client to consent against.
   */
  const yours = (plugins.data?.catalogue ?? []).filter(
    (entry) => entry.auth === "user-oauth" && added.has(entry.key),
  );

  /*
   * Brokered apps belong here for the same reason the OAuth ones do: they answer as you.
   *
   * The filter above names the catalogue's `user-oauth` kind, which a brokered row cannot have
   * because it has no catalogue entry at all — so the one connector that is nothing but per-person
   * accounts was the one this page never listed.
   *
   * EXCEPT THE ONES THAT NEED NO ACCOUNT, WHICH IS THE SAME RULE THE `user-oauth` FILTER ABOVE IS.
   * That one keeps out a vendor with a shared token because it "has nothing for you to decide"; a
   * Composio `NO_AUTH` app has exactly as little, one layer further in. There is no account to make:
   * `/servers/:id/connect` refuses to create one and the call gate lets it through with no row, so
   * a row for it here can never turn green. What an admin enabling Hacker News put on every
   * person's page was a permanently grey "尚未連接" that reads as an unfinished task, opening
   * a page that says the app needs no account and draws no button — the list and the page it opens
   * contradicting each other, with the list the more believable of the two.
   *
   * ASKED OF THE RECORDED SCHEME, which this read already carries and the detail route already
   * consumes. Anything that is not the vendor's `NO_AUTH` is an app somebody connects, an
   * unrecorded scheme included: a row whose column was never written is far likelier to be a key or
   * consent app, and dropping it here would hide a connection somebody does have.
   */
  const listed = plugins.data ? serversListedFor(plugins.data) : [];
  const rows = connectionRows({
    catalogue: yours,
    brokered: brokeredAccountsListedOn(listed),
    shared: sharedAccountsListedOn(listed),
    connected,
    links: links.data ?? [],
    providers: providers.data,
  });
  const query = search.trim().toLocaleLowerCase();
  const matching = rows.filter((row) =>
    `${row.title} ${row.summary}`.toLocaleLowerCase().includes(query),
  );
  const inUse = rows.filter((row) => row.state !== "available").length;
  /*
   * The apps decide whether there is a list at all, and the account links only add to it: a failed
   * links read costs the GitHub and Slack rows and says so, not the whole page.
   */
  const loading =
    plugins.isPending ||
    connections.isPending ||
    links.isPending ||
    providers.isPending;

  return (
    <PageShell className="@container" title="連接">
      {/*
       * For `?connected=` only the failure is worth saying. A success needs no sentence: the row it
       * came back to now reads "已連接", which is the same news told by the thing it is news
       * about. `?linked=` is different and says both outcomes, through `linkedNotice` below.
       */}
      {arrival.outcome === "failed" ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          無法連接這個帳戶，未有儲存任何資料。請重試。
        </p>
      ) : null}
      {notice ? (
        notice.tone === "error" ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            {notice.text}
          </p>
        ) : (
          <p className="mt-4 text-sm text-muted-foreground" role="status">
            {notice.text}
          </p>
        )
      ) : null}
      {/*
       * The brokered per-action verifier's own channel. It lands here rather than on an app's page
       * because three of its refusals have no app to name, and a notice that sometimes appears one
       * level in and sometimes here would be a notice people learn to look for in two places.
       */}
      {arrival.authorizationNotice ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {arrival.authorizationNotice}
        </p>
      ) : null}
      <PageSection
        description="機械人以你身分使用的應用程式及帳戶。開啟項目即可連接或修改。"
        title="你的連接"
      >
        {/*
         * BOTH APP READS DECIDE THIS. A `/api/plugins` that succeeded beside a
         * `/api/plugins/connections` that failed would leave the `connected` set empty and every row
         * asserting "連接" over accounts somebody already has, so either failure is one sentence:
         * nothing is listed rather than a list that may be wrong.
         */}
        {loading ? null : plugins.error || connections.error ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            無法載入你的連接，請重新整理頁面。如問題持續，請聯絡管理員。
          </p>
        ) : rows.length === 0 ? (
          <PageEmpty>
            暫未有可連接的應用程式。管理員啟用後，便會在這裏顯示。
          </PageEmpty>
        ) : (
          <>
            <p className="mt-4 text-xs text-muted-foreground">
              使用中：{inUse} · 共 {rows.length} 項
            </p>
            <InputGroup className="mt-3 h-11 border-transparent bg-muted/60 shadow-none dark:bg-muted/60">
              <InputGroupAddon>
                <IconSearch aria-hidden="true" className="size-4" />
              </InputGroupAddon>
              <InputGroupInput
                aria-label="搜尋連接"
                className="h-11"
                placeholder="搜尋連接"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </InputGroup>
            {matching.length === 0 ? (
              <p className="mt-8 text-sm text-muted-foreground" role="status">
                找不到包含「{search.trim()}」的項目。
              </p>
            ) : (
              <div className="mt-6 grid grid-cols-1 gap-x-6 gap-y-2 @min-[36rem]:grid-cols-2">
                {matching.map((row) => (
                  <ConnectionItem key={row.key} row={row} />
                ))}
              </div>
            )}
          </>
        )}
        {links.error || providers.error ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            Couldn't load GitHub and Slack, so they aren't listed. Reload the
            page.
          </p>
        ) : null}
      </PageSection>
    </PageShell>
  );
}

/** One connection: its mark, its name, one line, and where it stands. Opens its own page. */
function ConnectionItem({ row }: { row: ConnectionRow }) {
  return (
    <Item
      className="min-w-0 flex-nowrap gap-3 px-2 py-3"
      data-testid={`account-${row.key}`}
      render={<Link params={{ key: row.key }} to="/connections/$key" />}
      size="sm"
    >
      <RowMark className="size-9">
        <ConnectionMark mark={row.mark} />
      </RowMark>
      <ItemContent className="min-w-0 gap-0.5">
        <ItemTitle className="block w-auto truncate">{row.title}</ItemTitle>
        <ItemDescription
          className="line-clamp-1 break-all text-xs"
          title={row.summary}
        >
          {row.summary}
        </ItemDescription>
      </ItemContent>
      <ItemActions className="shrink-0">
        <ConnectionStateLabel state={row.state} />
      </ItemActions>
    </Item>
  );
}

function ConnectionMark({ mark }: { mark: ConnectionRow["mark"] }) {
  if (mark.kind === "logo") return <PluginLogo logo={mark.logo} />;
  const Mark =
    mark.kind === "provider" ? providerIcon(mark.provider) : markFor(mark.key);
  return <Mark className="size-4" />;
}

function ConnectionStateLabel({ state }: { state: ConnectionRow["state"] }) {
  if (state === "connected") {
    return (
      <span className="flex items-center gap-1 text-xs text-muted-foreground">
        <IconCheck
          aria-hidden="true"
          className="size-3.5 text-emerald-600 dark:text-emerald-400"
        />
        已連接
      </span>
    );
  }
  if (state === "team") {
    return <span className="text-xs text-muted-foreground">團隊帳戶</span>;
  }
  return (
    <span className="rounded-full bg-muted px-3 py-1 text-xs font-medium">
      {state === "needs_reconnect" ? "重新連接" : "連接"}
    </span>
  );
}
