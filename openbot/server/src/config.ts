import {
  LISTEN_HOST_VARIABLE,
  type ListenHost,
  listenHosts,
} from "@openbot/shared/listen-host";
import { listenPort } from "@openbot/shared/listen-port";
import {
  type TranscriptionConfig,
  transcriptionConfig,
} from "./dictation/config";
import type { BrokerProvider } from "./plugins/access";
import { type VoiceConfig, voiceConfig } from "./voice/config";

export type RuntimeCapabilities = {
  mode: "local";
  durableHistory: true;
};

export type DockerComputerConfig = {
  provider: "docker";
  baseUrl: string;
};

export type SharedComputerConfig = {
  provider: "shared";
  baseUrl: string;
};

/**
 * A computer each, created by the cluster.
 *
 * The namespace is the whole scope: the service account this runs under may manage Sandboxes there
 * and nowhere else, which is a smaller blast radius than the Docker supervisor's, since that one
 * holds a socket that is root-equivalent on its host.
 */
export type SandboxComputerConfig = {
  provider: "sandbox";
  namespace: string;
  idleAfterMs: number;
  /** Where the chart mounted the shape of a computer. */
  templateFile: string;
};

export type ComputerConfig =
  | DockerComputerConfig
  | SharedComputerConfig
  | SandboxComputerConfig;

/**
 * Who a deployment lets in, and through which front door.
 *
 * One identity provider is a product decision somebody else already made. A company running this
 * has Google or Entra or Okta and is not going to acquire another, so the shape here is a set of
 * optional providers rather than one required one, and the deployment turns on whichever it has.
 */
export type AuthProviderId = "google" | "microsoft" | "okta";

/** An OAuth client, as every provider here needs one. */
export type OAuthClient = { clientId: string; clientSecret: string };

export type GithubAppConfig = {
  clientId: string;
  clientSecret: string;
};

export type AuthConfig = {
  baseUrl?: string;
  secret?: string;
  initialAdminEmails: string[];
  google?: OAuthClient;
  /**
   * `tenantId` decides who may sign in at all, so it is not a detail. `common` admits any Microsoft
   * account including personal ones, `organizations` any work or school account anywhere, and a GUID
   * admits one directory. A deployment that wants only its own company needs the GUID.
   */
  microsoft?: OAuthClient & { tenantId: string };
  /** Okta is an OIDC provider rather than a named one, so it is identified by its issuer. */
  okta?: OAuthClient & { issuer: string };
};

/**
 * The providers this deployment can actually sign somebody in with.
 *
 * Ordered, and deliberately not alphabetically: this is the order the buttons appear in, and it is
 * fixed here rather than left to object key order so the sign-in screen cannot change shape because
 * of how a configuration happened to be written.
 */
export function configuredAuthProviders(
  auth: AuthConfig | undefined,
): AuthProviderId[] {
  if (!auth) return [];
  const providers: AuthProviderId[] = [];
  if (auth.google) providers.push("google");
  if (auth.microsoft) providers.push("microsoft");
  if (auth.okta) providers.push("okta");
  return providers;
}

export type ManagedAgentConfig = {
  /** The bundled Bot, absent when this deployment's provider cannot run it. */
  endpoint?: URL;
  /**
   * The harness picked during setup, when there is one.
   *
   * The endpoint of the installed harness.
   */
  alsoRun?: URL;
};


