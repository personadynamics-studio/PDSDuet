import { COMPUTER_GUIDANCE } from "@openbot/shared/bot-prompt";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { createActorAgentResolver } from "./agents/agent-resolver";
import { createBotTools } from "./agents/bot-tools";
import { normalizeModelBaseUrls, runtimeModelForEnvironment } from "./agents/build";
import { createAgentProfileStore } from "./agents/profile-store";
import type { AgentActor } from "./agents/profile-types";
import { createRuntimeAgentLoader } from "./agents/runtime-agents";
import { createApp } from "./app";
import { auditSink, createAuditReader, createAuditStore, PERSON_INITIATOR } from "./audit";
import { createAuth } from "./auth";
import { DEV_ACTOR, initializeDevActorUser } from "./auth/dev-actor";
import type { OpenBotRole } from "./auth/roles";
import { roleForEmail } from "./auth/roles";
import { createIdentityProviderStore } from "./auth/identity-provider-store";
import { loadAttachmentForTurn, markAttachmentsSent } from "./channels/attachments";
import { createChannelEventHub, startChannelActivityListener } from "./channels/events";
import { createGroupConversations } from "./channels/group";
import { createChannelStore } from "./channels/routes";
import { headlessComponentCatalog } from "./components/headless";
import { createSandboxedStore } from "./components/sandboxed";
import { createComponentStore } from "./components/store";
import { createComputerGateway } from "./computer/gateway";
import { createHeadlessComputerTools } from "./computer/headless-tools";
import { createPolicyStore, DEFAULT_ACTION_POLICY } from "./computer/policy-store";
import { createComputerProvider } from "./computer/provider";
import { loadConfig } from "./config";
import { createCredentialAdminService, createCredentialStore, resolveModelApiKey } from "./credentials";
import { createDatabase } from "./db/client";
import { brokeredConnections, users } from "./db/schema";
import { createHostAccessBroker } from "./host-access/broker";
import { hostAccessTools } from "./host-access/tools";
import { startHttpServer } from "./http-server";
import { githubCallbackRoutes } from "./identity/github-callback";
import { retireIdentityLinks, retireOwnedAccounts } from "./identity/retire";
import { createIdentityStore } from "./identity/store";
import { reportModelAvailability } from "./model-availability-check";
import { buildMorningBrief, openduetTools } from "./openduet/brief";
import { createPageStore, pageTools } from "./openduet/pages";
import { replyTools } from "./openduet/replies";
import { createSetupSources } from "./openduet/setup";
import { createSignInService } from "./passwords/service";
import { createPasswordStore } from "./passwords/store";
import { createPeopleStore } from "./people/store";
import { createAccountModeSwitch } from "./plugins/account-mode";
import { providerDecision } from "./plugins/broker";
import { useArcadeClient } from "./plugins/arcade";
import { createArcadeClient } from "./plugins/arcade-adapter";
import { useComposioClient } from "./plugins/composio";
import { createComposioClient } from "./plugins/composio-adapter";
import { redirectUriFor } from "./plugins/oauth";
import { createSharedUseGate, createSharedUseStore } from "./plugins/shared-use-store";
import { selectProviderWiring, storedProvider, type ProviderWiring } from "./plugins/provider-wiring";
import { createPluginStore } from "./plugins/store";
import { grantedTools } from "./plugins/tools";
import { createProviderOAuthProxy } from "./provider-oauth";
import { createModelCompleter } from "./routing/model";
import { createExecution, type Execution } from "./runtime/execution";
import { createSettlement } from "./runtime/settlement";
import { createTeamBots } from "./team-bots/team-bots";
import { createPackageStatusReader, loadTenantPackage, synchronizeTenantPackage } from "./tenant-package";
import { createUserInstructionsStore } from "./user-instructions";
import { createUserPreferencesStore } from "./user-preferences";

const config = loadConfig();
const database = createDatabase(config.databaseUrl);
await initializeDevActorUser(database, config.singleUser);
const credentials = createCredentialStore(database);
const identity = createIdentityStore(database, credentials);
const vault = { store: credentials, reader: credentials, encryptionKey: config.keyEncryptionKey };
const profiles = createAgentProfileStore(database, vault);
const tenant = await loadTenantPackage(config.tenantPackageDirectory);
const channels = createChannelStore(database, profiles);
const channelEvents = createChannelEventHub();
const channelListener = await startChannelActivityListener(config.databaseUrl, channelEvents);
const loadAgents = createRuntimeAgentLoader(database, vault);
await synchronizeTenantPackage(database, tenant);
const audit = createAuditStore(database);
const people = createPeopleStore(database, config.auth?.initialAdminEmails ?? [], (userId, by) =>
  retireOwnedAccounts({
    plugins: () => plugins.retireConnectionsFor(userId, by),
    identities: () => retireIdentityLinks(database, credentials, executor => createAuditStore(executor), userId, by),
  }),
);
const auth = config.auth ? createAuth(config, database) : undefined;
const identityProviders = createIdentityProviderStore(database);

