import type { AppVariables } from "../../auth/guards";
import {
  asSharedUseApproval,
  exposureOf,
  type SharedUseApproval,
} from "../shared-use";
import type { PluginKind } from "../store";
import type { PluginRouteContext } from "./context";

/**
 * What a grant of one MCP tool must record beside it: the approval for who may use a Shared app's
 * one account through this Bot.
 *
 * Without an approval the gate refuses every call the grant just allowed, so a grant with none sent
 * approves the Bot's exposure as it stands now — unless an approval is already recorded, which is
 * an administrator's earlier decision and not this grant's to widen. "Is Shared" is the app's
 * answer (its answering row), never the granted row's own column. Null `approval` is nothing to
 * record; `unreadable` is an approval sent that this deployment cannot read, which the caller
 * refuses.
 *
 * A FUNCTION RATHER THAN LINES IN THE ROUTE because approving an access request grants through the
 * same rule, and a Shared app granted from the request inbox must land with the same approval it
 * would have had from the grant switch.
 */
export async function sharedGrantApproval(
  { store, shared }: Pick<PluginRouteContext, "store" | "shared">,
  ref: string,
  agentId: string,
  sent: unknown,
): Promise<
  { appId: string; approval: SharedUseApproval | null } | "unreadable"
> {
  if (!shared) return { appId: "", approval: null };
  const [serverId] = ref.split("/");
  const appId = await shared.use.appIdOf(serverId ?? "");
  if ((await store.serverAddress(appId))?.accountMode !== "shared")
    return { appId, approval: null };
  if (sent !== undefined) {
    const approval = asSharedUseApproval(sent);
    return approval ? { appId, approval } : "unreadable";
  }
  if (await shared.use.approvalFor(agentId, appId))
    return { appId, approval: null };
  return {
    appId,
    approval: exposureOf(await shared.use.botFacts(agentId)),
  };
}

