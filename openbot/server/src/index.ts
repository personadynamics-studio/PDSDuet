import type { AbstractAgent } from "@ag-ui/client";
import { COMPUTER_GUIDANCE } from "@openbot/shared/bot-prompt";
import { workOwner } from "@openbot/shared/work-owner";
import { createTurnRunner } from "@openbot/toolkit/run-turn";
import { createLocalRuntime } from "./runtime/local-runtime";
import { LocalAgentRunner } from "./runtime/local-runner";
import { createLocalThreadStore } from "./runtime/thread-store";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { createActivityStore } from "./activity/activity";
import {
  auditRoutineStore,
  enterpriseControls,
  guardDeliveryStore,
  guardHostAccess,
  installEnterpriseControls,
} from "./admin/controls";
import {
  CoworkerUnavailableError,
  createActorAgentResolver,
} from "./agents/agent-resolver";
import {
  mintRunAssertion,
  type RunAssertion,
  readApprovedRunAssertion,
  readRunAssertion,
} from "./agents/callback-token";
import { wireCoordination } from "./agents/coordination-wiring";
import { createHandoffDesk } from "./agents/handoff";
import type { ToolExecutionContext } from "@openbot/toolkit/granted-tool";
import { startHandoffDelivery } from "./agents/handoff-wiring";
import {
  configureBotLifecycle,
  createBotLifecycleStore,
} from "./agents/lifecycle";
import { createBotReset } from "./agents/lifecycle-reset";
import { createAgentProfileStore } from "./agents/profile-store";
import type { AgentActor } from "./agents/profile-types";
import { createRuntimeAgentLoader } from "./agents/runtime-agents";
import { serverTurnAdmission } from "./agents/turn-admission";
import {
  createWakeUpRunner,
  createWakeUpStore,
  wakeUpTools,
} from "./agents/wake-up";
import { createApp } from "./app";
import { createApprovedActionExecutor } from "./approvals/execute";
import { createPersonResponseTick } from "./approvals/person-response-sweep";
import {
  type PersonQuestion,
  questionConversationBot,
} from "./approvals/questions";
import { signallingBusy } from "./approvals/busy-runner";
import { createApprovalResumeTick } from "./approvals/resume-sweep";
import { createApprovalStore } from "./approvals/store";
import { ApprovalRefusedError } from "./approvals/types";
import { createServerApprovalService } from "./approvals/wiring";
import {
  type AuditInitiator,
  auditSink,
  createAuditReader,
  createAuditStore,
  DEPLOYMENT_INITIATOR,
  PERSON_INITIATOR,
  recordAuditEvent,
} from "./audit";
import { startRetentionSweeps } from "./audit-retention";
import { createAuth } from "./auth";
import { DEV_ACTOR, initializeDevActorUser } from "./auth/dev-actor";
import type { AuthService } from "./auth/guards";
import { createIdentityProviderStore } from "./auth/identity-provider-store";
import { roleForEmail, type OpenBotRole } from "./auth/roles";
import {
  loadAttachmentForTurn,
  markAttachmentsSent,
} from "./channels/attachments";
import {
  createChannelEventHub,
  startChannelActivityListener,
} from "./channels/events";
import {
  createGroupConversations,
  createGroupStore,
  groupSourceForRun,
} from "./channels/group";
import {
  type ChannelStore,
  createChannelStore,
  expireChannelBusyClaims,
} from "./channels/routes";
import { createStallGuard } from "./channels/stall-guard";
import {
  forgetSettledSummaries,
  offerChannelsAwaitingSummary,
  summariseClaimedChannels,
} from "./channels/summary";
import { createThreadIdentity } from "./channels/thread-identity";
import { createChannelTitler } from "./channels/titler";
import { headlessComponentCatalog } from "./components/headless";
import { createSandboxedStore } from "./components/sandboxed";
import { createComponentStore } from "./components/store";
import { createComputerGateway } from "./computer/gateway";
import { createHeadlessComputerTools } from "./computer/headless-tools";
import { createPageFrameStore } from "./computer/page-frames";
import { startPolicyListener } from "./computer/policy-listener";
import {
  createPolicyStore,
  DEFAULT_ACTION_POLICY,
} from "./computer/policy-store";
import {
  createComputerProvider,
  describeComputerIsolation,
} from "./computer/provider";
import { loadConfig } from "./config";
import {
  type IdentifyActor,
  normalizeModelBaseUrls,
  runtimeModelForEnvironment,
  type ToolSelection,
} from "./agents/build";
import {
  createCredentialAdminService,
  createCredentialStore,
  resolveModelApiKey,
} from "./credentials";
import { createDatabase } from "./db/client";
import {
  brokeredConnections,
  channelAgents,
  channelMemberships,
  channels,
  threadChannelMappings,
} from "./db/schema";
import { createDeliveryRouter, DELIVERY_WORK_KINDS } from "./delivery/router";
import {
  configuredDeliveryProviders,
  type DeliveryScopeResolver,
} from "./delivery/routes";
import { createDeliveryStore } from "./delivery/store";
import type { DeliveryScope } from "./delivery/types";
import { DeliveryRefusedError } from "./delivery/types";
import { createDemonstrationRecorder } from "./demonstrations/recording";
import { createDemonstrationStore } from "./demonstrations/store";
import {
  createHostAccessBroker,
  HostAccessRefusedError,
} from "./host-access/broker";
import { hostAccessTools } from "./host-access/tools";
import { startHttpServer } from "./http-server";
import { githubCallbackRoutes } from "./identity/github-callback";
import { retireIdentityLinks, retireOwnedAccounts } from "./identity/retire";
import { slackCodeRedeemer } from "./identity/slack-redeem";
import { createIdentityStore } from "./identity/store";
import { createMemoryDefaults } from "./memory/defaults";
import { createMemoryIngestion } from "./memory/ingestion";
import { createMemoryStore } from "./memory/store";
import { reportModelAvailability } from "./model-availability-check";
import { memoryTools } from "./memory/tools";
import { appAccessTools } from "./plugins/app-access-tool";
import { createSignInNotifier, createSignInResumer } from "./passwords/resume";
import { createSignInService } from "./passwords/service";
import { createPasswordStore } from "./passwords/store";
import { createPeopleStore } from "./people/store";
import { createAccountModeSwitch } from "./plugins/account-mode";
import { assertActivatable, providerDecision } from "./plugins/broker";
import { BROKERED_PROFILE } from "./plugins/access";
import { useRoutineTools } from "./plugins/builtin-routines";
import { useArcadeClient } from "./plugins/arcade";
import { createArcadeClient } from "./plugins/arcade-adapter";
import { useComposioClient } from "./plugins/composio";
import { createComposioClient } from "./plugins/composio-adapter";
import { backfillBrokeredLogos } from "./plugins/logos";
import { redirectUriFor } from "./plugins/oauth";
import {
  createSharedUseGate,
  createSharedUseStore,
} from "./plugins/shared-use-store";
import {
  arcadeVerifierNotice,
  selectProviderWiring,
  storedProvider,
} from "./plugins/provider-wiring";
import { createPluginStore } from "./plugins/store";
import {
  grantedSkills,
  grantedTools,
  REFUSAL_MARKER,
  vendorAnswer,
} from "./plugins/tools";
import { createProactiveEngine } from "./proactive/engine";
import {
  createPrivateShareCheck,
  PRIVATE_SHARE_TOOL_REF,
} from "./proactive/private-share";
import {
  allowedForRun,
  createReadOnlyClassifier,
  guardProactiveCallback,
  restrictCoordinationForRun,
  restrictToolsForRun,
} from "./proactive/restriction";
import { createProactiveStore } from "./proactive/store";
import { createProviderOAuthProxy } from "./provider-oauth";
import { createResponsibilityBindingStore } from "./responsibilities/bindings";
import {
  createEmailTriggerRoutes,
  createSnsVerifier,
  fetchText as fetchSnsText,
  inboundEmailConfigFromEnv,
} from "./responsibilities/email";
import {
  createSlackTriggerIngest,
  slackAccessFrom,
  useSlackChannelMembership,
  useSlackTriggerIngest,
} from "./responsibilities/slack";
import { createResponsibilityStore } from "./responsibilities/store";
import { responsibilityTools } from "./responsibilities/tools";
import { createTriggerIngressRoutes } from "./responsibilities/trigger-routes";
import { useTriggerTools } from "./responsibilities/trigger-tools";
import { createTriggerStore } from "./responsibilities/triggers";
import type { Responsibility } from "./responsibilities/types";
import { createServerResponsibilityEngine } from "./responsibilities/wiring";
import { createRoutineRunner } from "./routines/runner";
import { createRoutineStore } from "./routines/store";
import { createIntentRouter } from "./routing/classify";
import { createModelCompleter } from "./routing/model";
import {
  createChannelHello,
  createDuetChannelStore,
} from "./openduet/channels";
import { createPageStore } from "./openduet/pages";
import { withRunChannels } from "./openduet/run-channel";
import { createSetupSources } from "./openduet/setup";
import {
  createTaskReportReader,
  threadHistory,
} from "./openduet/task-report";
import { createTaskStore } from "./openduet/task-store";
import { createTaskReplyContext } from "./openduet/task-reply-context";
import { createTaskThreads, createTaskTurn } from "./openduet/task-threads";
import type { TaskStarter } from "./openduet/tasks";
import { createOpenDuetTools, createTaskIntake } from "./openduet/wiring";
import { createTeamBots } from "./team-bots/team-bots";
import {
  createPackageStatusReader,
  loadTenantPackage,
  synchronizeTenantPackage,
} from "./tenant-package";
import { createUserInstructionsStore } from "./user-instructions";
import { createUserPreferencesStore } from "./user-preferences";
import { createVoiceSessionStore } from "./voice/sessions";
import { createVoiceSummarizer } from "./voice/summary";
import { repeatAfterEach } from "./work/loop";
import { createWorkQueue, DEFAULT_MAX_ATTEMPTS, type WorkOfferedListener } from "./work/queue";

/**
 * Who is asking to read or run a local conversation.
 *
 * One resolver, because a run has two questions to answer about the same person: whose threads and
 * memory these are, and which coworkers they may run. Answering them from different places is how
 * one person ends up running another's private coworker, or reading their thread.
 */
async function resolveRequestActor(request: Request): Promise<{
  id: string;
  name: string;
  role: OpenBotRole;
}> {
  if (config.singleUser) {
    return { id: DEV_ACTOR.id, name: DEV_ACTOR.email, role: DEV_ACTOR.role };
  }
  const session = await auth?.api.getSession({ headers: request.headers });
  const user = session?.user;
  if (!user) {
    throw new Error("A conversation run requires a signed-in user.");
  }
  return {
    id: user.id,
    name: user.name ?? user.email ?? user.id,
    role: roleForEmail(user.email, config.auth?.initialAdminEmails ?? []),
  };
}

/** Thread and agent access use the same signed-in actor. Empty ids are rejected by the runtime. */
const ANONYMOUS_ACTOR = { id: "", role: "user" } as const;

const identifyActor: IdentifyActor = async (request) => {
  try {
    const { id, role } = await resolveRequestActor(request);
    return { id, role };
  } catch {
    return ANONYMOUS_ACTOR;
  }
};