async function actorFor(id: string): Promise<AgentActor> {
  if (config.singleUser && id === DEV_ACTOR.id) return { id, role: DEV_ACTOR.role };
  const person = await people.find(id);
  if (!person || person.revoked) throw new Error("This person no longer has access.");
  return { id, role: person.role };
}
async function resolveRequestActor(request: Request): Promise<{ id: string; name: string; role: OpenBotRole }> {
  if (config.singleUser) return { id: DEV_ACTOR.id, name: DEV_ACTOR.email, role: DEV_ACTOR.role };
  const session = await auth?.api.getSession({ headers: request.headers });
  if (!session?.user) throw new Error("Sign in first.");
  return { id: session.user.id, name: session.user.name ?? session.user.email, role: roleForEmail(session.user.email, config.auth?.initialAdminEmails ?? []) };
}

const componentStore = createComponentStore(database);
const components = headlessComponentCatalog({ store: componentStore, audit: auditSink(audit) });
const computerProvider = config.computer ? createComputerProvider(config.computer) : undefined;
const computer = computerProvider ? createComputerGateway({ provider: computerProvider }) : undefined;
const passwords = computer ? createSignInService({
  store: createPasswordStore(database), gateway: computer, encryptionKey: config.keyEncryptionKey, auditStore: audit,
}) : undefined;

// Connector configuration affects connectors, never whether the browser can start.
let provider: ProviderWiring | undefined;
try {
  provider = selectProviderWiring(config, { composio: createComposioClient, arcade: createArcadeClient });
} catch (error) {
  console.error({ type: "connector-configuration-error", error: String(error) });
}
useComposioClient(provider?.install.composio ?? null);
useArcadeClient(provider?.install.arcade ?? null);
const composio = provider?.provider && provider.broker ? { broker: provider.broker, provider: provider.provider } : undefined;
const brokerProvider = storedProvider(providerDecision(config), (await database.selectDistinct({ provider: brokeredConnections.provider }).from(brokeredConnections)).map(row => row.provider));
const sharedUse = createSharedUseStore(database, brokerProvider);
const policy = createPolicyStore(DEFAULT_ACTION_POLICY, database);
await policy.load();
const plugins = createPluginStore({
  database, deploymentId: config.deploymentId ?? tenant.tenantId,
  auditStore: audit, credentials, encryptionKey: config.keyEncryptionKey,
  policy: () => policy.get(), sharedUse: createSharedUseGate(sharedUse, audit),
  redirectUri: config.publicUrl ? redirectUriFor(config.publicUrl) : undefined,
  broker: composio?.broker, brokerProvider,
});
const accountModes = createAccountModeSwitch({
  store: plugins, sharedUse,
  deploymentId: config.deploymentId ?? tenant.tenantId, audit,
});
const teamBots = createTeamBots({
  database,
  connectedServers: async userId => new Set([
    ...(await plugins.connectionsFor(userId)),
    ...(await plugins.brokeredConnectionsFor(userId)),
  ].map(connection => connection.serverId)),
});
const host = createHostAccessBroker();
const pages = createPageStore(database);
const instructions = createUserInstructionsStore(database);
normalizeModelBaseUrls();
const model = runtimeModelForEnvironment(tenant.model);
const modelKey = () => resolveModelApiKey({
  encryptionKey: config.keyEncryptionKey, reader: credentials, provider: model.provider,
  keyId: tenant.model.credentialSecretRef, environment: process.env,
});
const complete = createModelCompleter({ model, resolveApiKey: modelKey });

