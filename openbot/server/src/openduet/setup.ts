import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables } from "../auth/guards";
import type { DeploymentConfig } from "../config";
import type { CredentialStatusReader } from "../credentials";
import type { BrokerProvider } from "../plugins/access";
import { GOOGLE_WORKSPACE } from "../plugins/catalogue";

/**
 * The setup checklist: one row for each thing this deployment depends on, and what it says about it.
 *
 * Onboarding ends on it and Settings opens it again. It answers what an admin is about to ask after
 * a first run, "what is set up, and what still needs doing", from the server's own configuration and
 * state rather than from a list the app keeps.
 *
 * Reads configured models, credentials and connected apps without exposing secrets.
 *
 * WHO READS IT DECIDES WHAT IT SAYS. An admin, and somebody trying OpenDuet alone on their own
 * machine, is told how to fix each gap: the page to open, or the variable to set. Everybody else is
 * told whether it is configured and that their admin sets it up; the response carries no
 * variable name at all, so a member's browser never holds the deployment's configuration vocabulary.
 */

/** The guides a fix links to. The repository is where the docs ship from. */
const DOCS = "https://github.com/personadynamics-studio/PDSDuet/blob/main/openbot/docs";
const QUICK_START = "https://github.com/personadynamics-studio/PDSDuet";

export type SetupRowId =
  | "model"
  | "google"
  | "computer"
  | "apps"
  | "chat";

/**
 * How a gap is closed, or null when there is nothing for the reader to do.
 *
 * - `env`: variables to set on the server, by name, and a guide. Only ever sent to an admin.
 * - `page`: a screen in the app that closes it. `path` is in-app, never another origin.
 */
export type SetupFix =
  | {
      kind: "env";
      names: string[];
      docsUrl: string;
      /** A screen that does the same job, where there is one. */
      page?: { label: string; path: string };
    }
  | { kind: "page"; label: string; path: string; docsUrl?: string };

/** Configuration presence only; no service or model is exercised to produce this status. */
export type SetupStatus = "ready" | "needs_setup";

export type SetupRow = {
  id: SetupRowId;
  /** A deployment row is the admin's to set up; a person row is the reader's own. */
  scope: "deployment" | "person";
  title: string;
  /** True only where the product cannot answer without it. */
  required: boolean;
  status: SetupStatus;
  /** The required configuration is present; this is not a runtime result. */
  ready: boolean;
  /** One sentence: what it gives you when ready, what happens without it when not. */
  detail: string;
  fix: SetupFix | null;
};

export type SetupChecklist = {
  /** `admin` for an admin or a local single-person install; `member` for everybody else. */
  audience: "admin" | "member";
  rows: SetupRow[];
};

/**
 * Everything the rows are decided from. Booleans, names and state words, never a value: see the
 * module comment.
 */
export type SetupFacts = {
  model: {
    provider: "openai" | "anthropic";
    /** Where the key the Bots answer with comes from, or null when there is none. */
    source: "plan" | "credential" | "environment" | null;
    /** The configured model name. */
    model: string;
  };
  google: {
    /** Without a public address no consent can come back, whatever else is set. */
    publicUrl: boolean;
    /** The Gmail and Calendar connector is added to this deployment. */
    added: boolean;
    /** An admin has registered the OAuth client it connects people with. */
    client: boolean;
  };
  /** A Bot computer is configured. Absent, its routes are not mounted at all. */
  computer: boolean;
  /** A broker for apps beyond the ones an admin adds, and which one this deployment would use. */
  apps: { configured: boolean; provider: BrokerProvider };
  /** The OpenTag pairing that carries Slack and Microsoft Teams. */
  chat: boolean;
};

const KEY_NAME = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
} as const;
const BROKER = {
  composio: { key: "COMPOSIO_API_KEY", docs: `${DOCS}/plugins/composio.md` },
  arcade: { key: "ARCADE_API_KEY", docs: `${DOCS}/plugins/arcade.md` },
} as const;

/** The configured dependencies for one reader. */
export function setupRows(
  facts: SetupFacts,
  options: { productName: string; audience: "admin" | "member" },
): SetupRow[] {
  const { productName: product, audience } = options;
  const admin = audience === "admin";
  const googleReady =
    facts.google.publicUrl && facts.google.added && facts.google.client;

  /**
   * Members see whether configuration is present, with variable names kept on the server.
   */
  const deployment = (row: {
    id: SetupRowId;
    title: string;
    required: boolean;
    status: SetupStatus;
    readyDetail: string;
    gapDetail: string;
    fix: SetupFix | null;
  }): SetupRow => ({
    id: row.id,
    scope: "deployment",
    title: row.title,
    required: row.required,
    status: row.status,
    ready: row.status === "ready",
    detail:
      row.status === "ready"
        ? row.readyDetail
        : admin
          ? row.gapDetail
          : "Your admin sets this up.",
    fix: row.status === "ready" || !admin ? null : row.fix,
  });

  const broker = BROKER[facts.apps.provider];

  return [
    deployment({
      id: "model",
      title: "AI model",
      required: true,
      ...modelRow(facts.model, product),
    }),
    deployment({
      id: "google",
      title: "Google apps",
      required: false,
      status: googleReady ? "ready" : "needs_setup",
      readyDetail: "Google OAuth client and callback address are configured.",
      gapDetail: "Google apps configuration is incomplete.",
      fix: facts.google.publicUrl
        ? {
            kind: "page",
            label: "Gmail and Google Calendar",
            path: `/admin/plugins/${GOOGLE_WORKSPACE}`,
            docsUrl: `${DOCS}/plugins/google-workspace.md`,
          }
        : {
            kind: "env",
            names: ["OPENBOT_PUBLIC_URL"],
            docsUrl: `${DOCS}/plugins/google-workspace.md`,
          },
    }),
    deployment({
      id: "computer",
      title: "Bot computer",
      required: false,
      status: facts.computer ? "ready" : "needs_setup",
      readyDetail: "Bot computer endpoint is configured.",
      gapDetail: "No Bot computer endpoint is configured.",
      fix: {
        kind: "env",
        names: ["AGENT_COMPUTER_URL", "COMPUTER_TOKEN"],
        docsUrl: `${DOCS}/configuration.md#computer-and-supervisor`,
      },
    }),
    deployment({
      id: "apps",
      title: "More apps",
      required: false,
      status: facts.apps.configured ? "ready" : "needs_setup",
      readyDetail: "An app connector provider is configured.",
      gapDetail: "No additional app connector provider is configured.",
      fix: { kind: "env", names: [broker.key], docsUrl: broker.docs },
    }),
    deployment({
      id: "chat",
      title: "Slack and Teams",
      required: false,
      status: facts.chat ? "ready" : "needs_setup",
      readyDetail: "Slack and Teams pairing is configured.",
      gapDetail: "Slack and Teams pairing is not configured.",
      fix: {
        kind: "env",
        names: ["OPENTAG_SHARED_SECRET", "OPENTAG_URL"],
        docsUrl: `${DOCS}/configuration.md#slack-and-microsoft-teams-opentag-pairing`,
      },
    }),
  ];
}