const config = loadConfig();
// Read with the rest of the configuration, where an empty variable is an absent one. See
// `serverPort` in config.ts for what `process.env.PORT ?? …` did with `PORT=` instead.
const port = config.port;
const database = createDatabase(config.databaseUrl);
// Every dispatch point asks this database whether its person paused the Bot. See agents/lifecycle.ts.
configureBotLifecycle({ database });
await initializeDevActorUser(database, config.singleUser);
// The vault, built before the agent store because a customer's agent may sit behind a key and that
// key belongs here rather than on the agent row. See agents/auth-header.ts.
const credentialStore = createCredentialStore(database);
const identityStore = createIdentityStore(database, credentialStore);
const agentVault = {
  store: credentialStore,
  reader: credentialStore,
  encryptionKey: config.keyEncryptionKey,
};
const agentProfileStore = createAgentProfileStore(
  database,
  config.managedAgent?.endpoint,
  agentVault,
);
// Read here rather than beside the synchronise below, because the package names the deployment and
// the channel store needs that name before it can mint a thread id.
const tenantPackage = await loadTenantPackage(config.tenantPackageDirectory);
const threadIdentity = createThreadIdentity(
  config.deploymentId ?? tenantPackage.tenantId,
);
const baseChannelStore = createChannelStore(
  database,
  agentProfileStore,
  threadIdentity,
);
/**
 * A person spoke in one of their conversations. Bound once memory defaults exist (memory/defaults.ts):
 * a conversation with one Bot switches on that Bot's research and memory sources for this person.
 */
let personSpoke: ((ownerUserId: string, channelId: string) => void) | undefined;
/**
 * Something said in a conversation by the person, or by a turn their browser ran: activity with no
 * source, which a turn this server ran always carries. Bound once background research exists, so a
 * started task waiting on an answer there hears it (proactive/store.ts `noteConversation`).
 */
let conversationSaid:
  | ((
      ownerUserId: string,
      channelId: string,
      activity: { text: string; agentId: string | null; at: Date },
    ) => void)
  | undefined;
const channelStore: ChannelStore = {
  ...baseChannelStore,
  async recordActivity(actor, channelId, activity, source) {
    await baseChannelStore.recordActivity(actor, channelId, activity, source);
    if (activity.agentId === null) personSpoke?.(actor.id, channelId);
    if (!source) conversationSaid?.(actor.id, channelId, activity);
  },
};
const channelEvents = createChannelEventHub();
/**
 * Which components each Bot may answer with.
 *
 * Nothing is seeded here. The catalogue is a fact about the build; a fork that ships four components
 * of its own should start with four rows, and the only thing that can enumerate them is
 * the app that compiled them. It announces itself on load; this process learns what exists from that,
 * and owns only what may be done with it.
 */
const componentStore = createComponentStore(database);
// Its own connection is held for the life of the process; announced activity from any instance
// arrives here and is fanned out to connected members.
const channelActivityListener = await startChannelActivityListener(
  config.databaseUrl,
  channelEvents,
);
// Persistent claims recover after a restart; every pass takes at most 100 unlocked channels.
const channelBusySweep = repeatAfterEach(async () => {
  try {
    await expireChannelBusyClaims(database);
  } catch (error) {
    console.error("Channel busy expiry failed.", error);
  }
}, 30_000);
const loadAgentsForActor = createRuntimeAgentLoader(
  database,
  agentVault,
);
await synchronizeTenantPackage(database, tenantPackage);
const peopleStore = createPeopleStore(
  database,
  config.auth?.initialAdminEmails ?? [],
  /*
   * Removing somebody retires what they connected: their plugin credentials and connections, and
   * their linked outside accounts (which keep resolving to them, now refused; the tokens are revoked
   * and every link needs reconnecting). Both halves run whichever fails, and the failure is rethrown
   * after (see retireOwnedAccounts).
   *
   * A closure, because `pluginStore` is built further down: this has to exist before `auth` does,
   * and that one needs the vault and the policy. `pluginStore` is read only when the closure runs —
   * an administrator or the directory removing somebody, never during module initialisation — so by
   * then the binding is there. The linked-account half writes its audit rows through a store made
   * on its own transaction, so it reads no later binding (`bootAuditStore` included).
   */
  (userId, by) =>
    retireOwnedAccounts({
      plugins: () => pluginStore.retireConnectionsFor(userId, by),
      identities: () =>
        retireIdentityLinks(
          database,
          credentialStore,
          (executor) => createAuditStore(executor),
          userId,
          by,
        ),
    }),
);
const identityProviderStore = createIdentityProviderStore(database);
const auth: AuthService | undefined = config.auth
  ? createAuth(config, database)
  : undefined;
const computerProvider = config.computer ? createComputerProvider(config.computer) : undefined;
const policyStore = createPolicyStore(
  DEFAULT_ACTION_POLICY,
  database,
);
// A boundary an administrator set is read back before the first action is decided, so a restart no
// longer silently returns to the configured default.
const policySource = await policyStore.load();
/*
 * And kept current afterwards.
 *
 * A boundary an administrator changes arrives at one server. Without this, every other server keeps
 * enforcing what it read at boot, so a new deny rule stops roughly one action in N while the screen
 * and the audit row both report success. See policy-listener.ts.
 */
const policyListener = await startPolicyListener(
  config.databaseUrl,
  policyStore,
);

/*
 * Record which boundary this process started with.
 *
 * The trail records the boundary a process starts with, so later audit reads can distinguish the
 * configured default from any administrator-updated policy that was persisted before restart.
 *
 * Not awaited and never fatal. A deployment must not fail to start because its audit trail is
 * unavailable, and the row is a note for a reader rather than something the server depends on.
 */
const bootAuditStore = createAuditStore(database);
// The gallery every headless turn offers its Bot, refusals written to the same trail.
const componentCatalog = headlessComponentCatalog({
  store: componentStore,
  audit: auditSink(bootAuditStore),
});
// One store: the gateway writes through it, a route reads it, and the sweep below takes the old ones out.
const pageFrameStore = createPageFrameStore(database);
let deliveryNotifications: (
  scope: DeliveryScope,
  input: {
    id: string;
    text: string;
    kind: "reply" | "question" | "approval";
    requestId?: string;
  },
) => Promise<void> = async () => {
  throw new Error("Delivery is not initialized.");
};

const actorFor = async (ownerUserId: string): Promise<AgentActor> => ({
  id: ownerUserId,
  role: config.singleUser ? "admin" : "user",
});

const channelSourceForRun = async (run: RunAssertion) => {
  if (!run.threadId) return null;
  const sources = await database
    .select({ channelId: channels.id, botId: channelAgents.agentId })
    .from(threadChannelMappings)
    .innerJoin(channels, eq(channels.id, threadChannelMappings.channelId))
    .innerJoin(
      channelMemberships,
      and(
        eq(channelMemberships.channelId, channels.id),
        eq(channelMemberships.userId, run.actorId),
      ),
    )
    .innerJoin(channelAgents, eq(channelAgents.channelId, channels.id))
    .where(
      and(
        eq(threadChannelMappings.threadId, run.threadId),
        eq(threadChannelMappings.userId, run.actorId),
        isNull(channels.deletedAt),
      ),
    );
  return sources.find((source) => source.botId === run.botId) ?? null;
};

/*
 * A run's source conversation: a channel's own thread, or a Bot's thread in a group conversation.
 * The group lookup applies the same live-membership and own-Bot checks. See channels/group.ts.
 */
const sourceForCoordinationRun = async (run: RunAssertion) => {
  const sourceOf=async(identity:RunAssertion)=>{
    const channel=await channelSourceForRun(identity);
    if(channel)return {...channel,group:false};
    const group=await groupSourceForRun(database,identity);
    return group?{...group,group:true}:null;
  };
  const direct=await sourceOf(run);
  if(direct)return direct;
  const ancestry=await database.execute<{threadId:string;botId:string}>(sql`with recursive source as (
    select id,parent_run_id,thread_id,agent_id,user_id from local_runs where id=${run.runId} and user_id=${run.actorId}
    union all select parent.id,parent.parent_run_id,parent.thread_id,parent.agent_id,parent.user_id from local_runs parent
      join source child on child.parent_run_id=parent.id where parent.user_id=${run.actorId}
  ) select thread_id as "threadId",agent_id as "botId" from source`);
  for(const parent of ancestry){
    const identity={...run,threadId:parent.threadId,botId:parent.botId};
    const source=await sourceOf(identity);
    if(source)return source;
  }
  return null;
};

const authoriseQuestion = async (question: PersonQuestion) => {
  const source = await sourceForCoordinationRun({
    ...question,
    botId: questionConversationBot(question),
    depth: 0,
  });
  if (question.channelId && source?.channelId !== question.channelId)
    throw new ApprovalRefusedError("The saved question source has changed.");
  if (!source)
    throw new ApprovalRefusedError(
      "That conversation is no longer available to this Bot and person.",
    );
  if (
    !(await agentProfileStore.get(
      await actorFor(question.actorId),
      question.botId,
    ))
  )
    throw new ApprovalRefusedError("That Bot is no longer available to you.");
};
const storedApprovals = createApprovalStore(database);
// Before anything reads the model environment: blank base URLs removed, Anthropic given its `/v1`.
normalizeModelBaseUrls();
const runtimeModel = runtimeModelForEnvironment(tenantPackage.model);

/**
 * Pass one of tool selection: which skills a message needs, on the deployment's own model.
 *
 * Built once rather than per request, because it holds nothing about a person: the key is resolved
 * on every call, so a credential rotated a moment ago is used by the next run.
 */
const chooseSkills = createModelCompleter({
  model: runtimeModel,
  resolveApiKey: () =>
    resolveModelApiKey({
      encryptionKey: config.keyEncryptionKey,
      reader: credentialStore,
      provider: runtimeModel.provider,
      keyId: tenantPackage.model.credentialSecretRef,
      environment: process.env,
    }),
});

const threads = createLocalThreadStore(database);
await threads.initialize();
await threads.listen(config.databaseUrl);
const approvalComputerTools = async (
  ownerUserId: string,
  agentId: string,
  initiator: AuditInitiator,
) => {
  const actor = await actorFor(ownerUserId);
  const profile = await agentProfileStore.get(actor, agentId);
  if (!profile)
    throw new ApprovalRefusedError("That Bot is no longer available to you.");
  return computerGateway
    ? createHeadlessComputerTools({
        gateway: computerGateway,
        botId: agentId,
        actor: { id: actor.id, userId: actor.id, initiator },
        auditStore: bootAuditStore,
        ...(signInService ? { signIn: signInService } : {}),
      })
    : [];
};

const approvalService = createServerApprovalService({
  storedApprovals,
  config,
  sourceForCoordinationRun,
  agentProfileStore,
  actorFor,
  database,
  authoriseQuestion,
  threads,
  approvalComputerTools,
  review: (prompt, signal) => chooseSkills(prompt, signal),
  // Assigned further down, once delivery is wired.
  notify: (scope, input) => deliveryNotifications(scope, input),
});
// Housekeeping on a schedule: audit rows when asked for, screenshots always, one timer. See audit-retention.ts.
const retentionSweeps = startRetentionSweeps(
  config.databaseUrl,
  config.auditRetentionDays,
  pageFrameStore,
);
const computerGateway = computerProvider
  ? createComputerGateway({ provider: computerProvider, pageFrames: pageFrameStore })
  : undefined;

/**
 * What a Bot can reach beyond its own computer.
 *
 * Built here rather than beside the component store because it needs the policy, and it needs the
 * same policy the computer gateway enforces rather than one of its own. A deployment that has said
 * "this Bot may not change anything in Jira" has said one thing, and it should not matter whether
 * the change would arrive through a browser or through a tool call.
 */