export type DeploymentConfig = {
  /**
   * Memory sources and background research OpenBot switches on for each person (memory/defaults.ts).
   * Both on unless OPENBOT_MEMORY_SOURCE_DEFAULTS or OPENBOT_PROACTIVE_DEFAULTS is "false" or "0".
   * Switching either off stops new defaults and leaves every existing row as it is.
   */
  memoryDefaults: { sources: boolean; research: boolean };
  /** Audio configuration is independent of agent model providers. */
  transcription?: TranscriptionConfig;
  voice?: VoiceConfig;
  /** The port the API listens on. Named `PORT` or `SERVER_PORT`; see `serverPort`. */
  port: number;
  /**
   * Where the API listens: `OPENBOT_HOST`, or the platform default
   * when no host is configured. See `shared/listen-host.ts`.
   */
  listen: ListenHost[];
  databaseUrl: string;
  keyEncryptionKey: string;
  /**
   * Endpoints for the bundled Bot and/or the installed picked harness.
   *
   * The bundled endpoint is optional: plan credentials can run a picked harness without it.
   * Its presence, not this auth configuration, determines whether a bundled Bot is available.
   */
  managedAgent?: ManagedAgentConfig;
  /**
   * The name used to scope locally minted conversation identifiers.
   *
   * Absent, the tenant package's id stands in, which separates deployments running different
   * packages but not a copy of one running alongside the original. See channels/thread-identity.ts.
   */
  deploymentId: string | undefined;
  /**
   * The key this deployment talks to Composio with, the broker that holds people's accounts for a
   * few hundred apps so a Bot can act in Gmail or Slack without an OAuth client of this
   * deployment's own registered with each of them.
   *
   * Optional, and undefined is the ordinary state rather than a degraded one. A deployment that has
   * not bought Composio is not a deployment missing something: there is nothing to connect, nothing
   * to grant and no Composio tool for a Bot to call, what remains on screen is one row that goes
   * nowhere under More apps on the admin Plugins page naming this variable, and nothing else it does
   * is any worse for that.
   *
   * Nothing here validates the key. There is no shape to check it against and no call worth making
   * at boot to find out, so the first real request is what says whether it works — which is also
   * where a key that was revoked last week would have surfaced regardless.
   */
  composioApiKey: string | undefined;
  /** GitHub App user sign-in, so people can link their GitHub account. Both or neither of GITHUB_APP_CLIENT_ID / GITHUB_APP_CLIENT_SECRET. */
  githubApp?: GithubAppConfig;
  /**
   * The Arcade API key, from `ARCADE_API_KEY`. Unset is the ordinary state. Trimmed and never
   * validated here, for the same reason as `composioApiKey`.
   */
  arcadeApiKey: string | undefined;
  /**
   * Which tool broker the operator asked for, from `OPENBOT_BROKER_PROVIDER`. Only read and
   * validated here: which provider is active is decided elsewhere. Unset is `undefined`.
   */
  brokerProvider: BrokerProvider | undefined;
  /**
   * Where this deployment is reached from outside, with no trailing slash.
   *
   * Needed because an OAuth redirect URI has to match what an administrator registered with the
   * vendor character for character, and it is shown on the Plugins page for them to copy. Built from
   * configuration rather than from the incoming request: a redirect URI assembled out of a Host
   * header is one an attacker has a say in.
   *
   * `OPENBOT_PUBLIC_URL` when set, otherwise `BETTER_AUTH_URL`, which is the same public address for
   * every deployment that has real sign-in. Undefined only where neither exists, which is a local
   * deployment running without authentication — and there is nothing to connect there anyway.
   */
  publicUrl: string | undefined;
  /**
   * Where the browser app is served from, with no trailing slash.
   *
   * Separate from {@link DeploymentConfig.publicUrl} because they are genuinely two addresses: the
   * app is a Vite process on its own port locally, and the API is another. An OAuth callback lands on
   * the API and has to send the person back to a page, so a relative redirect would put them on the
   * API's origin, where no page exists.
   *
   * `OPENBOT_APP_URL` when set.
   * Falls back to the API's own public URL, which is right for a
   * deployment serving both from one origin.
   */
  appUrl: string | undefined;
  tenantPackageDirectory: string;
  runtime: RuntimeCapabilities;
  /**
   * How long a Bot's stream may say nothing before this deployment ends the turn, in milliseconds.
   *
   * Zero means no watchdog, and an unset variable means zero. A turn that is ended is a turn
   * somebody loses, so a deployment that has not said it wants that gets the behaviour it already
   * had. `.env.example` ships a value, so a new clone starts with the watch on and an upgraded
   * deployment does not acquire it without being asked.
   */
  agentStallTimeoutMs: number;
  /**
   * How many days of audit trail this deployment keeps, or undefined to keep everything.
   *
   * Undefined by default. Deleting somebody's audit trail because a default said so is the worse of
   * the two failures, and a deployment that has not thought about retention should keep everything
   * until it has.
   */
  auditRetentionDays: number | undefined;
  oauth: {
    google?: { clientId: string; clientSecret: string };
  };
  auth?: AuthConfig;
  /**
   * Admit everybody as one fixed administrator instead of requiring sign-in.
   *
   * True only when no identity provider is configured. See auth/dev-actor.ts for what stops this
   * reaching somewhere other people can get to.
   */
  singleUser: boolean;
  /**
   * Where the built app is, when this process serves it.
   *
   * Set in a container image that carries both. Unset in development, where Vite serves the app and
   * proxies the API here, so the server stays an API and nothing shadows a route.
   */
  appDistDir?: string;
  /**
   * The Bot computer. Absent means the feature is off and its routes are not mounted, rather than
   * mounted and failing: a capability that is not configured should be missing, not broken.
   */
  computer?: ComputerConfig;
  /**
   * The secret a Bot presents when it calls a tool back through this server.
   *
   * A framework Bot runs its own tool loop, in its own process, which is what makes it a real
   * harness rather than a shape the browser drives. It still may not reach a vendor directly: it
   * calls here, and here is where the grant, the policy and the audit row are. This is what tells
   * that call apart from anybody else on the network.
   *
   * Absent means no Bot may call tools back, and a deployment that wanted them gets a refusal rather
   * than an open door.
   */
  agentToolToken?: string;
  /**
   * The secret the worker presents when it hands a routine run back to this server.
   *
   * Absent means the internal routines endpoint refuses everything, which is the correct state of a
   * deployment with no worker — a deployment that has not asked for scheduled turns should not have a
   * door for them standing open.
   */
  workerSharedSecret?: string;
};

