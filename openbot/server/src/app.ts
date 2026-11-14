import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { serveStatic } from "hono/bun";
import { MAX_ATTACHMENT_BYTES } from "@openbot/shared/attachments";
import type { AgentProfileStore } from "./agents/profile-store";
import { createAgentRoutes } from "./agents/routes";
import type { Execution } from "./runtime/execution";
import type { Settlement } from "./runtime/settlement";
import { createExecutionRoutes } from "./runtime/routes";
import {
  auditEventsToCsv,
  AuditQueryError,
  type AuditReader,
  type AuditStore,
  auditQueryFromUrl,
  readAuditExportRows,
  recordAuditEvent,
} from "./audit";
import { createDevRequireUser } from "./auth/dev-actor";
import {
  type AppVariables,
  type AuthService,
  createRequireUser,
} from "./auth/guards";
import type { IdentityProviderStore } from "./auth/identity-provider-store";
import {
  createAttachmentRoutes,
  createChannelAttachmentRoutes,
} from "./channels/attachments";
import type { ChannelEventHub } from "./channels/events";
import { createGroupRoutes, type GroupConversations } from "./channels/group";
import { type ChannelStore, createChannelRoutes } from "./channels/routes";
import { createComponentRoutes } from "./components/routes";
import type { SandboxedStore } from "./components/sandboxed";
import { createSandboxedRoutes } from "./components/sandboxed-routes";
import type { ComponentStore } from "./components/store";
import type { ComputerGateway } from "./computer/gateway";
import { createComputerRoutes } from "./computer/routes";
import { configuredAuthProviders, type DeploymentConfig } from "./config";
import {
  type CredentialAdminService,
  type CredentialInput,
  CredentialRefusedError,
} from "./credentials";
import type { Database } from "./db/client";
import { mountDesktopConnectionFailure } from "./desktop-connection-failure";
import { createTranscriptionProvider } from "./dictation/provider";
import { createDictationRoutes } from "./dictation/routes";
import type { HostAccessBroker } from "./host-access/broker";
import { createHostAccessRoutes } from "./host-access/routes";
import { identityRoutes } from "./identity/routes";
import type { IdentityStore } from "./identity/store";
import { parsePageLimit } from "./paging";
import { createPasswordRoutes, createSignInRoutes } from "./passwords/routes";
import type { SignInService } from "./passwords/service";
import { MAX_PAGE, type PeopleStore } from "./people/store";
import type { AccountModeSwitch } from "./plugins/account-mode";
import type { ComposioBroker } from "./plugins/broker";
import type { BrokerProvider } from "./plugins/access";
import { createPluginRoutes } from "./plugins/routes";
import { createSharedUseRoutes } from "./plugins/shared-use-routes";
import type { SharedUseStore } from "./plugins/shared-use-store";
import type { PluginStore } from "./plugins/store";
import { createPageRoutes, type PageStore } from "./openduet/pages";
import { createSetupRoutes, type SetupSources } from "./openduet/setup";
import {
  type ModelProviderProxy,
  mountProviderOAuthProxy,
} from "./provider-oauth";
import { createTeamBotRoutes } from "./team-bots/routes";
import type { TeamBots } from "./team-bots/team-bots";
import type { PackageStatusReader } from "./tenant-package";
import {
  INSTRUCTIONS_LIMIT,
  InstructionsTooLongError,
  type UserInstructionsStore,
} from "./user-instructions";
import type { UserPreferencesStore } from "./user-preferences";
import { userPreferencesRoutes } from "./user-preferences-routes";
import { createVoiceProvider } from "./voice/provider";
import { createVoiceRoutes } from "./voice/routes";

/**
 * How much of a multipart body is boundary, headers and other fields rather than file.
 *
 * Generous on purpose. Measured against what the composer actually sends — one `file` part and one
 * `uploadGroup` field — the framing is 360 bytes for a short filename and 614 for a 255-character
 * one; a filename full of non-ASCII percent-encodes to a few times that and is still nowhere near
 * this. 64 KiB is therefore an allowance no honest request can exhaust, and it raises the amount of
 * memory a hostile request can pin by 0.8%, which was never the number that mattered.
 */
const MULTIPART_FRAMING_ALLOWANCE = 64 * 1024;