const sandboxedStore = createSandboxedStore(database, bootAuditStore);

/**
 * Composio, built ONCE: the client the transport calls through and the broker behind the app
 * directory are the same client, and the store below and the routes further down share it.
 *
 * ONE CLIENT, TWO SEAMS, INSTALLED TWO DIFFERENT WAYS, because the two are reached two different
 * ways. The transport is reached as a MODULE — `transportFor` maps a kind to one, exactly as the
 * builtin routines transport above is reached — so there is no constructor to hand a client to and
 * the registry is built at IMPORT TIME, long before there is configuration to read. That is why the
 * actions seam is installed globally, from here, the one place that has the key. The broker has no
 * such problem: it is an ordinary argument, passed to the store and to `createApp`.
 *
 * A DEPLOYMENT WITH NO KEY INSTALLS NEITHER, which is the state the transport is written for rather
 * than an edge of it. The seam stays null and every Composio listing and call refuses saying the
 * connector is not configured here; the store gets no broker and the app directory says the same.
 * Installing a client built from an absent key would turn all of that into a vendor error at first
 * use, which sends an operator looking for a broken Composio instead of at their own configuration.
 */
/*
 * EXACTLY ONE PROVIDER, DECIDED ONCE. `selectProviderWiring` answers which transport client is
 * installed and which broker goes on to the store and the routes; the other client is installed as
 * an explicit `null`, so a deployment holding both keys (legal, and needed to end accounts at the
 * old vendor) never has two seams live. It refuses, rather than wiring nothing, both configurations
 * it cannot decide: a named provider whose key is unset, and both keys set with nothing named.
 */
const providerWiring = selectProviderWiring(config, {
  composio: createComposioClient,
  arcade: createArcadeClient,
});
useComposioClient(providerWiring.install.composio);
useArcadeClient(providerWiring.install.arcade);
const wiredProvider = providerWiring.provider;
const composio =
  wiredProvider && providerWiring.broker
    ? { broker: providerWiring.broker, provider: wiredProvider }
    : null;
/*
 * Activation is refused while the OTHER provider still holds connection rows. Keyed on rows, never
 * on keys: having both keys set is the expected state while the old provider's connections are ended.
 */
if (wiredProvider) {
  const [{ count: otherProviderRows }] = await database
    .select({ count: sql<number>`count(*)::int` })
    .from(brokeredConnections)
    .where(ne(brokeredConnections.provider, wiredProvider));
  assertActivatable(wiredProvider, otherProviderRows);
}
/*
 * Arcade's verifier is set by hand in Arcade's dashboard and cannot be read back, so an Arcade
 * deployment says once, at startup, which address it must be set to. See `arcadeVerifierNotice`.
 */
if (wiredProvider === "arcade") {
  console.warn(arcadeVerifierNotice(config.publicUrl));
}

/**
 * The private sign-in form and the Passwords vault. A Bot asks to be signed in; the person answers
 * in a form outside the conversation; the computer types the login. See passwords/service.ts.
 */
const signInService = computerGateway
  ? createSignInService({
      store: createPasswordStore(database),
      gateway: computerGateway,
      // The admin switch, read at call time; installed further down, and absent in scripts.
      passwordManagerEnabled: async (ownerUserId) =>
        (await enterpriseControls()?.capabilityFor(
          ownerUserId,
          "passwordManager",
        )) ?? true,
      encryptionKey: config.keyEncryptionKey,
      auditStore: bootAuditStore,
      notify: createSignInNotifier({
        database,
        appUrl: config.appUrl,
        notify: (scope, input) => deliveryNotifications(scope, input),
      }),
      onResolved: (request) =>
        createSignInResumer({
          database,
          resumeResponsibility: (owner, runId, result) =>
            responsibilityStore.resumeWaiting(owner, runId, result),
          continueTurn: ({ ownerUserId, botId, snapshot, result, messageId }) =>
            approvalContinuationRunner({
              ownerUserId,
              routineId: "sign-in",
              agentId: botId,
              threadId: snapshot.threadId,
              instruction: "",
              initiator: snapshot.initiator ?? PERSON_INITIATOR,
              continuation: { snapshot, result, messageId },
            }),
          recordReply: async ({
            ownerUserId,
            channelId,
            botId,
            text,
            messageId,
          }) => {
            await channelStore.recordActivity(
              await actorFor(ownerUserId),
              channelId,
              { text, agentId: botId, at: new Date() },
              { id: messageId },
            );
          },
        })(request),
    })
  : undefined;

/*
 * Whether a Bot may act through a Shared app at all, kept apart from the policy boundary above
 * because it answers a different question: not "is this action allowed" but "is this Bot's
 * audience narrow enough for what an administrator approved for the shared account." Kept in
 * module scope because the publication, assignment and grant routes below also need to reapprove
 * or refile against it when a Bot's exposure changes.
 */
/*
 * WHICH SLICE of `brokered_connections` this deployment reads, decided ONCE, at the one boundary
 * that can see both the configuration and the rows.
 *
 * THERE IS NO `?? "composio"` HERE ANY MORE, AND THAT WAS A BUG RATHER THAN A SHORTHAND.
 * Configuration names no provider for three different reasons, and the one that matters is "both
 * keys set, OPENBOT_BROKER_PROVIDER unset" — legal, documented, and exactly what a deployment
 * migrating off Composio sits in while it ends its old accounts. Defaulting it to `composio` gave
 * the plugin store and the shared-use store a filter that excludes every Arcade row this deployment
 * holds, so live Arcade connections read as absent and the accounts behind them could not be
 * revoked. `storedProvider` takes the three causes apart and, where configuration is silent, lets
 * the rows name themselves. The shared-use store and the plugin store are both given this one
 * value, so the gate and the approvals it reads agree.
 */
const providerConfiguration = providerDecision(config);
const brokerProvider = storedProvider(
  providerConfiguration,
  (
    await database
      .selectDistinct({ provider: brokeredConnections.provider })
      .from(brokeredConnections)
  ).map((row) => row.provider),
);
if (providerConfiguration.kind === "ambiguous") {
  /*
   * Said out loud, once, at startup: this deployment has two keys and no answer, so nothing is
   * active and nothing can be connected or revoked until one is named. The rows it already holds
   * are read as their own provider's (above), which is why this is a warning and not a refusal —
   * the screens stay honest, the vendor calls stay impossible.
   */
  console.warn(
    `${providerConfiguration.configured.map((provider) => BROKERED_PROFILE[provider].envVar).join(" and ")} are both set and OPENBOT_BROKER_PROVIDER names neither, so no broker is active: connected apps can be neither connected nor revoked until it is set. Existing connections are read as ${BROKERED_PROFILE[brokerProvider].vendor}'s.`,
  );
}
const sharedUseStore = createSharedUseStore(database, brokerProvider);

const pluginStore = createPluginStore({
  database,
  deploymentId: config.deploymentId ?? tenantPackage.tenantId,
  auditStore: bootAuditStore,
  credentials: credentialStore,
  encryptionKey: config.keyEncryptionKey,
  policy: () => policyStore.get(),
  approvalGate: approvalService.gate,
  sharedUse: createSharedUseGate(sharedUseStore, bootAuditStore),
  // A connector send to other people asks the owner first. See plugins/share-target.ts.
  privateShareCheck: createPrivateShareCheck({
    approvals: approvalService.store,
  }),
  /*
   * Where a vendor sends people back, for a vendor whose client this deployment registers itself.
   *
   * The same value the connect and callback routes build, from the same config field, because it has
   * to match what was registered character for character. Undefined without a public URL, which is
   * the honest state: there is nowhere for a consent flow to come back to, so there is nothing worth
   * registering.
   */
  redirectUri: config.publicUrl ? redirectUriFor(config.publicUrl) : undefined,
  /*
   * The same client the transport seam above was installed with, never a second one. Enabling an
   * app writes the row here and creates the auth config at the vendor, and a store holding a
   * different client from the one the call goes out through is two deployments' worth of state
   * behind one screen. Undefined without a key, which leaves enabling an app refused rather than
   * attempted.
   */
  broker: composio?.broker,
  brokerProvider,
});

/*
 * Personal ⇄ Shared for a brokered app. Built here because it needs the plugin store, the shared-use
 * store and the approval policy at once: making an app Shared ends people's accounts, approves each
 * Bot that holds it and adds an ask-before-write rule for its writes.
 */
const accountModes = createAccountModeSwitch({
  store: pluginStore,
  sharedUse: sharedUseStore,
  teamRules: approvalService.store.policy,
  deploymentId: config.deploymentId ?? tenantPackage.tenantId,
  audit: bootAuditStore,
});

// Logo metadata is optional; a vendor outage must not prevent the API from starting.
if (composio) {
  void backfillBrokeredLogos(
    database,
    composio.provider,
    composio.broker,
  ).catch(() => {
    console.warn(
      `${BROKERED_PROFILE[composio.provider].vendor} app logos could not be updated. Existing icons remain available; missing logos will be retried on the next restart.`,
    );
  });
}

/**
 * Routines, and the one moment its tools are told what to act on.
 *
 * The builtin transport is reached as a MODULE — `transportFor` maps a kind to one — so there is no
 * constructor to hand a store to and no request-time seam either: the transport registry is built at
 * import time, long before there is a database. So the store is installed here, once, from the place
 * that already owns building stores. Without this call the four tools are advertised and every one of
 * them refuses, which is the honest behaviour for a deployment that never wired it, and would be a
 * silent outage for this one.
 */
const routineStore = createRoutineStore(database);
useRoutineTools(routineStore);
const responsibilityStore = createResponsibilityStore(database, {
  resolveTarget: async (ownerUserId, agentId, channelId) => {
    const actor = await actorFor(ownerUserId);
    const [bot, channel] = await Promise.all([
      agentProfileStore.get(actor, agentId),
      channelStore.get(actor, channelId),
    ]);
    return bot && channel?.active && channel.agentIds.includes(agentId)
      ? { threadId: channel.threadId }
      : null;
  },
});
const responsibilityBindings = createResponsibilityBindingStore(database, {
  store: credentialStore,
  reader: credentialStore,
  encryptionKey: config.keyEncryptionKey,
});
const deliveryStore = createDeliveryStore(database);

/*
 * Event triggers. Every kind authenticates with its vendor's own scheme and then goes through the
 * responsibility engine's one ingest (event + run + queue in one transaction), so dispatch is the
 * same headless AG-UI path as every other responsibility run. `responsibilityEngine` is read at
 * delivery time, long after it is constructed further down.
 */
/*
 * Slack access: the owner's own linked Slack identity comes from the delivery bindings (read at call
 * time; `deliveryStore` is built further down), and channel membership from the Slack pairing via
 * `useSlackChannelMembership`. Until the pairing installs that, Slack triggers are refused.
 */