type Environment = Record<string, string | undefined>;

function required(environment: Environment, name: string): string {
  const value = environment[name]?.trim();
  if (!value) {
    throw new Error(`${name} must be configured`);
  }
  return value;
}

function optional(environment: Environment, name: string): string | undefined {
  return environment[name]?.trim() || undefined;
}

function brokerProvider(environment: Environment): BrokerProvider | undefined {
  const raw = optional(environment, "OPENBOT_BROKER_PROVIDER");
  if (raw === undefined) return undefined;
  if (raw !== "composio" && raw !== "arcade") {
    throw new Error(
      `OPENBOT_BROKER_PROVIDER must be "composio" or "arcade", got "${raw}". Leave it unset to choose by which API key is configured.`,
    );
  }
  return raw;
}

/**
 * Whether this deployment says it is in production, which is what the two hard refusals turn on.
 *
 * ONE PLACE, BECAUSE THE TWO GATES DID NOT AGREE. Both refuse a local-only setting on a deployed
 * server — the example encryption key, and private-host browsing — and both compare `NODE_ENV`
 * against `"production"`. The private-hosts gate read it through `optional`, so the comparison
 * trimmed; the key gate compared `environment.NODE_ENV` raw.
 *
 * Both sides of that comparison come out of the same file. `NODE_ENV=production ` with a trailing
 * space — invisible in an env file, and preserved verbatim by Docker's `env_file` and by every
 * hosting dashboard with a text box — therefore tripped one refusal and slipped past the other. The
 * one it slipped past is the one that decides whether the credential vault may be encrypted with a
 * key printed in this repository.
 *
 * A helper rather than a second `optional` call, so the next gate that needs this question cannot
 * pick the wrong way to ask it.
 */
function isProduction(environment: Environment): boolean {
  return optional(environment, "NODE_ENV") === "production";
}

/**
 * The key in `.env.example`, which every clone of this repository starts with.
 *
 * It is a valid key, which is the whole problem: it is the right length and the right encoding, so
 * nothing about it fails a check. A deployment that never changed it encrypts its credential vault
 * with a key printed in a public repository, and looks exactly like one that did.
 */
const PLACEHOLDER_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