/** Granting and revoking MCP tools and skills. */
export function mountGrantRoutes({
  routes,
  store,
  requireUser,
  profiles,
  shared,
  actorEmail,
  skillActor,
}: PluginRouteContext) {
  /**
   * Grant and revoke, for both kinds, through one pair of endpoints.
   *
   * The store keeps one grant table because the question is the same either way; the API says the
   * same thing, so a reader is never left wondering whether skills are governed differently.
   */

  /**
   * The kinds of grant this API will act on.
   *
   * CHECKED AT RUNTIME, not only in the types. `kind` arrives in a JSON body, so a type annotation
   * on it is a comment: before this, anything at all could be written into the grant table through
   * the ordinary endpoint, and one kind that was never meant to be settable this way already could.
   */
  const GRANT_KINDS = new Set<PluginKind>(["mcp", "skill"]);
  const asGrantKind = (value: unknown): PluginKind | null =>
    typeof value === "string" && GRANT_KINDS.has(value as PluginKind)
      ? (value as PluginKind)
      : null;

  /**
   * May this person put this on that Bot?
   *
   * MCP is an administrator's, always: it reaches another company's system with a stored credential.
   * A skill is an instruction, so somebody may put their own skill on a Bot they own, and neither
   * half alone is enough. Both are checked here rather than in the store, because this is the only
   * place that knows who is asking.
   */
  async function enablementRefusal(
    context: { var: AppVariables },
    kind: PluginKind,
    ref: string,
    agentId: string,
    /** Removing a grant does not require its target still to exist. */
    intent: "grant" | "revoke",
  ): Promise<string | null> {
    const actor = skillActor(context);

    if (kind === "mcp") {
      if (!actor.isAdmin) {
        return "Only an admin can choose which Bots use a tool.";
      }
      // Taking something away is always allowed: see the note on `intent`. It matters more here
      // than anywhere else, because the rows this check exists to prevent are the same shape as the
      // rows #572's migration had to delete, and an administrator has to be able to remove one by
      // hand rather than wait for a migration.
      if (intent === "revoke") return null;

      /*
       * A grant that could never do anything is refused rather than stored, so a grant cannot become live later when an app is added under that ID.
       *
       * Nothing checked that the app existed. `store.grant` is a bare upsert, so a ref naming an
       * app this deployment has not added was stored and then invisible: the surface that reports a
       * grant nothing advertises is built per server row, and there was no row. #572 fixed the way
       * these rows were MADE — a removal used to leave its grants behind — and added the migration
       * that deleted the ones already there. This is the other door into the same room. Add the app
       * afterwards and the id is the same, the action names are the same, and every one of those
       * grants resolves, with nobody having granted anything and no row in the trail saying so.
       *
       * THE SERVER HALF ONLY. A grant naming a tool the server has stopped advertising is a
       * supported state, held and not offered, because what a vendor lists today is not what
       * somebody decided yesterday — checking the tool here would refuse a re-grant of exactly the
       * tool an administrator is trying to restore. A grant naming no app at all is not that state.
       */
      const [serverId] = ref.split("/");
      if (!(await store.serverExists(serverId ?? ""))) {
        return `${serverId} hasn't been added yet. Add it first, then give its tools to a Bot.`;
      }
      /*
       * The Bot has to exist as well.
       * `plugin_grants.agent_id` is a foreign key, so a grant naming a Bot nobody has reached the
       * insert and failed there, and a person's mistyped Bot id answered 500 with no body where
       * every other refusal on this route is a 403 with a sentence.
       */
      if (!(await store.agentIsRegistered(agentId)))
        return "There is no such Bot.";
      return null;
    }

    if (actor.isAdmin) {
      // Taking something away is always allowed: see the note on `intent`.
      if (intent === "revoke") return null;
      /*
       * A grant naming no skill is refused for an administrator too, as the `mcp` branch refuses a
       * grant naming no app. `store.grant` is a bare upsert and a Bot's skills are read by slug
       * alone, so the row sat there granting nothing until somebody wrote a skill under that name,
       * and then that skill was on this Bot with nobody having put it there. On a Bot the
       * deployment shares, that is one person's instructions answering everybody:
       * `skill-uninstall-grants.integration.test.ts` guards the same room from the uninstall side.
       */
      if ((await store.skillOwner(ref)) === undefined) {
        return `There is no skill called ${ref}.`;
      }
      // And the Bot, for the reason the `mcp` branch gives: an administrator's grant naming one
      // nobody has failed on the foreign key. Everybody else is asked below, through `agentOwner`.
      if (!(await store.agentIsRegistered(agentId)))
        return "There is no such Bot.";
      return null;
    }

    const owner = await store.skillOwner(ref);
    if (owner === undefined) return `There is no skill called ${ref}.`;
    if (owner !== actor.id) {
      return owner === null
        ? `${ref} belongs to everyone. Only an admin can choose which Bots use it.`
        : `${ref} is somebody else's skill.`;
    }

    const botOwner = await store.agentOwner(agentId);
    if (botOwner === undefined) return "There is no such Bot.";
    if (botOwner !== actor.id) {
      // Including the shared Bots this deployment publishes, which have no owner at all: a skill
      // one person wrote would otherwise change how a Bot answers everybody.
      return "You can only put your own skills on Bots you own.";
    }
    return null;
  }

  routes.post("/grants", requireUser, async (context) => {
    const body = (await context.req.json().catch(() => null)) as {
      kind?: unknown;
      ref?: string;
      agentId?: string;
      approval?: unknown;
    } | null;
    const kind = asGrantKind(body?.kind);
    /*
     * The body is JSON, so the annotation is a wish: `{"ref":123,"agentId":[]}` passes a
     * truthiness check and then reaches the store, where Drizzle compares a text column against
     * a number and the request answers 500. A ref and a Bot id are non-empty strings here.
     */
    if (
      !kind ||
      typeof body?.ref !== "string" ||
      !body.ref.trim() ||
      typeof body.agentId !== "string" ||
      !body.agentId.trim()
    ) {
      return context.json(
        { error: "A kind, a ref and a Bot are required." },
        400,
      );
    }
    /*
     * Trimmed before it is checked and before it is stored, the way the DELETE twin below already
     * does. Without this a padded ref refuses with the padding quoted back (`" app" is not an app`),
     * and a grant that did pass would be stored under a ref no revoke could match.
     */
    const grantRef = body.ref.trim();
    const grantAgentId = body.agentId.trim();
    const refusal = await enablementRefusal(
      context,
      kind,
      grantRef,
      grantAgentId,
      "grant",
    );
    if (refusal) return context.json({ error: refusal }, 403);

    /*
     * A SHARED APP'S ACTION IS GRANTED WITH WHO MAY USE IT, in the one request. See
     * {@link sharedGrantApproval} for what is recorded when none is sent.
     */
    const decided =
      kind === "mcp"
        ? await sharedGrantApproval(
            { store, shared },
            grantRef,
            grantAgentId,
            body?.approval,
          )
        : null;
    if (decided === "unreadable") {
      return context.json(
        { error: "That approval is not one this deployment can read." },
        400,
      );
    }
    await store.grant(kind, grantRef, grantAgentId, actorEmail(context));
    if (decided?.approval && shared) {
      await shared.use.setApproval({
        botId: grantAgentId,
        serverId: decided.appId,
        approval: decided.approval,
        by: context.var.actor.id,
      });
    }
    return context.json({ ok: true });
  });

  routes.delete("/grants", requireUser, async (context) => {
    const kind = asGrantKind(context.req.query("kind"));
    const ref = context.req.query("ref");
    const agentId = context.req.query("agentId");
    /*
     * Query params are always strings, so truthiness is not enough: `"   "` is truthy and used
     * to pass this check, delete zero rows by exact match, still write a `plugin_revoked` audit
     * row naming whitespace, and answer `ok:true`. The POST twin already requires non-empty
     * strings; this requires the same and acts on the trimmed values.
     */
    if (
      !kind ||
      typeof ref !== "string" ||
      !ref.trim() ||
      typeof agentId !== "string" ||
      !agentId.trim()
    ) {
      return context.json(
        { error: "A kind, a ref and a Bot are required." },
        400,
      );
    }
    const trimmedRef = ref.trim();
    const trimmedAgentId = agentId.trim();
    const refusal = await enablementRefusal(
      context,
      kind,
      trimmedRef,
      trimmedAgentId,
      "revoke",
    );
    if (refusal) return context.json({ error: refusal }, 403);

    await store.revoke(kind, trimmedRef, trimmedAgentId, actorEmail(context));
    return context.json({ ok: true });
  });

  /** What one Bot holds. The runtime reads this to decide what to offer a model. */
  routes.get("/for/:agentId", requireUser, async (context) => {
    const agentId = context.req.param("agentId");
    if (!(await profiles?.get(context.var.actor, agentId)))
      return context.json({ error: "Bot not found." }, 404);
    return context.json(await store.listForAgent(agentId));
  });

}