const slackAccess = slackAccessFrom(async (ownerUserId, teamId) => {
  const bindings = await deliveryStore.listBindings(ownerUserId);
  return (
    bindings.find(
      (binding) =>
        binding.transport === "slack" &&
        binding.realm === teamId &&
        binding.enabled,
    )?.identity ?? null
  );
});
const responsibilityTriggerStore = createTriggerStore(
  database,
  {
    store: credentialStore,
    reader: credentialStore,
    encryptionKey: config.keyEncryptionKey,
  },
  { slackAccess },
);
const triggerIngressDeps = {
  directory: responsibilityTriggerStore.directory,
  ingest: (event: unknown) => responsibilityEngine.ingest(event),
  auditStore: bootAuditStore,
};
const inboundEmail = inboundEmailConfigFromEnv(process.env);
const responsibilityTriggers = {
  store: responsibilityTriggerStore,
  emailDomain: inboundEmail?.domain ?? null,
  ingressRoutes: createTriggerIngressRoutes(triggerIngressDeps),
  emailRoutes: inboundEmail
    ? createEmailTriggerRoutes({
        ...triggerIngressDeps,
        config: inboundEmail,
        verify: createSnsVerifier(fetchSnsText),
        confirmSubscription: fetchSnsText,
      })
    : null,
};
// The Slack pairing calls `ingestSlackEvent` from responsibilities/slack.ts; this installs it.
useSlackTriggerIngest(
  createSlackTriggerIngest({ ...triggerIngressDeps, slackAccess }),
);
// Bots manage triggers from chat through the builtin Routines transport; keys never reach the model.
useTriggerTools({
  triggers: responsibilityTriggerStore,
  responsibilities: responsibilityStore,
  publicUrl: config.publicUrl ?? null,
  emailDomain: inboundEmail?.domain ?? null,
});

/**
 * Where a Bot handing work to another gets decided.
 *
 * The queue is the one #216 shipped, shared with the idle-computer culler and with routines: durable
 * work claimed by whichever replica gets to it, leased so a dead replica's work comes back. A hop is
 * that, because the Bot being addressed will very likely run on a different pod from the Bot that
 * addressed it, and a hop held in memory is lost the moment either is rescheduled.
 */
const handoffDesk = createHandoffDesk({
  queue: createWorkQueue(database),
  profiles: agentProfileStore,
  // Read per hop and never held, so revoking a grant applies to the next hop rather than after a
  // restart.
  mayAddress: async (fromBotId, toBotId) =>
    (
      await pluginStore
        .botsReachableFrom(fromBotId)
        // A grant that cannot be read is not a grant. Failing closed here costs a hop; failing open
        // would let a Bot address one nobody gave it because the database blinked.
        .catch(() => [] as string[])
    ).includes(toBotId),
  /*
   * Deferred rather than passed directly, because `actorFor` is defined further down with the rest
   * of the run-building collaborators. It is only ever called during a hop, long after this module
   * has finished loading.
   */
  actorFor: (userId) =>
    // Null rather than a throw: see the seam's own note. A role that cannot be read is not a role,
    // and the hop is refused with a sentence rather than ending the run in silence.
    actorFor(userId).catch(() => null),
  auditStore: bootAuditStore,
  caps: config.handoff,
});

void recordAuditEvent(bootAuditStore, {
  eventType: "computer.policy_loaded",
  targetType: "policy",
  initiator: DEPLOYMENT_INITIATOR,
  payload: {
    ...policyStore.get(),
    source:
      policySource === "the database"
        ? "an administrator, saved in this deployment"
        : "the built-in default",
    note:
      policySource === "the database"
        ? "Set while running and kept. A restart returns to this."
        : "The deployment default. Anything an administrator sets from here is kept.",
  },
}).catch(() => undefined);

/*
 * Record whether each Bot has a computer of its own.
 *
 * A shared provider is a fine way to run on a laptop, but the shared isolation state must be visible
 * rather than inferred.
 */
const isolation = describeComputerIsolation(computerProvider);

void recordAuditEvent(bootAuditStore, {
  eventType: "computer.isolation_loaded",
  targetType: "computer",
  initiator: DEPLOYMENT_INITIATOR,
  payload: {
    isolation: isolation.isolation,
    note: isolation.note,
  },
}).catch(() => undefined);

console.info(
  JSON.stringify({
    type: "computer-isolation",
    provider: computerProvider ? computerProvider.name : "none",
    isolation: isolation.isolation,
    ...(isolation.warning ? { warning: isolation.warning } : {}),
  }),
);
/**
 * One Bot's endpoint must not take down the platform.
 *
 * Restarting a remote agent while a run is in flight resets the socket. The rejection reaches the top
 * of the process, and Bun kills the whole server: every other person's conversation, every other Bot
 * and the admin surface go with it, because somebody redeployed their own agent.
 *
 * That blast radius is created by design the moment people can register their own endpoints,
 * so it belongs to that feature. A remote agent is untrusted infrastructure: it will restart, it will
 * time out, it will close a stream halfway through, and none of that is exceptional.
 *
 * Logged loudly rather than swallowed. A process that hides unhandled rejections is worse than one
 * that dies, so this prints the full reason and keeps serving; what it must never do is stay quiet.
 */
process.on("unhandledRejection", (reason) => {
  console.error(
    JSON.stringify({
      type: "unhandled-rejection",
      message: reason instanceof Error ? reason.message : String(reason),
      code:
        reason && typeof reason === "object" && "code" in reason
          ? String((reason as { code: unknown }).code)
          : undefined,
      note: "The server kept running. A remote agent's connection failing must not stop everyone else.",
    }),
  );
});

/**
 * The watch on Bot streams, built once and shared by every run.
 *
 * It has to outlive the request that opens a stream: the sweep that notices a silent one is still
 * running long after the run request has been answered, because the local runtime accepts the request before the run ends and the Bot keeps writing for as long as it has something to say.
 *
 * The same audit store as everything else, so a Bot that hangs is recorded beside what Bots do.
 */
const stallGuard = createStallGuard({
  stallMs: config.agentStallTimeoutMs,
  auditStore: bootAuditStore,
});

const intentRouter = createIntentRouter({
  complete: createModelCompleter({
    model: runtimeModel,
    resolveApiKey: () =>
      resolveModelApiKey({
        encryptionKey: config.keyEncryptionKey,
        reader: credentialStore,
        provider: runtimeModel.provider,
        keyId: tenantPackage.model.credentialSecretRef,
        environment: process.env,
      }),
  }),
});

// Used by the setup page when a person explicitly asks to check the model.
const checkModelAvailability = () =>
  reportModelAvailability({
    provider: runtimeModel.provider,
    model: runtimeModel.defaultModel,
    apiKey: () =>
      resolveModelApiKey({
        encryptionKey: config.keyEncryptionKey,
        reader: credentialStore,
        provider: runtimeModel.provider,
        keyId: tenantPackage.model.credentialSecretRef,
        environment: process.env,
      }),
  });
// Named collaborators are bound once in actorAgentResolver for chat, hops, and headless turns.

/** The deployment's model key, resolved per call so a credential rotated a moment ago is used next. */
const resolveRuntimeModelApiKey = () =>
  resolveModelApiKey({
    encryptionKey: config.keyEncryptionKey,
    reader: credentialStore,
    provider: runtimeModel.provider,
    keyId: tenantPackage.model.credentialSecretRef,
    environment: process.env,
  });

const hostAccessBroker = createHostAccessBroker(Date.now, {
  approvalGate: approvalService.gate,
  commandPolicy: (actorId) => approvalService.hostCommandPolicy(actorId),
});

// Tools run here, not in the browser. Each connector still executes through the plugin store, so the
// grant, the policy and the audit row are exactly where they were. Host-folder tools are also
// server-dispatched: the selected Bot and the signed-in owner are bound here, then the desktop worker
// receives only opaque grant ids and relative paths.
const personalMemoryStore = createMemoryStore(database);
const demonstrationStore = createDemonstrationStore(database);
const demonstrationRecorder = createDemonstrationRecorder({
  store: demonstrationStore,
  // Teaching a shared deployment Bot is allowed as well as an owned one; the skill is the owner's.
  ownsBot: async (owner, bot) =>
    (await pluginStore.agentOwner(bot)) === owner ||
    (await agentProfileStore.get(await actorFor(owner), bot)) !== null,
  ownsSkill: async (owner, slug) =>
    (await pluginStore.skillOwner(slug)) === owner,
  routines: routineStore,
});
const memoryIngestion = createMemoryIngestion({
  store: personalMemoryStore,
  plugins: pluginStore,
  canUseBot: async (owner, bot) =>
    (await pluginStore.agentOwner(bot)) === owner ||
    (await agentProfileStore.get(await actorFor(owner), bot)) !== null,
});
// Proactive research may only read; see proactive/restriction.ts. Read from the catalogue per call.
const proactiveReadOnlyRefs = createReadOnlyClassifier(pluginStore);
/** Team Bots: published Bots, their audiences, and teammates' consent to their own accounts. */
const teamBots = createTeamBots({
  database,
  connectedServers: async (userId) =>
    new Set(
      [
        ...(await pluginStore.connectionsFor(userId)),
        ...(await pluginStore.brokeredConnectionsFor(userId)),
      ].map((connection) => connection.serverId),
    ),
});
const deliveryScopeFor: DeliveryScopeResolver = async (
  ownerUserId,
  channelId,
  agentId,
) => {
  const person = await peopleStore.find(ownerUserId);
  if (!person || person.revoked) return null;
  const actor = await actorFor(ownerUserId);
  const [channel, bot] = await Promise.all([
    channelStore.get(actor, channelId),
    agentProfileStore.get(actor, agentId),
  ]);
  return channel?.active && bot && channel.agentIds.includes(agentId)
    ? { ownerUserId, channelId, agentId, threadId: channel.threadId }
    : null;
};

/*
 * Memory sources and background research, on by default for each person and Bot, and never switched
 * back on once the person turns one down. See memory/defaults.ts.
 */
const memoryDefaults = createMemoryDefaults({
  database,
  ingestion: memoryIngestion,
  sources: config.memoryDefaults.sources,
  research: config.memoryDefaults.research,
  channelBots: async (ownerUserId, channelId) =>
    (await channelStore.get(await actorFor(ownerUserId), channelId))
      ?.agentIds ?? null,
  // The same rule research delivery uses, read when a person speaks (long after it is defined). Never a
  // task's own conversation: research writes to the person in Chat, and a task's turn speaks for them.
  canDeliver: async (ownerUserId, channelId, agentId) =>
    (await deliveryScopeFor(ownerUserId, channelId, agentId)) !== null &&
    !(await openDuetTasks.isTaskConversation(ownerUserId, channelId)) &&
    !(await openDuetChannels.isChannel(ownerUserId, channelId)),
  mintThreadId: () => threadIdentity.mint(),
  // Read when a Bot turn starts, long after `teamBots` below is defined.
  publishedByAnother: (ownerUserId, agentId) =>
    teamBots.publishedByAnother(ownerUserId, agentId),
});
personSpoke = memoryDefaults.personSpoke;
const loadPersonalMemoryForActor = (ownerUserId: string) => (botId: string) => {
  // Apps connected since this Bot's last turn become its memory sources. Never waits.
  memoryDefaults.botTurn(ownerUserId, botId);
  return memoryIngestion.contextFor(ownerUserId, botId);
};
const memorySweep = repeatAfterEach(async () => {
  try {
    await memoryIngestion.syncDue();
  } catch (error) {
    console.error(
      JSON.stringify({
        type: "memory-sweep-error",
        error: error instanceof Error ? error.name : "UnknownError",
        context: { operation: "syncDue" },
        timestamp: new Date().toISOString(),
      }),
    );
  }
}, 60_000);
// Follow-ups a Bot schedules for itself, on the shared work queue. See agents/wake-up.ts.
const wakeUpStore = createWakeUpStore(database, { auditStore: bootAuditStore });

/**
 * OpenDuet's own tools: the morning brief, read through the plugin store as the person, reply chips,
 * the pages it makes and the tasks it starts. See openduet/wiring.ts.
 */