const settlement = createSettlement(database, { actorFor });
await settlement.initialize();
await settlement.listen(config.databaseUrl);
const resolver = createActorAgentResolver({
  loadAgents, model, resolveModelApiKey: modelKey,
  computerGuidance: computer ? COMPUTER_GUIDANCE : undefined,
  loadInstructionsForActor: actorId => () => instructions.read(actorId),
  loadAttachmentForActor: actorId => (id, threadId) => loadAttachmentForTurn(database, { actorId, threadId }, id),
  markAttachmentsSentForActor: actorId => (ids, threadId) => markAttachmentsSent(database, { actorId, threadId }, ids),
});
const execution: Execution = createExecution({
  settlement,
  createAgent: (actor, botId, initiator) => resolver.resolveAgentForActor(actor, botId, { initiator }),
  toolsForRun: async ({ actor, botId, threadId, runId, initiator = PERSON_INITIATOR }) => {
    const actorId = actor.id;
    const tools = [
      ...openduetTools({
        actorId, botId, initiator,
        person: async () => {
          const [person] = await database.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, actorId));
          return { name: person?.name ?? null, email: person?.email ?? null };
        },
        build: (input, signal) => buildMorningBrief({
          callTool: request => plugins.callTool({ ...request, signal }),
          complete: prompt => complete(prompt, signal), model: model.defaultModel,
        }, input),
      }),
      ...replyTools({ initiator }),
      ...pageTools({ initiator, get: id => pages.get(actorId, id), save: input => pages.save(actorId, botId, input) }),
      ...(await grantedTools({ store: plugins, botId, actorId, initiator, credentialActorFor: teamBots.credentialActorFor(actorId, botId) })),
      ...hostAccessTools({ broker: host, botId, actorId, auditStore: audit, initiator }),
      ...(await botTools({ actor, botId, threadId, runId, initiator })),
    ];
    return [
      ...(computer ? createHeadlessComputerTools({ gateway: computer, botId }) : []),
      ...tools.map(tool => ({
        definition: { name: tool.name, description: tool.description, parameters: z.toJSONSchema(tool.parameters) },
        execute: tool.execute,
      })),
      ...(await components.toolsForTurn({ ownerUserId: actorId, agentId: botId, initiator })),
    ];
  },
});
const botTools = createBotTools({ profiles, execution });
const groups = createGroupConversations({ database, channels, profiles, execution });
const githubCallback = config.githubApp && config.publicUrl ? githubCallbackRoutes({
  clientId: config.githubApp.clientId, clientSecret: config.githubApp.clientSecret,
  publicUrl: config.publicUrl, appUrl: config.appUrl, encryptionKey: config.keyEncryptionKey,
  personIsActive: async id => { const person = await people.find(id); return person !== undefined && !person.revoked; },
  credentials, identity, auditStore: audit,
}) : undefined;

const app = createApp(config, {
  auth, auditReader: createAuditReader(database),
  credentialService: createCredentialAdminService(config.keyEncryptionKey, credentials, audit),
  packageStatusReader: createPackageStatusReader(database),
  execution, settlement, computerGateway: computer, agentProfileStore: profiles,
  channelStore: channels, channelEvents, auditStore: audit, componentStore, pluginStore: plugins,
  sandboxedStore: createSandboxedStore(database, audit), peopleStore: people,
  identityProviders, userInstructions: instructions,
  attachmentDatabase: database, hostAccessBroker: host, desktopHostToken: process.env.OPENBOT_DESKTOP_HOST_TOKEN,
  composio,
  modelProviderProxy: process.env.OPENBOT_MODEL_OAUTH_FILE?.trim() ? createProviderOAuthProxy(process.env.OPENBOT_MODEL_OAUTH_FILE.trim()) : undefined,
  userPreferences: createUserPreferencesStore(database),
  coworker: {
    shared: { modes: accountModes, use: sharedUse },
    ...(passwords ? { passwords } : {}), groups, teamBots,
    openduet: {
      pages,
      setup: createSetupSources({
        productName: tenant.productName, config, environment: process.env,
        model: { provider: model.provider, keyId: tenant.model.credentialSecretRef, defaultModel: model.defaultModel, plan: Boolean(model.plan), check: () => reportModelAvailability({ provider: model.provider, model: model.defaultModel, apiKey: modelKey }) },
        credentials, plugins, computer: Boolean(computer),
        apps: { configured: Boolean(composio), provider: composio?.provider ?? config.brokerProvider ?? "composio" },
        chat: false,
      }),
    },
  },
  identity, identityGithubCallback: githubCallback,
});
const server = startHttpServer({
  port: config.port, config, resolveRequestActor, computerGateway: computer, app,
  canUseComputer: async (actor, botId) => (await profiles.get(actor, botId)) !== null,
});
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
  server.stop();
  void (async () => {
    let exitCode = 0;
    try {
      await execution.close();
    } catch (error) {
      exitCode = 1;
      console.error({ type: "execution-shutdown-failed", error: String(error) });
    } finally {
      const closed = await Promise.allSettled([settlement.close(), channelListener.stop()]);
      for (const result of closed) {
        if (result.status !== "rejected") continue;
        exitCode = 1;
        console.error({ type: "listener-shutdown-failed", error: String(result.reason) });
      }
      process.exit(exitCode);
    }
  })();
});
console.info(tenant.productName + " server listening on " + server.addresses.join(" and "));