/**
 * The ceiling on the whole POST body of a channel attachment upload.
 *
 * THIS IS NOT `MAX_ATTACHMENT_BYTES`, AND THE DIFFERENCE IS THE POINT. Every other gate on this path —
 * the composer's pre-check, `attachmentsConfigFor`'s `maxSize`, the handler's own 413 — measures
 * THE FILE. This one measures THE ENVELOPE: `bodyLimit` runs before anything has parsed the
 * multipart body, so all it can count is bytes on the wire, file and framing together.
 *
 * The largest supported file needs room for multipart boundaries and headers as well, so the
 * envelope's ceiling is the file's ceiling plus room for the envelope.
 *
 * The slack costs nothing it was protecting against. A body between the two numbers is still read
 * into memory, and then still refused by the handler once `file.size` is a thing anybody can look
 * at — which is where a text upload, whose real limit is `MAX_FILE_BYTES`, is refused too. What the
 * door exists to stop is the 2GB body, and it still does.
 */
export const UPLOAD_BODY_LIMIT_BYTES =
  MAX_ATTACHMENT_BYTES + MULTIPART_FRAMING_ALLOWANCE;

/**
 * One row for something an administrator did to somebody's access.
 *
 * The address is on the row rather than only the user id, because the id means nothing to a person
 * reading the trail a year later and the user row may be gone by then.
 */
async function recordPersonEvent(
  auditStore: AuditStore | undefined,
  context: { var: AppVariables },
  eventType:
    | "person.role_changed"
    | "person.access_revoked"
    | "person.access_restored",
  person: { id: string; email: string },
  payload: Record<string, unknown>,
) {
  if (!auditStore) return;
  await recordAuditEvent(auditStore, {
    eventType,
    targetType: "person",
    targetId: person.id,
    actorUserId: context.var.actor.id,
    payload: { email: person.email, ...payload },
  });
}