const openDuetPages = createPageStore(database);
const openDuetTasks = createTaskStore(database);
// Read when a task starts, long after the engine below is made.
const openDuetStartTask: TaskStarter = ({ ownerUserId, agentId, task }) =>
  proactiveEngine.startAsked(ownerUserId, agentId, task);
const openDuetDirectChannel = async (ownerUserId: string, agentId: string) =>
  channelStore.direct(await actorFor(ownerUserId), agentId);
const openDuetTools = createOpenDuetTools({
  database,
  pages: openDuetPages,
  startTask: openDuetStartTask,
  callTool: (input) => pluginStore.callTool(input),
  complete: chooseSkills,
  model: runtimeModel.defaultModel,
  directChannel: openDuetDirectChannel,
});
/*
 * A task's report, read from its conversation as the runtime holds it (openduet/task-report.ts).
 * Uses the same SQL thread store as every headless turn.
 */
const openDuetReport = createTaskReportReader({
  database,
  history: threadHistory(threads),
});
// The + on Tasks: the same start and the same Up next as the tools above.
const openDuetIntake = createTaskIntake({
  database,
  directChannel: openDuetDirectChannel,
  startTask: openDuetStartTask,
});

const loadToolsForActor =
  (actorId: string, initiator: AuditInitiator = PERSON_INITIATOR) =>
  async (botId: string) => [
    ...openDuetTools(actorId, botId, initiator),
    ...wakeUpTools({
      store: wakeUpStore,
      ownerUserId: actorId,
      agentId: botId,
      initiator,
    }),
    ...memoryTools({
      store: personalMemoryStore,
      ingestion: memoryIngestion,
      ownerUserId: actorId,
      agentId: botId,
    }),
    /*
     * Held by every Bot, granted or not: how a Bot puts an app it cannot reach in front of the
     * person with the step that fixes it, instead of naming an administrator. A read; see the file.
     */
    ...appAccessTools({
      store: pluginStore,
      botId,
      actorId,
      composioConfigured: Boolean(composio),
      ...(composio ? { directory: () => composio.broker.listApps() } : {}),
      sharedAudience: sharedUseStore.admitsPerson,
    }),
    ...(await grantedTools({
      store: pluginStore,
      botId,
      actorId,
      initiator,
      // A Team Bot reaches its owner's accounts, and a teammate's own only with their consent.
      credentialActorFor: teamBots.credentialActorFor(actorId, botId),
    })),
    ...hostAccessTools({
      broker: hostAccessBroker,
      botId,
      actorId,
      auditStore: bootAuditStore,
      initiator,
    }),
  ];

/** One person's standing instructions, for both the /api/settings routes and every run they start. */
const userInstructionsStore = createUserInstructionsStore(database);

/*
 * What this person has told every built-in coworker they run.
 *
 * Per actor and read per build, for the reason every other per-person fact here is: somebody who
 * edits their instructions and sends a message expects the message to land on the new ones, and a
 * value captured at boot would serve the whole deployment whatever the first person to sign in had
 * written.
 */
const loadInstructionsForActor = (actorId: string) => () =>
  userInstructionsStore.read(actorId);

/*
 * The file behind an attachment reference, read when a turn turns out to name one.
 *
 * Read per turn rather than held, for the reason the bytes are in the database at all: a message
 * carries a `/api/attachments/<id>` URL, and a model provider is not going to go and fetch it. The
 * row is fetched here and the bytes go up inline, so the Bot sees the file the person attached
 * instead of a link it cannot follow.
 *
 * Built per actor and passed to both turn paths — the authenticated local runtime and
 * a routine's turn through `buildAgentFor` — so a routine firing at three in the morning inlines
 * exactly as a person's chat turn does, on exactly the same footing.
 *
 * NARROWED BY ACTOR AND BY CONVERSATION, and not silent. The reference reaches the loader out of
 * browser-supplied message content, so a turn can name an attachment in a channel the asker was
 * never in — or in one they ARE in but which is not the channel this turn is running in.
 * `loadAttachmentForTurn` answers both with the same membership join the fetch route uses plus the
 * run's own thread, and null when there is no row this person may see here.
 * `resolveAttachmentParts` fails the turn on that null rather than letting a Bot read a file back
 * to somebody who cannot open it.
 *
 * The thread is the CLOSURE'S ARGUMENT rather than something baked in beside the actor, because one
 * of these is built per actor per request and then used for however many runs that request makes;
 * a thread captured here would be the first run's, silently, for all of them.
 *
 * A PURE READ. `attachedAt` is written by the send rather than by anything here; see
 * `markAttachmentsSentForActor` below.
 */
const loadAttachmentForActor =
  (actorId: string) => (id: string, threadId: string) =>
    loadAttachmentForTurn(database, { actorId, threadId }, id);

/**
 * That the files on a message went out in it, recorded when a turn turns out to be a send.
 *
 * Bound per actor and handed to the same two turn paths as the reader above, so a routine's send at
 * three in the morning is recorded exactly as a person's chat turn is. `inlineAttachments`
 * (agents/build.ts) calls it with the ids on the message being asked about and no others: history is
 * replayed on every turn and by whoever is running it, so nothing behind that message is evidence
 * of a send.
 *
 * NARROWED BY ACTOR, and more strictly than the reader is. Reading is scoped to channel
 * membership, because members are meant to see each other's sent files; recording a send is scoped
 * to the UPLOADER, because `attachedAt` is what the sweeper, the upload cap and the withdrawal
 * route all read as "this file rode in a message somebody sent" — and a member who could write it
 * on a colleague's staged row would freeze that colleague's own withdrawal at 409 and leave the row
 * unsweepable. See `markAttachmentsSent` in channels/attachments.ts.
 *
 * AND NARROWED BY CONVERSATION, taking the thread as an argument for the reason the reader does.
 * A stamp written against a channel that never saw the file freezes the row the same way, and is
 * reached without any colleague being involved: one person, two channels of their own, a file
 * named from the wrong one.
 */
const markAttachmentsSentForActor =
  (actorId: string) => (ids: readonly string[], threadId: string) =>
    markAttachmentsSent(database, { actorId, threadId }, ids);

/*
 * What the deployment tells a remote Bot about the run it is starting.
 *
 * Signed here, where the encryption key lives, so the runtime module never holds a secret. The Bot
 * hands this back when it calls a tool, and it is where the Bot id and the person's name come
 * from: its own token proves which agent is calling, this proves who it is calling for, and
 * neither is read out of the request body any more.
 */
const signRunForActor =
  (
    actorId: string,
    initiator: AuditInitiator = PERSON_INITIATOR,
    // How deep in a Bot-to-Bot chain a headless turn already is; see createGroupConversations.
    depth?: number,
  ) =>
  (
    botId: string,
    runId: string,
    threadId?: string,
    previousAssertion?: unknown,
  ) => {
    const previous = readRunAssertion(
      previousAssertion,
      config.keyEncryptionKey,
    );
    if(previous&&(previous.botId!==botId||previous.actorId!==actorId))throw new Error("The run identity does not match this Bot and owner.");
    return mintRunAssertion(
      {
        botId,
        actorId,
        runId,
        threadId,
        initiator: previous?.initiator ?? initiator,
        depth: previous?.depth ?? depth ?? 0,
      },
      config.keyEncryptionKey,
    );
  };

/*
 * Which vendors this deployment connects to, held by a Bot or not.
 *
 * A Bot holding no grants used to be told nothing about connectors at all, so it treated a
 * connected vendor as an ordinary website and browsed to it: a Bot with no Drive grant opened
 * Google's sign-in page and asked a person to sign in to an account the deployment had already
 * connected. Naming them lets it say which one it has not been granted instead.
 *
 * Read per request rather than held, because a connector added a minute ago has to count.
 * Let failures reach buildAgents, which reports the missing guidance once and keeps the run usable.
 */
const loadVendors = async () =>
  (await pluginStore.listServers()).map((server) => server.id);

/*
 * How a run's tools are narrowed to the ones it is about.
 *
 * A model picks the right tool reliably out of about ten, and a deployment of this template
 * clears that as soon as it connects a second vendor. Past it the wrong tool gets called, or
 * none does and the answer comes from memory, and neither says so. So a Bot holding more than a
 * handful is offered the tools of the skills that match the message rather than everything at
 * once. See `plugins/selection.ts`.
 *
 * This narrows the offer and nothing else. What a Bot may call is the grant, checked in
 * `callTool` with the policy and the audit row exactly as before, so every path through here can
 * be wrong without a Bot gaining anything. That is also why every failure below is silent and
 * lands on the whole catalogue: the narrowing is worth an accuracy point, never a capability.
 */
const selectionForActor = (actorId: string): ToolSelection => ({
  loadSkills: (botId) => grantedSkills({ store: pluginStore, botId }),
  // The deployment's own model and key, the same pair the intent router uses, so selection is
  // never a second thing to configure. It throws on a missing key, which reads as "could not
  // choose" and leaves the whole catalogue offered.
  choose: chooseSkills,
  record: async (botId, selection) => {
    await recordAuditEvent(bootAuditStore, {
      eventType: "mcp.tools_discovered",
      targetType: "bot",
      targetId: botId,
      actorUserId: actorId,
      payload: {
        bot: botId,
        reason: selection.reason,
        granted: selection.granted,
        offered: selection.offered.length,
        skills: selection.skills,
      },
    });
  },
});

const { coordination, coordinationForActor } = wireCoordination({
  handoffDesk,
  config,
  approvalService,
  agentProfileStore,
  actorFor,
  database,
  pluginStore,
  bootAuditStore,
  sourceForCoordinationRun,
  channelStore,
  // Assigned further down, once delivery is wired.
  notify: (scope, input) => deliveryNotifications(scope, input),
});

/**
 * One Bot, built for a routine's turn, as its owner.
 *
 * Per turn rather than per boot, for the same reason the request path rebuilds: a Bot registered or
 * edited since the last firing has to count, and a private coworker must be absent for everybody but
 * its owner. No header and no request are involved — the owner is asserted by construction, from the
 * routine row — which is the whole point of doing it here rather than adding an impersonation path to
 * a public route.
 */
const buildAgentFor = async ({
  ownerUserId,
  agentId,
  initiator,
  depth,
}: {
  ownerUserId: string;
  agentId: string;
  initiator: AuditInitiator;
  depth?: number;
}) => {
  const actor = await actorFor(ownerUserId);
  let agent: AbstractAgent | undefined;
  try {
    agent = await actorAgentResolver.resolveAgentForActor(actor, agentId, {
      initiator,
      depth,
    });
  } catch (error) {
    if (!(error instanceof CoworkerUnavailableError)) throw error;
  }
  if (!agent) {
    /*
     * Named, and raised rather than swallowed. The routine's Bot was deleted, or made private by
     * somebody else, or the owner lost the role that could see it. The runner turns this into a
     * failed run row with this sentence on it, the first failure is said once in the channel, and
     * the fatigue rule switches the routine off after ten — which is exactly the right handling for
     * a routine pointed at something that is not coming back.
     */
    const error = new Error(
      `That Bot is no longer registered, so this routine has nothing to run: ${agentId}.`,
    );
    error.name = "RoutineBotNotRegistered";
    throw error;
  }
  return agent;
};
const routineAgentRunner = new LocalAgentRunner(threads, {
  onRunBusy: ({ threadId, busy, runId }) =>
    channelStore.signalBusy(threadId, busy, runId).catch(() => {}),
});