/** The model row reports saved configuration, without making a provider request. */
function modelRow(model: SetupFacts["model"], product: string) {
  const configured = model.source !== null && Boolean(model.model.trim());
  return {
    status: configured ? "ready" as const : "needs_setup" as const,
    readyDetail: model.source === "plan"
      ? "Subscription plan and model are configured."
      : "AI model, credential and API endpoint are configured.",
    gapDetail: model.source === null
      ? `No model credential is configured for ${product}.`
      : `No AI model is configured for ${product}.`,
    fix: {
      kind: "env" as const,
      names: [KEY_NAME[model.provider]],
      docsUrl: QUICK_START,
      page: { label: "Credentials", path: "/admin/credentials" },
    },
  };
}

/** Read where the runtime resolves its credential; no secret or provider request is needed. */
export async function modelKeySource(input: {
  plan: boolean;
  provider: "openai" | "anthropic";
  keyId: string;
  credentials: CredentialStatusReader;
  environment: Record<string, string | undefined>;
}): Promise<SetupFacts["model"]["source"]> {
  if (input.plan) return "plan";
  const stored = (await input.credentials.list()).some(
    (credential) =>
      credential.kind === "model" &&
      credential.provider === input.provider &&
      credential.keyId === input.keyId &&
      credential.revokedAt === null,
  );
  if (stored) return "credential";
  return input.environment[KEY_NAME[input.provider]]?.trim() ? "environment" : null;
}

/** Configuration facts the settings page may read. */
export type SetupSources = {
  productName: string;
  /** A local install for one person, whose only reader is the person running it. */
  localEvaluation: boolean;
  facts: () => Promise<SetupFacts>;
};

/**
 * The facts read from this server's configuration and stores.
 *
 * Built once at boot and asked on every request, so a connection made or a credential added a
 * moment ago shows up on the next read. This does not call the configured providers.
 */
export function createSetupSources(input: {
  productName: string;
  config: DeploymentConfig;
  environment: Record<string, string | undefined>;
  model: {
    provider: "openai" | "anthropic";
    keyId: string;
    defaultModel: string;
    plan: boolean;
  };
  credentials: CredentialStatusReader;
  plugins: {
    listServers: () => Promise<Array<{ id: string; hasCredential: boolean }>>;
  };
  computer: boolean;
  apps: { configured: boolean; provider: BrokerProvider };
  chat: boolean;
}): SetupSources {
  const keyFacts = {
    plan: input.model.plan,
    provider: input.model.provider,
    keyId: input.model.keyId,
    credentials: input.credentials,
    environment: input.environment,
  };
  return {
    productName: input.productName,
    localEvaluation: input.config.singleUser,
    facts: async () => {
      const [source, servers] = await Promise.all([
        modelKeySource(keyFacts),
        input.plugins.listServers(),
      ]);
      const google = servers.find((server) => server.id === GOOGLE_WORKSPACE);
      return {
        model: {
          provider: input.model.provider,
          source,
          model: input.model.defaultModel,
        },
        google: {
          publicUrl: Boolean(input.config.publicUrl),
          added: google !== undefined,
          client: google?.hasCredential === true,
        },
        computer: input.computer,
        apps: input.apps,
        chat: input.chat,
      };
    },
  };
}

/** Read the signed-in person's current configuration checklist. */
export function createSetupRoutes(
  sources: SetupSources,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", requireUser);
  routes.onError((error, context) => {
    console.error(
      JSON.stringify({
        type: "openduet-setup-route-error",
        error: error.name,
        timestamp: new Date().toISOString(),
      }),
    );
    return context.json(
      { error: "Couldn't read your setup. Try again." },
      503,
    );
  });
  const answer = async (context: {
    var: AppVariables;
    json: (body: { checklist: SetupChecklist }) => Response;
  }) => {
    const audience =
      context.var.actor.role === "admin" || sources.localEvaluation
        ? "admin"
        : "member";
    const facts = await sources.facts();
    return context.json({
      checklist: {
        audience,
        rows: setupRows(facts, { productName: sources.productName, audience }),
      },
    });
  };
  routes.get("/", (context) => answer(context));
  return routes;
}