function keyEncryptionKey(environment: Environment): string {
  const value = required(environment, "KEY_ENCRYPTION_KEY");
  const decoded = Buffer.from(value, "base64");

  if (decoded.byteLength !== 32 || decoded.toString("base64") !== value) {
    throw new Error("KEY_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  }

  /**
   * Refused in production, warned everywhere else. The placeholder is convenient locally and public
   * in any deployment.
   */
  if (value === PLACEHOLDER_KEY) {
    if (isProduction(environment)) {
      throw new Error(
        "KEY_ENCRYPTION_KEY is still the example key from .env.example, which is public. Generate one with: openssl rand -base64 32",
      );
    }
    console.warn(
      "KEY_ENCRYPTION_KEY is the example key from .env.example, which is public. Fine locally. Generate a real one before deploying: openssl rand -base64 32",
    );
  }

  return value;
}

function url(environment: Environment, name: string): string | undefined {
  const value = optional(environment, name);
  if (!value) {
    return undefined;
  }

  try {
    new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
  return value;
}

function optionalHttpUrl(
  environment: Environment,
  name: string,
): URL | undefined {
  const value = optional(environment, name);
  if (!value) {
    return undefined;
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid HTTP(S) URL`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${name} must be a valid HTTP(S) URL`);
  }

  return parsed;
}

/** Endpoints of the bundled Bot and installed harness. */
function managedAgentConfig(
  environment: Environment,
): ManagedAgentConfig | undefined {
  const endpoint = optionalHttpUrl(environment, "MANAGED_AGENT_AG_UI_URL");
  // An installed harness has its own endpoint.
  const alsoRun = optional(environment, "PICKED_HARNESS_IMAGE")
    ? optionalHttpUrl(environment, "PICKED_HARNESS_URL")
    : undefined;
  if (!endpoint && !alsoRun) {
    return undefined;
  }
  return {
    ...(endpoint ? { endpoint } : {}),
    ...(alsoRun ? { alsoRun } : {}),
  };
}

function oauthClient(
  environment: Environment,
  provider: "GOOGLE" | "MICROSOFT" | "OKTA",
): OAuthClient | undefined {
  const clientId = optional(environment, `${provider}_OAUTH_CLIENT_ID`);
  const clientSecret = optional(environment, `${provider}_OAUTH_CLIENT_SECRET`);

  // Both or neither. One alone is a half-configured sign-in that fails at the first attempt rather
  // than at start-up, which is the worst moment to discover it.
  if (Boolean(clientId) !== Boolean(clientSecret)) {
    throw new Error(
      `${provider}_OAUTH_CLIENT_ID and ${provider}_OAUTH_CLIENT_SECRET must be set together`,
    );
  }

  return clientId && clientSecret ? { clientId, clientSecret } : undefined;
}

function githubAppConfig(
  environment: Environment,
): GithubAppConfig | undefined {
  const clientId = optional(environment, "GITHUB_APP_CLIENT_ID");
  const clientSecret = optional(environment, "GITHUB_APP_CLIENT_SECRET");

  // Both or neither. One alone is a half-configured sign-in that fails at the first attempt rather
  // than at start-up, which is the worst moment to discover it.
  if (Boolean(clientId) !== Boolean(clientSecret)) {
    throw new Error(
      "GITHUB_APP_CLIENT_ID and GITHUB_APP_CLIENT_SECRET must be set together",
    );
  }

  return clientId && clientSecret ? { clientId, clientSecret } : undefined;
}

function commaSeparated(environment: Environment, name: string): string[] {
  return (optional(environment, name) ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

/**
 * Sign-in, if this deployment has an identity provider to sign people in with.
 *
 * Any one of the three turns authentication on. More than one is allowed and is the normal shape
 * for a company mid-migration, where some people are on Entra and some are still on Okta.
 *
 * Every combination that cannot work refuses at start-up rather than at somebody's first attempt to
 * sign in, which is the worst moment to discover it: a provider with half its credentials, a
 * provider with no session secret to mint against, or a session secret configured with no provider
 * to use it.
 */
function authConfig(
  environment: Environment,
  google: OAuthClient | undefined,
): AuthConfig | undefined {
  const microsoft = microsoftAuth(environment);
  const okta = oktaAuth(environment);

  const secret = optional(environment, "BETTER_AUTH_SECRET");
  const baseUrl = url(environment, "BETTER_AUTH_URL");

  if (!google && !microsoft && !okta) return undefined;

  const initialAdminEmails = commaSeparated(environment, "INITIAL_ADMIN_EMAILS");

  return {
    baseUrl,
    secret,
    initialAdminEmails,
    ...(google ? { google } : {}),
    ...(microsoft ? { microsoft } : {}),
    ...(okta ? { okta } : {}),
  };
}

/**
 * Entra ID, and which directory it admits.
 *
 * `common` by default, matching Microsoft's own default, and said out loud in `.env.example` because
 * it admits personal Microsoft accounts as well as work ones. A company that means "our staff"
 * wants its directory GUID here.
 */
function microsoftAuth(
  environment: Environment,
): (OAuthClient & { tenantId: string }) | undefined {
  const client = oauthClient(environment, "MICROSOFT");
  if (!client) return undefined;
  return {
    ...client,
    tenantId: optional(environment, "MICROSOFT_OAUTH_TENANT_ID") ?? "common",
  };
}

/**
 * Okta, which is an OIDC provider rather than a named one.
 *
 * The issuer is what makes it a particular Okta rather than Okta in general, so it is required
 * alongside the credentials rather than defaulted to anything.
 */
function oktaAuth(
  environment: Environment,
): (OAuthClient & { issuer: string }) | undefined {
  const client = oauthClient(environment, "OKTA");
  const issuer = url(environment, "OKTA_OAUTH_ISSUER");
  if (!client) {
    if (issuer) {
      throw new Error(
        "OKTA_OAUTH_ISSUER is set but OKTA_OAUTH_CLIENT_ID and OKTA_OAUTH_CLIENT_SECRET are not",
      );
    }
    return undefined;
  }
  if (!issuer) {
    throw new Error(
      "Okta sign-in requires OKTA_OAUTH_ISSUER, such as https://example.okta.com/oauth2/default",
    );
  }
  return { ...client, issuer };
}

/**
 * A duration a person would write, as milliseconds.
 *
 * `30m` rather than `1800000`, because this one is read and edited by whoever is deciding how long a
 * computer may sit idle, and a wrong number of zeroes there is either a computer that never sleeps
 * or one that vanishes mid-task. Plain digits are still milliseconds, so anything already set keeps
 * its meaning.
 */
export function durationMs(value: string): number {
  const match = /^(\d+)\s*(ms|s|m|h)?$/i.exec(value.trim());
  if (!match) {
    throw new Error(
      `"${value}" is not a duration. Write it as 30s, 30m, 2h, or a plain number of milliseconds.`,
    );
  }
  const amount = Number(match[1]);
  switch (match[2]?.toLowerCase()) {
    case "h":
      return amount * 3_600_000;
    case "m":
      return amount * 60_000;
    case "s":
      return amount * 1_000;
    default:
      return amount;
  }
}

function computerConfig(environment: Environment): ComputerConfig | undefined {
  const supervisorAddress = optional(environment, "COMPUTER_SUPERVISOR_URL");
  const sharedAddress = optional(environment, "AGENT_COMPUTER_URL");
  const sandboxNamespace = optional(environment, "COMPUTER_SANDBOX_NAMESPACE");
  if (!supervisorAddress && !sharedAddress && !sandboxNamespace) {
    return undefined;
  }

  /*
   * Checked before the other two, because a deployment that named a namespace means the cluster to
   * make the computers, and a stray `AGENT_COMPUTER_URL` left in an environment would otherwise
   * quietly put every Bot back on one shared browser.
   */
  if (sandboxNamespace) {
    return {
      provider: "sandbox",
      namespace: sandboxNamespace,
      idleAfterMs: durationMs(
        optional(environment, "COMPUTER_SANDBOX_IDLE_AFTER") ?? "30m",
      ),
      templateFile:
        optional(environment, "COMPUTER_SANDBOX_TEMPLATE_FILE") ??
        "/etc/openbot/sandbox-template.json",
    };
  }

  const supervisorUrl = url(environment, "COMPUTER_SUPERVISOR_URL");
  if (supervisorUrl) {
    return {
      provider: "docker",
      baseUrl: supervisorUrl,
    };
  }

  const baseUrl = url(environment, "AGENT_COMPUTER_URL");
  if (!baseUrl) {
    return undefined;
  }

  return {
    provider: "shared",
    baseUrl,
  };
}





/**
 * How long the audit trail is kept.
 *
 * Refused rather than coerced, like everything else here. "We accepted your retention policy but not
 * the one you wrote" is a bad answer about a control an auditor will ask to see, and a typo that
 * silently became 0 would delete the trail rather than keep it.
 */
function auditRetentionDays(environment: Environment): number | undefined {
  const raw = optional(environment, "AUDIT_RETENTION_DAYS");
  if (!raw) return undefined;

  const days = Number(raw);
  if (!Number.isInteger(days) || days < 1) {
    throw new Error(
      "AUDIT_RETENTION_DAYS must be a whole number of days, at least 1. Leave it unset to keep the audit trail forever.",
    );
  }
  return days;
}

function agentStallTimeoutMs(environment: Environment): number {
  const raw = optional(environment, "AGENT_STALL_TIMEOUT_MS");
  if (!raw) {
    return 0;
  }

  const milliseconds = Number(raw);
  if (!Number.isInteger(milliseconds) || milliseconds < 0) {
    throw new Error(
      "AGENT_STALL_TIMEOUT_MS must be a whole number of milliseconds, or 0 to switch the watchdog off",
    );
  }
  return milliseconds;
}

/** Where the API listens when nothing says otherwise: what `.env.example` and the image ship. */
const DEFAULT_PORT = 3001;

/**
 * The port the API listens on, from either of its two names.
 *
 * `PORT` and `SERVER_PORT` name one number: either moves the server, and two that disagree are
 * refused at boot rather than half-applied. Read through `optional` like every other setting here,
 * and that is the point. An unset variable declared in a compose file, or left as `PORT=` in a
 * `.env`, arrives as an empty string rather than as absent, so `process.env.PORT ??
 * process.env.SERVER_PORT` never fell through to the second name, and `Number.parseInt("")` is
 * `NaN`. Given `NaN`, `Bun.serve` binds an ephemeral port: the server came up somewhere nobody had
 * asked for, `SERVER_PORT` ignored, and the script polling it reported a server that never
 * started — the failure #312 set out to remove, back through the other name.
 *
 * A value that is not a whole port number is refused for the reason the caps above are: `30o1`
 * used to start the server on port 30, and a typo has to fail where somebody is looking.
 */
function serverPort(environment: Environment): number {
  return listenPort(environment.PORT ?? environment.SERVER_PORT, DEFAULT_PORT);
}

export function loadConfig(
  environment: Environment = process.env,
): DeploymentConfig {
  const google = oauthClient(environment, "GOOGLE");
  const auth = authConfig(environment, google);
  const managedAgent = managedAgentConfig(environment);
  const githubApp = githubAppConfig(environment);
  const publicUrl = (
    optional(environment, "OPENBOT_PUBLIC_URL") ?? auth?.baseUrl
  )?.replace(/\/+$/, "");
  // GitHub sends people back to this address after they approve. Without it linking is silently
  // switched off, so say so at start-up instead.
  if (githubApp && !publicUrl) {
    throw new Error(
      "GITHUB_APP_CLIENT_ID needs OPENBOT_PUBLIC_URL (or BETTER_AUTH_URL) so GitHub can send people back to this server.",
    );
  }
  const workerSharedSecret = optional(environment, "WORKER_SHARED_SECRET");
  const deploymentKey = keyEncryptionKey(environment);

  const loaded = {
    port: serverPort(environment),
    transcription: transcriptionConfig(environment),
    voice: voiceConfig(environment),
    databaseUrl: required(environment, "DATABASE_URL"),
    keyEncryptionKey: deploymentKey,
    ...(managedAgent ? { managedAgent } : {}),
    ...(githubApp ? { githubApp } : {}),
    deploymentId: optional(environment, "DEPLOYMENT_ID"),
    composioApiKey: optional(environment, "COMPOSIO_API_KEY"),
    arcadeApiKey: optional(environment, "ARCADE_API_KEY"),
    brokerProvider: brokerProvider(environment),
    publicUrl,
    appUrl: (
      optional(environment, "OPENBOT_APP_URL") ??
      optional(environment, "OPENBOT_PUBLIC_URL") ??
      auth?.baseUrl
    )?.replace(/\/+$/, ""),
    tenantPackageDirectory:
      optional(environment, "TENANT_PACKAGE_DIR") ?? "../examples/openduet",
    runtime: { mode: "local" as const, durableHistory: true as const },
    memoryDefaults: {
      sources: switchedOn(environment, "OPENBOT_MEMORY_SOURCE_DEFAULTS"),
      research: switchedOn(environment, "OPENBOT_PROACTIVE_DEFAULTS"),
    },
    agentStallTimeoutMs: agentStallTimeoutMs(environment),
    auditRetentionDays: auditRetentionDays(environment),
    oauth: { google },
    auth,
    singleUser: !auth,
    ...(optional(environment, "APP_DIST_DIR")
      ? { appDistDir: optional(environment, "APP_DIST_DIR") as string }
      : {}),
    computer: computerConfig(environment),
    ...(optional(environment, "AGENT_TOOL_TOKEN")
      ? { agentToolToken: optional(environment, "AGENT_TOOL_TOKEN") as string }
      : {}),
    ...(workerSharedSecret ? { workerSharedSecret } : {}),
  };
  // After everything above, so its refusals keep the order they were always raised in.
  return {
    ...loaded,
    listen: listenHosts(optional(environment, LISTEN_HOST_VARIABLE)),
  };
}

/** On unless the variable is "false" or "0", the rule every default-on switch here follows. */
function switchedOn(environment: Environment, name: string): boolean {
  const value = optional(environment, name);
  return value !== "false" && value !== "0";
}