const routineRunner = createRoutineRunner({
  routineStore,
  channelStore,
  runTurn: createTurnRunner({
    admission: serverTurnAdmission,
    threads,
    runner: routineAgentRunner,
    components: componentCatalog,
    buildAgentFor,
    toolsForTurn: async ({ ownerUserId, agentId, initiator }) => {
      if (!computerGateway) return [];
      const actor = await actorFor(ownerUserId);
      const profile = await agentProfileStore.get(actor, agentId);
      if (!profile) throw new Error("That Bot is not available to this owner.");
      return createHeadlessComputerTools({
        gateway: computerGateway,
        botId: agentId,
        actor: { id: actor.id, userId: actor.id, initiator },
        auditStore: bootAuditStore,
        ...(signInService ? { signIn: signInService } : {}),
      });
    },
  }),
});

/**
 * The runtime, and the two things beside it a hop needs.
 *
 * `agentFor` builds the addressed Bot exactly the way a person's run builds it, and `history` reads
 * the conversation through the same client. Taken from here rather than assembled again, because a
 * Bot built by parallel wiring drifts the first time one of these arguments changes, and the drift is
 * invisible: it runs, and quietly holds different tools or a different role from the one the person
 * is talking to.
 */
const baseAgentResolver = createActorAgentResolver({
  loadAgents: loadAgentsForActor,
  model: runtimeModel,
  resolveModelApiKey: resolveRuntimeModelApiKey,
  stallGuard,
  loadToolsForActor: (actorId, initiator) =>
    restrictToolsForRun(
      initiator,
      loadToolsForActor(actorId, initiator),
      proactiveReadOnlyRefs,
    ),
  signRunForActor,
  computerGuidance: config.computer ? COMPUTER_GUIDANCE : undefined,
  loadVendors,
  selectionForActor,
  handoffForActor: (actorId, initiator, depth) =>
    restrictCoordinationForRun(
      initiator,
      coordinationForActor(actorId, initiator, depth),
    ),
  loadInstructionsForActor,
  loadAttachmentForActor,
  markAttachmentsSentForActor,
  loadPersonalMemoryForActor,
});
// Every Bot a person runs learns which OpenDuet channel its run is in. See openduet/run-channel.ts.
const actorAgentResolver = withRunChannels(baseAgentResolver, (owner, thread) =>
  openDuetChannels.ofThread(owner, thread),
);

const localRuntime = createLocalRuntime({
  threads,
  runner: routineAgentRunner,
  resolver: actorAgentResolver,
  identifyActor,
  admission: serverTurnAdmission,
  toolsForTurn: async ({ actor, agentId }) => [
    ...(await approvalComputerTools(actor.id, agentId, PERSON_INITIATOR)),
    ...(await componentCatalog.toolsForTurn({
      ownerUserId: actor.id,
      agentId,
      initiator: PERSON_INITIATOR,
    })),
  ],
  onReply: async ({ actor, agentId, threadId, runId, text }) => {
    const [mapping] = await database
      .select({ channelId: threadChannelMappings.channelId })
      .from(threadChannelMappings)
      .where(eq(threadChannelMappings.threadId, threadId))
      .limit(1);
    if (!mapping) return;
    await channelStore.recordActivity(
      actor,
      mapping.channelId,
      { text, agentId, at: new Date() },
      { id: runId },
    );
  },
});

const responsibilityEngine = createServerResponsibilityEngine({
  database,
  responsibilityStore,
  threads,
  routineAgentRunner,
  componentCatalog,
  buildAgentFor,
  actorFor,
  computerGateway,
  agentProfileStore,
  bootAuditStore,
  signInService,
  channelStore,
  // Assigned further down, once delivery is wired.
  notify: (scope, input) => deliveryNotifications(scope, input),
});
/**
 * A turn for a responsibility that is not one of the engine's own firings: a person answering the
 * question its run asked. Same tools, same initiator and the same run to report progress against,
 * so the Bot can carry on with the goal instead of being unable to record it.
 */
const responsibilityAnswerTurn = ({
  responsibility,
  responsibilityRunId,
}: {
  responsibility: Responsibility;
  responsibilityRunId: string | undefined;
}) => {
  const initiator: AuditInitiator = {
    kind: "responsibility",
    id: responsibility.id,
  };
  const tools = responsibilityTools({
    store: responsibilityStore,
    engine: responsibilityEngine,
    ownerUserId: responsibility.ownerUserId,
    agentId: responsibility.agentId,
    channelId: responsibility.channelId,
    ...(responsibilityRunId ? { responsibilityRunId } : {}),
  });
  return createTurnRunner({
    admission: serverTurnAdmission,
    threads,
    runner: routineAgentRunner,
    components: componentCatalog,
    buildAgentFor: (input) => buildAgentFor({ ...input, initiator }),
    toolsForTurn: async () => [
      ...(await approvalComputerTools(
        responsibility.ownerUserId,
        responsibility.agentId,
        initiator,
      )),
      ...tools.map((tool) => ({
        definition: {
          name: tool.name,
          description: tool.description,
          parameters: z.toJSONSchema(tool.parameters),
        },
        execute: (args: unknown, context: ToolExecutionContext) => tool.execute(args, context),
      })),
    ],
  });
};
const responsibilitySweep = repeatAfterEach(async () => {
  try {
    const report = await responsibilityEngine.dispatch({
      owner: workOwner("responsibility"),
      limit: 1,
    });
    if (
      report.succeeded.length ||
      report.failed.length ||
      report.waiting.length
    )
      console.info(
        JSON.stringify({ type: "responsibility-dispatch", ...report }),
      );
  } catch (error) {
    console.error(
      JSON.stringify({
        type: "responsibility-dispatch-error",
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
      }),
    );
  }
}, 2_000);

const approvalQueue = createWorkQueue(database);
const approvalOwner = workOwner("approval");
const executeApprovedAction = createApprovedActionExecutor({
  sourceFor: sourceForCoordinationRun,
  gate: approvalService.gate,
  computerTools: approvalComputerTools,
  hostTools: ({ actorId, botId, initiator }) =>
    hostAccessTools({
      broker: hostAccessBroker,
      botId,
      actorId,
      initiator,
      auditStore: bootAuditStore,
    }),
  callTool: (input) => pluginStore.callTool(input),
  credentialActorFor: (actorId, botId, ref) =>
    teamBots.credentialActorFor(actorId, botId)(ref),
  coordinationCall: (input) => coordination.call(input),
  readRun: (value) => readApprovedRunAssertion(value, config.keyEncryptionKey),
  answer: vendorAnswer,
  privateShareToolRef: PRIVATE_SHARE_TOOL_REF,
  refusalMarker: REFUSAL_MARKER,
  personInitiator: PERSON_INITIATOR,
});
const approvalContinuationRunner = createTurnRunner({
  admission: serverTurnAdmission,
  threads,
  runner: routineAgentRunner,
  components: componentCatalog,
  buildAgentFor,
  toolsForTurn: async ({ ownerUserId, agentId, initiator }) =>
    approvalComputerTools(ownerUserId, agentId, initiator),
});
// The drawer's channels, and the Bot's hello in a new one. See openduet/channels.ts.
const openDuetChannels = createDuetChannelStore({
  database,
  channels: channelStore,
  hello: createChannelHello({
    channels: channelStore,
    actorFor,
    runTurn: approvalContinuationRunner,
  }),
});
/**
 * Conversations with several Bots. Each Bot turn is an ordinary headless AG-UI turn into that Bot's
 * own group thread, built exactly as a routine's is, so governance and the computer tools
 * apply unchanged; Bots answering each other reuse the handoff desk's grant and caps.
 */
const groupConversations = createGroupConversations({
  store: createGroupStore(database, () => threadIdentity.mint()),
  queue: createWorkQueue(database),
  owner: workOwner("group"),
  roster: async (ownerUserId, channelId) => {
    const actor = await actorFor(ownerUserId);
    const channel = await channelStore.get(actor, channelId);
    if (!channel || channel.agentIds.length < 2) return null;
    const bots: { id: string; name: string }[] = [];
    for (const agentId of channel.agentIds) {
      const profile = await agentProfileStore.get(actor, agentId);
      if (profile) bots.push({ id: agentId, name: profile.name });
    }
    return bots;
  },
  runTurn: createTurnRunner({
    admission: serverTurnAdmission,
    threads,
    runner: routineAgentRunner,
    components: componentCatalog,
    buildAgentFor,
    toolsForTurn: async ({ ownerUserId, agentId, initiator }) => {
      if (!computerGateway) return [];
      const actor = await actorFor(ownerUserId);
      const profile = await agentProfileStore.get(actor, agentId);
      if (!profile) throw new Error("That Bot is not available to this owner.");
      return createHeadlessComputerTools({
        gateway: computerGateway,
        botId: agentId,
        actor: { id: actor.id, userId: actor.id, initiator },
        auditStore: bootAuditStore,
        ...(signInService ? { signIn: signInService } : {}),
      });
    },
  }),
  caps: config.handoff,
  // The handoff desk's own grant check, read per hop and failing closed.
  mayAddress: async (fromBotId, toBotId) =>
    (
      await pluginStore.botsReachableFrom(fromBotId).catch(() => [] as string[])
    ).includes(toBotId),
  auditStore: bootAuditStore,
  activity: async (turn, agentId, text, sourceId) =>
    channelStore.recordActivity(
      await actorFor(turn.ownerUserId),
      turn.channelId,
      { text, agentId, at: new Date() },
      { id: sourceId },
    ),
  busy: async (turn, busy) =>
    channelStore.signalChannelBusy(
      await actorFor(turn.ownerUserId),
      turn.channelId,
      busy,
      `group:${turn.messageId}`,
    ),
  createChannel: async (ownerUserId, agentIds) =>
    channelStore.create(await actorFor(ownerUserId), agentIds),
  // The owner says whether a Bot's words may reach the other people in a group.
  privateShare: createPrivateShareCheck({ approvals: approvalService.store }),
  // A Team Bot's consent card raised in a group turn is drawn in the shared transcript.
  listenForConsent: (ownerUserId, agentId) =>
    teamBots.listenForConsent(ownerUserId, agentId),
});

const approvalSweep = repeatAfterEach(
  createApprovalResumeTick({
    threads,
    approvalQueue,
    approvalOwner,
    approvalService,
    executeApprovedAction,
    database,
    responsibilityStore,
    groupConversations,
    // The continuation after a decision is server work the browser never started: announce it.
    approvalContinuationRunner: signallingBusy(
      approvalContinuationRunner,
      (threadId, busy, runId) => channelStore.signalBusy(threadId, busy, runId),
    ),
    channelStore,
    actorFor,
    // Assigned further down, once delivery is wired.
    notify: (scope, input) => deliveryNotifications(scope, input),
  }),
  2_000,
);
const deliveryProviders = configuredDeliveryProviders(
  config.publicUrl ?? config.auth?.baseUrl ?? `http://localhost:${config.port}`,
);
// Slack channel membership for triggers is answered by OpenTag, which holds the workspace token.
useSlackChannelMembership((input) =>
  deliveryProviders.slack
    ? deliveryProviders.slack.isMember(input)
    : Promise.resolve(false),
);
const authoriseDeliveryScope = async (scope: DeliveryScope) =>
  (await deliveryScopeFor(scope.ownerUserId, scope.channelId, scope.agentId))
    ?.threadId === scope.threadId;