export function createApp(
  config: DeploymentConfig,
  services: {
  auth?: AuthService,
  auditReader?: AuditReader,
  credentialService?: CredentialAdminService,
  packageStatusReader?: PackageStatusReader,
  execution?: Execution,
  settlement?: Settlement,
  computerGateway?: ComputerGateway,
  agentProfileStore?: AgentProfileStore,
  channelStore?: ChannelStore,
  channelEvents?: ChannelEventHub,
  auditStore?: AuditStore,
  componentStore?: ComponentStore,
  pluginStore?: PluginStore,
  sandboxedStore?: SandboxedStore,
  peopleStore?: PeopleStore,
  identityProviders?: IdentityProviderStore,
  userInstructions?: UserInstructionsStore,
  attachmentDatabase?: Database,
  hostAccessBroker?: HostAccessBroker,
  desktopHostToken?: string,
  composio?: { broker: ComposioBroker; provider: BrokerProvider },
  modelProviderProxy?: ModelProviderProxy,
  userPreferences?: UserPreferencesStore,
  coworker?: {
    shared?: { modes: AccountModeSwitch; use: SharedUseStore };
    passwords?: SignInService;
    groups?: GroupConversations;
    teamBots?: TeamBots;
    openduet?: {
      pages: PageStore;
      setup?: SetupSources;
    };
  },
  
  identity?: IdentityStore,
  
  identityGithubCallback?: Hono<{ Variables: AppVariables }>,
  },
) {
  const {auth,auditReader,credentialService,packageStatusReader,execution,settlement,computerGateway,agentProfileStore,channelStore,channelEvents,auditStore,componentStore,pluginStore,sandboxedStore,peopleStore,identityProviders,userInstructions,attachmentDatabase,hostAccessBroker,desktopHostToken,composio,modelProviderProxy,userPreferences,coworker,identity,identityGithubCallback} = services;
  const app = new Hono<{ Variables: AppVariables }>();
  mountDesktopConnectionFailure(app, desktopHostToken);
  mountProviderOAuthProxy(app, modelProviderProxy);

  app.get("/health", (context) => context.json({ status: "ok" }));
  // Expose only the local runtime capabilities and configured application features.
  app.get("/api/capabilities", async (context) =>
    context.json({
      mode: config.runtime.mode,
      durableHistory: config.runtime.durableHistory,
      localEvaluation: config.singleUser,
      transcription: Boolean(config.transcription),
      voice: Boolean(config.voice),
      /*
       * Which identity providers this deployment can sign somebody in with.
       *
       * Ids only, never the credentials: `configuredAuthProviders` returns names, and the clients
       * and secrets behind them stay in `config.auth`, which is not projected here.
       *
       * Answered at runtime rather than baked into the build, because the container image is built
       * once and knows nothing about the deployment that will run it. A sign-in screen compiled on a
       * build machine cannot offer a provider that machine had never heard of.
       */
      authProviders: configuredAuthProviders(config.auth),
      /*
       * Whether any enterprise identity provider has been registered.
       *
       * A count, not a list. The sign-in screen only needs to know whether to offer the email box
       * that routes by domain; naming the providers would tell anybody who loads the page which
       * companies use this deployment, which is not theirs to have before they sign in.
       */
      ssoConfigured: ((await identityProviders?.list()) ?? []).length > 0,

    }),
  );
  app.on(["GET", "POST"], "/api/auth/*", (context) => auth
    ? auth.handler(context.req.raw)
    : context.json({ error: "No identity provider is configured." }, 503));

  const authenticationUnavailable: MiddlewareHandler<{
    Variables: AppVariables;
  }> = async (context) =>
    context.json({ error: "No identity provider is configured." }, 503);
  // One administrator, when nothing is configured to sign anybody in. Checked first, and only ever
  // true when there is no provider, so a configured deployment cannot fall back to it.
  const requireUser = config.singleUser
    ? createDevRequireUser()
    : auth
      ? createRequireUser(auth, config.auth?.initialAdminEmails ?? [])
      : authenticationUnavailable;
  const requireComputer: MiddlewareHandler<{ Variables: AppVariables }> = async (context, next) =>
    requireUser(context, async () => {
      const botId = context.req.param("botId");
      if (botId && (!agentProfileStore || !(await agentProfileStore.get(context.var.actor, botId)))) {
        context.res = context.json({ error: "Computer not found." }, 404);
        return;
      }
      await next();
    });

  app.on(["PUT", "PATCH", "DELETE"], "/api/auth/scim/*", (context) =>
    auth
      ? auth.handler(context.req.raw)
      : context.json({ error: "No identity provider is configured." }, 503),
  );

  app.route(
    "/api/audio",
    createDictationRoutes(
      requireUser,
      config.transcription
        ? createTranscriptionProvider(config.transcription)
        : undefined,
    ),
  );
  app.route(
    "/api/voice",
    createVoiceRoutes(
      requireUser,
      config.voice ? createVoiceProvider(config.voice) : undefined,
      channelStore,
      agentProfileStore,
    ),
  );

  app.get("/api/me", requireUser, (context) =>
    context.json({ user: context.var.actor }),
  );
  /*
   * A person's own standing instructions, read and written by the person they belong to.
   *
   * `requireUser` and never `requireAdmin`, and scoped to `context.var.actor.id` rather than to
   * anything in the path or the body. There is deliberately no route here for reading somebody
   * else's or writing on their behalf: these instructions go into a prompt that then speaks as that
   * person's coworker, so a way to set them for another account would be a way to put words in
   * somebody's mouth in every channel they work in. An administrator has no business here either,
   * for the same reason.
   */
  app.route(
    "/api/settings/preferences",
    userPreferencesRoutes(requireUser, userPreferences),
  );

  /*
   * The session must match the sealed state's person, otherwise a link started by one person could
   * attach another person's GitHub account (login CSRF), so the callback requires the same session
   * as the rest of /api/identity; a missing session answers 401 rather than a redirect. Mounted
   * before the identity router so that router never sees a GET to this path; other methods fall
   * through to it and get its own 401/404.
   */
  if (identityGithubCallback) {
    app.use("/api/identity/github/callback", requireUser);
    app.route("/api/identity/github/callback", identityGithubCallback);
  }
  /*
   * A person's own linked accounts at outside providers (Slack, GitHub). Theirs alone: there is no
   * administrator view and no linking on somebody else's behalf. A provider is offered only when
   * its return path is wired: Slack needs the identity redeemer for the codes it issues, and GitHub
   * needs the callback mounted above, otherwise people would be sent away and back to nothing.
   */
  app.route(
    "/api/identity",
    identityRoutes(requireUser, identity, auditStore, {
      slackLinking: false,
      github:
        identityGithubCallback && config.githubApp && config.publicUrl
          ? {
              clientId: config.githubApp.clientId,
              publicUrl: config.publicUrl,
              encryptionKey: config.keyEncryptionKey,
            }
          : undefined,
    }),
  );

  app.get("/api/settings/instructions", requireUser, async (context) => {
    if (!userInstructions) {
      return context.json(
        { error: "Standing instructions are not available." },
        503,
      );
    }

    return context.json({
      // "" is what having written none looks like to a text box, and the store's null is what it
      // looks like to a database. The translation happens once, here.
      instructions: (await userInstructions.read(context.var.actor.id)) ?? "",
    });
  });
  app.put("/api/settings/instructions", requireUser, async (context) => {
    if (!userInstructions) {
      return context.json(
        { error: "Standing instructions are not available." },
        503,
      );
    }

    const body = (await context.req.json().catch(() => undefined)) as
      | { instructions?: unknown }
      | undefined;

    if (typeof body?.instructions !== "string") {
      return context.json({ error: "Send the instructions to save." }, 400);
    }

    /*
     * The cap is the store's rule, so the store is what enforces it and this catches the refusal
     * rather than checking the length again. A second copy of `> 4000` here is a second place for
     * the number to be changed in only one of them.
     */
    let saved: string;
    try {
      saved = await userInstructions.write(
        context.var.actor.id,
        body.instructions,
      );
    } catch (error) {
      if (error instanceof InstructionsTooLongError) {
        return context.json({ error: error.message }, 400);
      }
      throw error;
    }

    /*
     * The trail records that they changed and how long they now are, NEVER what they say.
     *
     * The audit table is append-only and read by administrators, and this is a person's own note
     * about how they want to be spoken to. Recording the text would put it somewhere they cannot
     * edit it and somebody else can read it, which is not what a preferences screen promises. The
     * length is enough to answer the question a trail is for: when did this change, and to what
     * extent.
     */
    if (auditStore) {
      await recordAuditEvent(auditStore, {
        eventType: "configuration.changed",
        targetType: "user_instructions",
        targetId: context.var.actor.id,
        actorUserId: context.var.actor.id,
        payload: {
          change: saved === "" ? "instructions_cleared" : "instructions_saved",
          characters: saved.length,
          limit: INSTRUCTIONS_LIMIT,
        },
      });
    }

    return context.json({ instructions: saved });
  });
  app.get("/api/admin/status", requireUser, (context) => {
    return context.json({ status: "ok" });
  });
  app.get("/api/admin/audit-events", requireUser, async (context) => {
    if (!auditReader) {
      return context.json({ error: "Audit logging is not configured." }, 503);
    }

    try {
      const url = new URL(context.req.url);
      const format = url.searchParams.get("format");
      if (
        format !== null &&
        format !== "" &&
        format !== "json" &&
        format !== "csv"
      ) {
        return context.json(
          { error: 'Query parameter "format" must be "json" or "csv".' },
          400,
        );
      }
      /*
       * The export answers the same filtered query as the list — `eventType`,
       * `actorUserId`, `initiatorKind`, `targetType`, `targetId`, `from`, `to` — so the
       * downloaded file and the table agree. Paging (`cursor`, `limit`) belongs to the
       * JSON list and is ignored here; the export walks every matching page up to the
       * cap in `readAuditExportRows` and names the file after the day it was pulled.
       */
      if (format === "csv") {
        const query = auditQueryFromUrl(url);
        const { events, truncated } = await readAuditExportRows(
          auditReader,
          query,
        );
        if (auditStore) {
          const { cursor: _cursor, limit: _limit, ...filters } = query;
          await recordAuditEvent(auditStore, {
            eventType: "audit.exported",
            targetType: "audit_trail",
            actorUserId: context.var.actor.id,
            payload: { format: "csv", rows: events.length, truncated, filters },
          });
        }
        const day = new Date().toISOString().slice(0, 10);
        context.header("Content-Type", "text/csv; charset=utf-8");
        context.header(
          "Content-Disposition",
          `attachment; filename="audit-events-${day}.csv"`,
        );
        // The row count it stopped at, so the page can say how much the file holds.
        if (truncated) {
          context.header("X-Audit-Export-Truncated", String(events.length));
        }
        return context.body(auditEventsToCsv(events));
      }
      return context.json(await auditReader.list(auditQueryFromUrl(url)));
    } catch (error) {
      if (error instanceof AuditQueryError) {
        return context.json({ error: error.message }, 400);
      }
      throw error;
    }
  });
  /*
   * Who is here, and what they may do.
   *
   * Available to signed-in users, like the other routes in this group.
   */
  app.get("/api/admin/people", requireUser, async (context) => {
    if (!peopleStore) {
      return context.json({ error: "People are not available." }, 503);
    }

    /*
     * A page, not the deployment.
     *
     * `limit` is parsed strictly and clamped into range at the edge, against the same ceiling the
     * store enforces, so a caller cannot ask for everybody by naming a large number and a typo
     * like `12abc` is a 400 rather than a silently coerced page. `search` is what makes paging
     * usable: an administrator looking for one colleague should not have to walk pages to reach
     * them.
     */
    const url = new URL(context.req.url);
    const parsed = parsePageLimit(url.searchParams.get("limit"), MAX_PAGE);
    if (!parsed.ok) {
      return context.json({ error: parsed.error }, 400);
    }
    // An unbounded `search` becomes a `%...% ILIKE` full scan. Cap it so a multi-megabyte
    // query cannot be used as a cheap denial of service against the people table.
    const search = url.searchParams.get("search");
    if (search !== null && search.length > 200) {
      return context.json(
        { error: "A search of at most 200 characters is required." },
        400,
      );
    }

    return context.json(
      await peopleStore.list({
        ...(url.searchParams.get("search")
          ? { search: url.searchParams.get("search") as string }
          : {}),
        ...(url.searchParams.get("cursor")
          ? { cursor: url.searchParams.get("cursor") as string }
          : {}),
        ...(parsed.limit !== undefined ? { limit: parsed.limit } : {}),
      }),
    );
  });

  app.post("/api/admin/people/:userId/role", requireUser, async (context) => {
    if (!peopleStore) {
      return context.json({ error: "People are not available." }, 503);
    }

    const body = await context.req.json().catch(() => null);
    const role = (body as { role?: unknown } | null)?.role;
    if (role !== "admin" && role !== "user") {
      return context.json(
        { error: "A role of admin or user is required." },
        400,
      );
    }

    const userId = context.req.param("userId");
    const person = await peopleStore.find(userId);
    if (!person) {
      return context.json({ error: "That person is not here." }, 404);
    }

    /*
     * The configured floor wins over the screen.
     *
     * Somebody named in INITIAL_ADMIN_EMAILS is promoted again at their next sign-in whatever this
     * route writes, so allowing the demotion would produce a screen that lies until they come back.
     * Refusing says the real thing: change the deployment's configuration.
     */
    if (person.configuredAdmin && role !== "admin") {
      return context.json(
        {
          error:
            "This deployment names that address in INITIAL_ADMIN_EMAILS, so they stay an administrator. Change the configuration instead.",
        },
        409,
      );
    }

    /*
     * Nobody demotes themselves.
     *
     * An administrator who does has just locked themselves out of the screen that would undo it,
     * and on a deployment with one administrator that is the whole deployment. Somebody else with
     * the role can do it, which is the check that makes handover possible without making lockout
     * a slip of the finger.
     */
    if (context.var.actor.id === userId && role !== "admin") {
      return context.json(
        { error: "You can't remove your own admin role." },
        409,
      );
    }

    if (person.role !== role) {
      await peopleStore.setRole(userId, role);
      await recordPersonEvent(
        auditStore,
        context,
        "person.role_changed",
        person,
        {
          from: person.role,
          to: role,
        },
      );
    }

    return context.json({ person: await peopleStore.find(userId) });
  });

  app.post("/api/admin/people/:userId/access", requireUser, async (context) => {
    if (!peopleStore) {
      return context.json({ error: "People are not available." }, 503);
    }

    const body = await context.req.json().catch(() => null);
    const revoked = (body as { revoked?: unknown } | null)?.revoked;
    if (typeof revoked !== "boolean") {
      return context.json({ error: "revoked must be true or false." }, 400);
    }

    const userId = context.req.param("userId");
    const person = await peopleStore.find(userId);
    if (!person) {
      return context.json({ error: "That person is not here." }, 404);
    }

    // The same floor, for the same reason: removing somebody the configuration names would last
    // until their next sign-in and no longer.
    if (person.configuredAdmin && revoked) {
      return context.json(
        {
          error:
            "This deployment names that address in INITIAL_ADMIN_EMAILS, so they cannot be removed here. Change the configuration instead.",
        },
        409,
      );
    }

    // Nobody can remove themselves. An administrator who does has locked themselves out of the
    // screen that would undo it.
    if (revoked && context.var.actor.id === userId) {
      return context.json({ error: "You cannot remove your own access." }, 409);
    }

    if (person.revoked !== revoked) {
      if (revoked) {
        await peopleStore.revoke(userId, context.var.actor.id);
      } else {
        await peopleStore.restore(userId);
      }
      await recordPersonEvent(
        auditStore,
        context,
        revoked ? "person.access_revoked" : "person.access_restored",
        person,
        {},
      );
    }

    if (revoked) {
      await peopleStore.retireOwned(userId, context.var.actor.id);
    }

    return context.json({ person: await peopleStore.find(userId) });
  });

  /*
   * The identity providers this deployment has registered.
   *
   * Not Better Auth's own `GET /sso/providers`, which answers with the ones the person asking
   * registered themselves. Two administrators therefore saw two different deployments: the second
   * one to open this screen found it empty and registered a provider that was already there. What is
   * registered is a fact about the deployment, so every administrator sees the same list.
   */
  app.get("/api/admin/identity-providers", requireUser, async (context) => {
    if (!identityProviders) {
      return context.json(
        { error: "Identity providers are not available." },
        503,
      );
    }

    return context.json({ providers: await identityProviders.list() });
  });

  /*
   * Remove one.
   *
   * Ours rather than Better Auth's `delete-provider`, which refuses unless the person asking is the
   * one who registered it. That leaves a provider nobody can remove as soon as the administrator who
   * set it up has left, which is the same moment somebody most needs to.
   */
  app.delete(
    "/api/admin/identity-providers/:providerId",
    requireUser,
    async (context) => {
      if (!identityProviders) {
        return context.json(
          { error: "Identity providers are not available." },
          503,
        );
      }

      const providerId = context.req.param("providerId");
      const removed = await identityProviders.remove(providerId);
      if (!removed) {
        // A screen somebody left open, or two administrators removing the same one. Saying so beats
        // reporting success for something that was not there.
        return context.json({ error: "There is no such provider." }, 404);
      }

      if (auditStore) {
        await recordAuditEvent(auditStore, {
          eventType: "identity_provider.removed",
          targetType: "identity_provider",
          targetId: providerId,
          actorUserId: context.var.actor.id,
          payload: { removedBy: context.var.actor.email },
        });
      }

      return context.json({ removed: true });
    },
  );

  app.get("/api/admin/credentials", requireUser, async (context) => {
    if (!credentialService) {
      return context.json(
        { error: "Credential storage is not configured." },
        503,
      );
    }

    return context.json({ credentials: await credentialService.list() });
  });
  app.post("/api/admin/credentials", requireUser, async (context) => {
    if (!credentialService) {
      return context.json(
        { error: "Credential storage is not configured." },
        503,
      );
    }

    const body = await context.req.json().catch(() => null);
    const input = credentialInput(body, context.var.actor.id);
    if (!input) {
      return context.json({ error: "Credential input is invalid." }, 400);
    }

    return context.json(
      { credential: await credentialService.create(input) },
      201,
    );
  });
  app.post(
    "/api/admin/credentials/:credentialId/rotate",
    requireUser,
    async (context) => {
      if (!credentialService) {
        return context.json(
          { error: "Credential storage is not configured." },
          503,
        );
      }

      const body = await context.req.json().catch(() => null);
      const input = credentialInput(body, context.var.actor.id);
      if (!input) {
        return context.json({ error: "Credential input is invalid." }, 400);
      }

      try {
        return context.json({
          credential: await credentialService.rotate({
            ...input,
            previousCredentialId: context.req.param("credentialId"),
          }),
        });
      } catch (error) {
        if (error instanceof CredentialRefusedError) {
          return context.json({ error: error.message }, error.status);
        }
        throw error;
      }
    },
  );
  app.post(
    "/api/admin/credentials/:credentialId/revoke",
    requireUser,
    async (context) => {
      if (!credentialService) {
        return context.json(
          { error: "Credential storage is not configured." },
          503,
        );
      }

      try {
        return context.json({
          credential: await credentialService.revoke(
            context.req.param("credentialId"),
            context.var.actor.id,
          ),
        });
      } catch (error) {
        // Not found or already revoked: the second click on Revoke, answered as what it is.
        if (error instanceof CredentialRefusedError) {
          return context.json({ error: error.message }, error.status);
        }
        throw error;
      }
    },
  );
  app.get("/api/admin/package", requireUser, async (context) => {
    if (!packageStatusReader) {
      return context.json({ error: "Tenant package is not configured." }, 503);
    }
    return context.json({ package: await packageStatusReader.active() });
  });
  if (execution && settlement) app.route("/api/threads", createExecutionRoutes({ execution, settlement, requireUser }));

  if (computerGateway) {
    app.route("/api/computers", createComputerRoutes(computerGateway, requireComputer,
      async actor => agentProfileStore ? (await agentProfileStore.list(actor)).map(bot => bot.id) : []));
  }

  if (hostAccessBroker) {
    app.route(
      "/api/host-access",
      createHostAccessRoutes({
        broker: hostAccessBroker,
        desktopToken: desktopHostToken,
        requireUser,
        auditStore,
        botName: agentProfileStore
          ? async (botId, actor) =>
              (await agentProfileStore.get(actor, botId))?.name ?? null
          : undefined,
      }),
    );
  }

  if (agentProfileStore) {
    app.route(
      "/api/agents",
      createAgentRoutes(
        agentProfileStore,
        requireUser,
        // A Bot's own refusal goes in the same trail as everything else it does.
        auditStore,
        coworker?.shared?.use,
      ),
    );
  }

  if (channelStore) {
    app.route(
      "/api/channels",
      createChannelRoutes(
        channelStore,
        requireUser,
        channelEvents,
        auditStore,
      ),
    );
  }

  if (attachmentDatabase) {
    const channelAttachments = new Hono<{ Variables: AppVariables }>();
    channelAttachments.use(
      "*",
      bodyLimit({
        maxSize: UPLOAD_BODY_LIMIT_BYTES,
      }),
    );
    channelAttachments.route(
      "/",
      createChannelAttachmentRoutes(attachmentDatabase, requireUser),
    );
    app.route("/api/channels", channelAttachments);

    app.route(
      "/api/attachments",
      createAttachmentRoutes(attachmentDatabase, requireUser),
    );
  }

  if (coworker?.groups)
    app.route("/api/groups", createGroupRoutes(coworker.groups, requireUser));
  if (coworker?.teamBots)
    app.route(
      "/api/team-bots",
      createTeamBotRoutes(coworker.teamBots, requireUser, coworker.shared?.use),
    );
  /*
   * BEFORE `/api/approvals`, which would otherwise take every path under it and answer 404 for
   * these. Needs the trail as well as the store: approving a Bot's use of a team account is a
   * decision somebody must be able to find later.
   */
  if (coworker?.shared && auditStore)
    app.route(
      "/api/approvals/shared-use",
      createSharedUseRoutes(coworker.shared.use, requireUser, auditStore),
    );
  if (coworker?.passwords) {
    app.route(
      "/api/sign-in-requests",
      createSignInRoutes(
        coworker.passwords,
        requireUser,
      ),
    );
    app.route(
      "/api/passwords",
      createPasswordRoutes(coworker.passwords, requireUser),
    );
  }
  if (coworker?.openduet)
    app.route(
      "/api/openduet/pages",
      createPageRoutes(coworker.openduet.pages, requireUser),
    );
  /*
   * Signed in, unlike `/api/capabilities`, which anybody can read. The checklist names what this
   * deployment has and lacks, and for an admin which variables would close a gap, which is not a
   * visitor's to have before they sign in.
   */
  if (coworker?.openduet?.setup)
    app.route(
      "/api/openduet/setup",
      createSetupRoutes(coworker.openduet.setup, requireUser),
    );
  if (componentStore) {
    app.route(
      "/api/components",
      createComponentRoutes(
        componentStore,
        requireUser,
        auditStore,
        sandboxedStore,
      ),
    );
  }

  if (pluginStore) {
    app.route(
      "/api/plugins",
      createPluginRoutes(
        pluginStore,
        requireUser,
        {
          encryptionKey: config.keyEncryptionKey,
          /*
           * Whether the person a consent was started for still has access, asked when the callback
           * lands rather than when the flow began.
           *
           * The callback carries no session — identity comes from the state — so this is where the
           * question gets asked at all. `find` answers both halves of it: no row means a user id that
           * names nobody, and `revoked` means an administrator removed them while they were away at
           * the vendor. Either way there is no live person for a fresh refresh token to belong to.
           *
           * No people store means this deployment cannot answer the question, so it refuses rather
           * than assuming yes. It also cannot remove anybody, which is exactly why guessing here
           * would be a hole nothing else closes.
           */
          personHasAccess: async (userId) => {
            if (!peopleStore) return false;
            const person = await peopleStore.find(userId);
            return person !== undefined && !person.revoked;
          },
          publicUrl: config.publicUrl,
          appUrl: config.appUrl,
        },
        composio,
        coworker?.shared,
      ),
    );
  }

  if (sandboxedStore) {
    app.route(
      "/api/sandboxed",
      createSandboxedRoutes(sandboxedStore, requireUser),
    );
  }

  /*
   * The built app, served by the API that serves it.
   *
   * WHY THE SAME PROCESS. There is no CORS anywhere in this server, deliberately, so the app has to
   * reach `/api` on its own origin. Two containers behind one ingress does that too, and costs a
   * path rule on every deployment plus a way for the two to disagree about which host they are on.
   * One process cannot disagree with itself.
   *
   * MOUNTED LAST, so every `/api` route above already claimed its path. The catch-all below would
   * otherwise answer an unmatched `/api` call with the app's HTML, which is the failure that reads
   * as "the API returned HTML" and takes an hour to place.
   *
   * Absent in development: Vite serves the app and proxies `/api` here, so `APP_DIST_DIR` is unset
   * and none of this mounts.
   */
  if (config.appDistDir) {
    const root = config.appDistDir;
    app.use("/*", serveStatic({ root }));
    /*
     * A single-page app owns its routing, so a path with no file behind it is not missing: it is a
     * route the browser resolves once index.html has loaded. Without this, every deep link and every
     * refresh away from `/` is a 404, which is the classic way this deployment shape breaks.
     *
     * Written out rather than a second `serveStatic`, whose `path` option is resolved relative to the
     * working directory and silently matches nothing when handed the absolute root used above.
     *
     * `/api` is excluded so an unmatched API route still answers as one. Returning the app's HTML to
     * a fetch that expected JSON is the failure that gets read as "the API returned HTML".
     */
    app.get("*", async (context) => {
      if (context.req.path.startsWith("/api")) return context.notFound();
      const index = Bun.file(`${root}/index.html`);
      if (!(await index.exists())) return context.notFound();
      return new Response(index, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    });
  }

  return app;
}

function credentialInput(
  value: unknown,
  actorUserId: string,
): CredentialInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const body = value as Record<string, unknown>;
  /*
   * An allowlist, and deliberately narrower than `CredentialKind`.
   *
   * `CredentialKind` is derived from the schema enum, so it now includes `mcp_oauth_client` and
   * `mcp_user_token`. Neither belongs here. A user token is somebody's own grant and exists only as
   * the outcome of a consent they gave; a client is registered when a connector is added. Both are
   * written by the code that owns those flows, and an administrator hand-posting either would be
   * creating a credential attributed to a person who never agreed to it.
   *
   * So this list is not out of date with the enum — do not widen it to match.
   */
  if (
    (body.kind !== "model" &&
      body.kind !== "connector" &&
      body.kind !== "mcp") ||
    typeof body.provider !== "string" ||
    !body.provider.trim() ||
    typeof body.keyId !== "string" ||
    !body.keyId.trim() ||
    typeof body.plaintext !== "string" ||
    !body.plaintext ||
    !body.metadata ||
    typeof body.metadata !== "object" ||
    Array.isArray(body.metadata) ||
    Object.getPrototypeOf(body.metadata) !== Object.prototype
  ) {
    return null;
  }

  return {
    kind: body.kind,
    provider: body.provider.trim(),
    keyId: body.keyId.trim(),
    metadata: body.metadata as Record<string, unknown>,
    plaintext: body.plaintext,
    actorUserId,
  };
}