const deliveryRouter = createDeliveryRouter({
  store: deliveryStore,
  queue: createWorkQueue(database),
  owner: workOwner("delivery"),
  providers: deliveryProviders,
  authoriseScope: authoriseDeliveryScope,
  notifyEvent: (event) => responsibilityEngine.ingest(event),
  runTurn: async (input) => {
    if (!(await authoriseDeliveryScope(input)))
      throw new Error(
        "The delivery owner no longer has access to this conversation.",
      );
    const actor = await actorFor(input.ownerUserId);
    await channelStore.recordActivity(
      actor,
      input.channelId,
      { text: input.text, agentId: null, at: new Date() },
      { id: `delivery-input:${input.runId}` },
    );
    await channelStore.signalBusy(input.threadId, true, input.runId);
    try {
      const result = await approvalContinuationRunner({
        ownerUserId: input.ownerUserId,
        routineId: `delivery:${input.runId}`,
        runId: input.runId,
        agentId: input.agentId,
        threadId: input.threadId,
        instruction: input.text,
        userMessage: {
          id: `delivery:${input.runId}`,
          role: "user",
          content: input.text,
        },
        initiator: PERSON_INITIATOR,
        signal: input.signal,
      });
      if (result.replyText)
        await channelStore.recordActivity(
          actor,
          input.channelId,
          { text: result.replyText, agentId: input.agentId, at: new Date() },
          { id: `delivery-reply:${input.runId}` },
        );
      return result;
    } finally {
      await channelStore.signalBusy(input.threadId, false, input.runId);
    }
  },
  audit: (event) =>
    recordAuditEvent(bootAuditStore, {
      actorUserId: event.ownerUserId,
      initiator: PERSON_INITIATOR,
      eventType:
        event.kind === "inbound"
          ? "delivery.received"
          : event.kind === "sms_opt_out"
            ? "delivery.opted_out"
            : event.state === "failed"
              ? "delivery.failed"
              : "delivery.sent",
      targetType: "channel",
      targetId: event.channelId,
      payload: { deliveryId: event.id, kind: event.kind, state: event.state },
    }),
});
deliveryNotifications = (scope, input) => deliveryRouter.notify(scope, input);

/*
 * Proactive research: an opted-in Bot reading its owner's apps in the background, restricted to
 * reads by its initiator (see proactive/restriction.ts), through the same headless turn runner and
 * work queue as routines. Suggestions go to the web inbox and the owner's delivery routing.
 */
const proactiveStore = createProactiveStore(database);
conversationSaid = (ownerUserId, channelId, activity) => {
  void proactiveStore
    .noteConversation(ownerUserId, channelId, activity)
    .catch((error: unknown) =>
      console.error(
        JSON.stringify({
          type: "started-task-conversation-error",
          error: error instanceof Error ? error.name : "UnknownError",
          timestamp: new Date().toISOString(),
        }),
      ),
    );
};
/*
 * One runner for research and for the check-in it writes: only the engine's own tools and refusals,
 * no computer and no components. A check-in is NOT run through `approvalContinuationRunner` as a
 * started task is, because that runner offers the Bot's computer, and a check-in only offers cards.
 */
const proactiveRunTurn = createTurnRunner({
  admission: serverTurnAdmission,
  threads,
  runner: routineAgentRunner,
  buildAgentFor,
  toolsForTurn: (input) => proactiveEngine.toolsForTurn(input),
  turnTimeoutMs: 3 * 60_000,
});
const taskReplyContext = createTaskReplyContext({
  load: (scope, id) =>
    loadAttachmentForTurn(
      database,
      { actorId: scope.ownerUserId, threadId: scope.threadId },
      id,
    ),
  markSent: (scope, ids) =>
    markAttachmentsSent(
      database,
      { actorId: scope.ownerUserId, threadId: scope.threadId },
      ids,
    ),
  skillsFor: (agentId) => pluginStore.listForAgent(agentId),
});
const proactiveEngine = createProactiveEngine({
  acceptReplyContext: taskReplyContext.accept,
  store: proactiveStore,
  queue: createWorkQueue(database),
  owner: workOwner("proactive"),
  runTurn: proactiveRunTurn,
  resolveScope: deliveryScopeFor,
  notify: (scope, input) => deliveryNotifications(scope, input),
  // Started work runs as a task, in a conversation of its own. See openduet/task-threads.ts.
  tasks: createTaskThreads({
    database,
    store: openDuetTasks,
    channels: channelStore,
    actorFor,
    scopeFor: deliveryScopeFor,
  }),
  startTask: createTaskTurn({
    replyContext: taskReplyContext,
    channels: channelStore,
    actorFor,
    runTurn: approvalContinuationRunner,
  }),
  /*
   * The Bot writing first, in the setting's conversation, which is Chat. Like a task's turn, except
   * nobody spoke: no line is recorded for the person, the message is the framed check-in, and the initiator
   * is the check-in's, so the turn holds `offer_task` and nothing else. The reply is recorded as the
   * Bot's, which is what tells an open Chat to read the thread again.
   */
  checkIn: async (scope, input) => {
    const actor = await actorFor(scope.ownerUserId);
    const result = await proactiveRunTurn({
      ...scope,
      routineId: input.runId,
      instruction: input.text,
      userMessage: { id: input.runId, role: "user", content: input.text },
      initiator: input.initiator,
      runId: input.runId,
      signal: input.signal,
    });
    if (result.replyText)
      await channelStore.recordActivity(
        actor,
        scope.channelId,
        { text: result.replyText, agentId: scope.agentId, at: new Date() },
        { id: `${input.runId}:reply` },
      );
  },
  catalogue: pluginStore,
  deniedToolNames: async (ownerUserId, agentId, initiator) => {
    const [tools, allowed] = await Promise.all([
      loadToolsForActor(ownerUserId)(agentId),
      allowedForRun(initiator, proactiveReadOnlyRefs),
    ]);
    return tools
      .filter((tool) => !allowed.has(tool.ref) && !allowed.has(tool.name))
      .map((tool) => tool.name);
  },
  mintThreadId: () => threadIdentity.mint(),
});
const proactiveSweep = repeatAfterEach(async () => {
  try {
    await proactiveEngine.sweep();
  } catch (error) {
    console.error(
      JSON.stringify({
        type: "proactive-sweep-error",
        error: error instanceof Error ? error.name : "UnknownError",
        timestamp: new Date().toISOString(),
      }),
    );
  }
}, 60_000);
/*
 * Follow-ups a Bot scheduled for itself: one headless turn each, through the same turn runner as a
 * routine, into the person's conversation with that Bot. See agents/wake-up.ts.
 */
const wakeUpQueue = createWorkQueue(database);
const wakeUpRunner = createWakeUpRunner({
  queue: wakeUpQueue,
  store: wakeUpStore,
  owner: workOwner("wake-up"),
  actorFor,
  channels: channelStore,
  runTurn: createTurnRunner({
    admission: serverTurnAdmission,
    threads,
    runner: routineAgentRunner,
    components: componentCatalog,
    buildAgentFor,
    toolsForTurn: async ({ ownerUserId, agentId, initiator }) => {
      if (!computerGateway) return [];
      const actor = await actorFor(ownerUserId);
      const profile = await agentProfileStore.get(actor, agentId);
      if (!profile) throw new Error("That Bot is not available to this owner.");
      return createHeadlessComputerTools({
        gateway: computerGateway,
        botId: agentId,
        actor: { id: actor.id, userId: actor.id, initiator },
        auditStore: bootAuditStore,
        ...(signInService ? { signIn: signInService } : {}),
      });
    },
  }),
  notify: (scope, input) => deliveryNotifications(scope, input),
});
const wakeUpSweep = repeatAfterEach(async () => {
  try {
    const report = await wakeUpRunner.sweep();
    if (report.ran.length || report.skipped.length)
      console.info(JSON.stringify({ type: "bot-follow-up", ...report }));
  } catch (error) {
    console.error(
      JSON.stringify({
        type: "bot-follow-up-error",
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
      }),
    );
  }
}, 5_000);
const wakeUpReaper = repeatAfterEach(async () => {
  await wakeUpRunner.reap().catch(() => 0);
}, 60 * 60_000);
const deliverySweeps = DELIVERY_WORK_KINDS.map((kind) =>
  repeatAfterEach(async () => {
    try {
      await deliveryRouter.sweep(kind);
    } catch (error) {
      console.error(
        JSON.stringify({
          type: "delivery-worker-error",
          kind,
          errorType: error instanceof Error ? error.name : "UnknownError",
        }),
      );
    }
  }, 2_000),
);

const personResponseOwner = workOwner("person-response");
const groupSweep = repeatAfterEach(async () => {
  try {
    while (await groupConversations.sweep()) {}
  } catch (error) {
    console.error(
      JSON.stringify({
        type: "group-sweep-error",
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
      }),
    );
  }
}, 1_000);

const personResponseSweep = repeatAfterEach(
  createPersonResponseTick({
    approvalQueue,
    database,
    personResponseOwner,
    authoriseQuestion,
    approvalContinuationRunner,
    responsibilityStore,
    responsibilityAnswerTurn,
    sourceForCoordinationRun,
    channelStore,
    actorFor,
    // Assigned further down, once delivery is wired.
    notify: (scope, input) => deliveryNotifications(scope, input),
  }),
  2_000,
);

/**
 * Delivering hops, on every replica.
 *
 * A loop rather than a schedule, because a hop is somebody waiting for an answer rather than
 * housekeeping: the culler's minute-granularity CronJob would be an unexplainable pause in a
 * conversation. Every replica sweeps, and the queue decides which of them gets which hop, so adding a
 * replica adds delivery capacity rather than contention.
 *
 * Only where the capability is switched on. A deployment with a depth cap of zero never has a hop to
 * deliver, and a loop polling for work that cannot exist is a query a second for nothing.
 */
/*
 * Both zeros switch the capability off, so both have to stop the loop.
 *
 * Gated on the depth alone, a deployment that set the fan-out cap to zero still swept every two
 * seconds for hops that can never be offered: roughly forty thousand claim transactions per replica
 * per day, for a feature it had turned off.
 */
/**
 * The queue's own wake-up, when handing work between Bots is switched on at all.
 *
 * Held at module scope so the shutdown below can give its connection back. Undefined on a
 * deployment with the capability off, which is a deployment that never started one.
 */
let workOfferedListener: WorkOfferedListener | undefined;

if (config.handoff.maxDepth > 0 && config.handoff.maxPerRun > 0) {
  workOfferedListener = await startHandoffDelivery({
    config,
    database,
    bootAuditStore,
    actorFor,
    localRuntime,
    groupConversations,
    channelStore,
  });
}

/*
 * And dropping the hops that are over, whether or not the capability is switched on.
 *
 * OUTSIDE THE GATE ABOVE, deliberately. A deployment that switches handing work off still has
 * whatever it made while it was on, and rows that stop being reaped are rows that stay at the head
 * of the queue: switched back on a month later, the first thing that happens is a month-old question
 * being delivered to somebody who has long since stopped waiting. Reaping is housekeeping about the
 * past rather than part of the feature.
 *
 * Every replica reaps; the statement is a delete by age, so two doing it is the same as one doing it.
 * Its own loop rather than a phase of the sweep, so an hour of failing to reap never delays an answer.
 */
const handoffQueue = createWorkQueue(database);
repeatAfterEach(
  async () => {
    try {
      const purged = await handoffQueue.purge({kind:HANDOFF_KIND,olderThanMs:24*60*60_000,maxAttempts:DEFAULT_MAX_ATTEMPTS});
      if (purged > 0) {
        console.info(JSON.stringify({ type: "bot-handoff-reaped", purged }));
      }
    } catch (error) {
      console.warn(
        "[handoff] hops that are over could not be dropped:",
        error instanceof Error ? error.message : error,
      );
    }
  },
  60 * 60 * 1_000,
);

/*
 * Naming conversations, in the API process rather than `worker/`, which the single-image container
 * does not run. Its own loop, so a slow model never delays a hop.
 */
const channelSummaries = {
  database,
  queue: createWorkQueue(database),
  transcript: threads,
  title: createChannelTitler({
    model: runtimeModel.defaultModel,
    resolveApiKey: resolveRuntimeModelApiKey,
  }),
  owner: workOwner("summariser"),
};
repeatAfterEach(async () => {
  try {
    await offerChannelsAwaitingSummary(channelSummaries);
    const report = await summariseClaimedChannels(channelSummaries);
    if (report.written.length > 0) {
      console.info(
        JSON.stringify({ type: "channel-summaries", written: report.written }),
      );
    }
    // Same pass: one statement, deletes by age, and two replicas running it changes nothing.
    await forgetSettledSummaries(channelSummaries);
  } catch (error) {
    // Never fatal, and never loud enough to drown the log: a deployment with no model configured
    // reaches this on every pass, and it has not gone wrong, it simply has no titles.
    console.warn(
      "[channels] conversations could not be named:",
      error instanceof Error ? error.message : error,
    );
  }
}, 10_000);

/*
 * Enterprise controls (server/src/admin): capability switches, SSO-required, SCIM offboarding,
 * computer termination, network policy push, Action Recording, the model allowlist and the
 * OpenTelemetry/SIEM export of the audit trail. Installed before the app so the computer boundary,
 * the HTTP gate and the guarded stores below all see it from the first request.
 */
await installEnterpriseControls({
  database,
  databaseUrl: config.databaseUrl,
  auditStore: bootAuditStore,
  ...(computerProvider ? { provider: computerProvider } : {}),
  builtInModel: `${runtimeModel.provider}/${runtimeModel.defaultModel}`,
  people: peopleStore,
  initialAdminEmails: config.auth?.initialAdminEmails ?? [],
});
guardDeliveryStore(
  deliveryStore,
  bootAuditStore,
  (message) => new DeliveryRefusedError(message),
);
guardHostAccess(
  hostAccessBroker,
  (message) => new HostAccessRefusedError(message),
);
auditRoutineStore(routineStore, bootAuditStore);

const identityGithubCallback =
  config.githubApp && config.publicUrl
    ? githubCallbackRoutes({
        clientId: config.githubApp.clientId,
        clientSecret: config.githubApp.clientSecret,
        publicUrl: config.publicUrl,
        appUrl: config.appUrl,
        encryptionKey: config.keyEncryptionKey,
        personIsActive: async (userId) => {
          const person = await peopleStore.find(userId);
          return person !== undefined && !person.revoked;
        },
        credentials: credentialStore,
        identity: identityStore,
        auditStore: bootAuditStore,
      })
    : undefined;

const app = createApp(
  config,
  auth,
  createAuditReader(database),
  createCredentialAdminService(
    config.keyEncryptionKey,
    credentialStore,
    createAuditStore(database),
  ),
  createPackageStatusReader(database),
  // The runtime call: the model, per-actor agent loading, and the two identity
  // functions are how a run is attributed to a person.
  localRuntime.handler,
  // The only path to an acting call.
  computerGateway,
  // Bots as durable objects, and the channels they run in.
  agentProfileStore,
  channelStore,
  channelEvents,
  // The same store the boot row uses, so a Bot's own refusal lands in the trail beside its actions.
  bootAuditStore,
  componentStore,
  // MCP servers and packaged skills. Judged by the same policy the computer actions are, read
  // fresh on every call for the same reason: a rule added a moment ago applies to the next call.
  pluginStore,
  // Components authored in the browser. Their governance is the component store's; this owns only
  // the source, which is the part a rebuild would otherwise have owned.
  sandboxedStore,
  // How a thread that has no channel is named, so the direct Bot chat is in the same namespace.
  threadIdentity,
  // Who has signed in, and what an administrator may do about them.
  peopleStore,
  // The enterprise identity providers registered here. Read as facts about the deployment rather
  // than through Better Auth's own listing, which answers per person. See identity-provider-store.ts.
  identityProviderStore,
  // Chooses the coworker for an untagged message, on the deployment's own model and key.
  intentRouter,
  // What a browsing turn's screen looked like when it finished, so the transcript can show it later.
  pageFrameStore,
  // What a due routine actually does: a turn, run as its owner, into the thread they will open.
  routineRunner,
  // A person's own standing instructions: the list, and a switch to stop one.
  routineStore,
  // The same store every run reads through `loadInstructionsForActor`, so the screen a person edits
  // and the prompt their coworker is built from can never be two different pieces of text.
  userInstructionsStore,
  // The same database every other store here is built from, so a channel's staged and sent files
  // live behind the same connection as the messages that reference them.
  database,
  // Native host-folder sessions are session-only: grants disappear with this server process and the
  // desktop worker must authenticate with a fresh token for this run.
  hostAccessBroker,
  process.env.OPENBOT_DESKTOP_HOST_TOKEN,
  async (input) => {
    const proactiveRefusal = await guardProactiveCallback(
      input,
      proactiveReadOnlyRefs,
    );
    if (proactiveRefusal) return proactiveRefusal;
    const coordinated = await coordination.call(input);
    if (coordinated) return coordinated;
    const followUp = wakeUpTools({
      store: wakeUpStore,
      ownerUserId: input.actorId,
      agentId: input.botId,
      ...(input.initiator ? { initiator: input.initiator } : {}),
    }).find((candidate) => candidate.name === input.name);
    if (followUp) {
      const text = await followUp.execute(input.args, input.context);
      return { text, isError: text.startsWith(REFUSAL_MARKER) };
    }
    const { name, args, botId, actorId, initiator } = input;
    const memory = memoryTools({
      store: personalMemoryStore,
      ingestion: memoryIngestion,
      ownerUserId: actorId,
      agentId: botId,
    }).find((candidate) => candidate.name === name);
    if (memory) {
      const text = await memory.execute(args, input.context);
      return { text, isError: text.startsWith(REFUSAL_MARKER) };
    }
    if (!name.startsWith("host_")) return null;
    const tool = hostAccessTools({
      broker: hostAccessBroker,
      botId,
      actorId,
      auditStore: bootAuditStore,
      ...(initiator ? { initiator } : {}),
    }).find((candidate) => candidate.name === name);
    if (!tool) {
      return {
        text: `${REFUSAL_MARKER} That host tool is not available for this Bot right now.`,
        isError: true,
      };
    }
    const text = await tool.execute(args, input.context);
    return { text, isError: text.startsWith(REFUSAL_MARKER) };
  },
  // The app directory, behind the same client the plugin store and the transport already share.
  // Absent without a key, which leaves the routes reporting no broker rather than listing apps
  // nobody could connect.
  composio ?? undefined,
  process.env.OPENBOT_MODEL_OAUTH_FILE?.trim()
    ? createProviderOAuthProxy(process.env.OPENBOT_MODEL_OAUTH_FILE.trim())
    : undefined,
  createUserPreferencesStore(database),
  {
    store: createVoiceSessionStore(database, channelStore),
    summarize: createVoiceSummarizer({
      model: runtimeModel,
      resolveApiKey: resolveRuntimeModelApiKey,
    }),
    channels: channelStore,
  },
  {
    runtimeThreads: threads,
    approvals: approvalService,
    shared: { modes: accountModes, use: sharedUseStore },
    ...(signInService ? { passwords: signInService } : {}),
    demonstrations: {
      store: demonstrationStore,
      recorder: demonstrationRecorder,
    },
    delivery: {
      authenticated: {
        store: deliveryStore,
        router: deliveryRouter,
        scopeFor: deliveryScopeFor,
        listConversations: async (owner, cursor) =>
          channelStore.list(await actorFor(owner), { cursor, limit: 100 }),
        history: (scope) =>
          threads.getThreadMessages({
            threadId: scope.threadId,
            userId: scope.ownerUserId,
          }),
        slack: deliveryProviders.slack,
        twilio: deliveryProviders.sms,
        pushProjectId: deliveryProviders.pushProjectId,
      },
      webhooks: {
        store: deliveryStore,
        router: deliveryRouter,
        approvals: approvalService,
        scopeFor: deliveryScopeFor,
        slack: deliveryProviders.slack,
        twilio: deliveryProviders.sms,
        identity: slackCodeRedeemer(identityStore, bootAuditStore),
      },
    },
    memory: { store: personalMemoryStore, ingestion: memoryIngestion },
    proactive: { store: proactiveStore, engine: proactiveEngine },
    openduet: {
      pages: openDuetPages,
      tasks: openDuetTasks,
      // The optional setup checklist. Facts and verdicts about this configuration, never values.
      setup: createSetupSources({
        productName: tenantPackage.productName,
        config,
        environment: process.env,
        model: {
          provider: runtimeModel.provider,
          keyId: tenantPackage.model.credentialSecretRef,
          defaultModel: runtimeModel.defaultModel,
          plan: Boolean(runtimeModel.plan),
          check: checkModelAvailability,
        },
        credentials: credentialStore,
        plugins: pluginStore,
        computer: Boolean(config.computer),
        apps: {
          configured: Boolean(composio),
          provider: composio?.provider ?? config.brokerProvider ?? "composio",
        },
        chat: Boolean(deliveryProviders.slack),
      }),
      intake: openDuetIntake,
      report: openDuetReport,
      channels: openDuetChannels,
    },
    responsibilities: {
      store: responsibilityStore,
      engine: responsibilityEngine,
      bindings: responsibilityBindings,
      triggers: responsibilityTriggers,
    },
    groups: groupConversations,
    teamBots,
    lifecycle: {
      lifecycle: createBotLifecycleStore(database),
      reset: createBotReset({
        database,
        softDeleteChannel: (actor, channelId) =>
          channelStore.softDelete(actor, channelId),
      }),
      activity: createActivityStore(database, input => localRuntime.runner.stop(input)),
      wakeUps: wakeUpStore,
      profiles: agentProfileStore,
      auditStore: bootAuditStore,
    },
  },
  identityStore,
  identityGithubCallback,
);

const { addresses: listening } = startHttpServer({
  port,
  config,
  resolveRequestActor,
  computerGateway,
  demonstrationStore,
  demonstrationRecorder,
  app,
});

// Each listener holds a connection of its own for the life of the process. Released on the way out,
// so a watch-mode restart does not leave two behind on every reload.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    channelBusySweep.stop();
    responsibilitySweep.stop();
    wakeUpSweep.stop();
    wakeUpReaper.stop();
    memorySweep.stop();
    proactiveSweep.stop();
    approvalSweep.stop();
    personResponseSweep.stop();
    groupSweep.stop();
    for (const sweep of deliverySweeps) sweep.stop();
    void Promise.allSettled([
      threads.close(),
      channelActivityListener.stop(),
      policyListener.stop(),
      // Started only where handing work between Bots is switched on, so it is often not there.
      workOfferedListener?.stop() ?? Promise.resolve(),
      Promise.resolve(retentionSweeps.stop()),
    ]).finally(() => process.exit(0));
  });
}

/*
 * The product's own name, from the tenant package, because this is the line a person reads when the
 * server comes up. Nothing parses it. And what it actually bound, not a constant: this said
 * 127.0.0.1 for as long as the server listened on every interface, which is how a single-user
 * install could be the administrator to the whole network while its own log said otherwise.
 */
console.info(`${tenantPackage.productName} server listening on ${listening.join(" and ")}`);
