//! The `.env` the shell writes, and the secrets it mints.
//!
//! `scripts/start.sh` writes the same file for a developer. This writes it for somebody who will
//! never open a terminal, which changes three things:
//!
//! - **No dev fallbacks.** `start.sh` falls back to fixed strings for `COMPUTER_TOKEN`,
//!   `SUPERVISOR_TOKEN` and `WORKER_SHARED_SECRET`, which are published in this repository. They are
//!   fine on a laptop somebody is debugging and they are not fine as the default a product ships.
//!   Every one of them is generated here.
//! - **A real `KEY_ENCRYPTION_KEY`.** `.env.example` carries a valid public key, and
//!   `server/src/config.ts` only throws on it under `NODE_ENV=production`. A desktop install is not
//!   production, so it would land in the warn branch and encrypt the credential vault with a key
//!   printed in a public repository, objected to by a `console.warn` nobody running a window reads.
//! - **`COMPUTER_SUPERVISOR_URL` is not optional.** Without it the server runs every Bot against one
//!   shared browser and says so only in a startup line. `start.sh` sets it at run time, so a `.env`
//!   copied from a developer's machine does not have it.

use std::collections::BTreeMap;
use std::path::Path;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use rand::RngCore;

use crate::engine::EngineStatus;

/**
Where a signed-in ChatGPT plan's token store lives, on this machine and inside the harness.

Two paths for one file, joined by a directory bind mount `docker-compose.yml` declares. It has to be
a file rather than a setting because the harness's provider WRITES to it: when the access token
expires it renews and saves, and the mount is what makes that renewal outlast the container.

The host file is always written, even when nobody signed in to a plan. That keeps the mounted
directory in the shape the provider expects and avoids leaving a stale plan token behind after
somebody switches away from the plan.
*/
pub const CHATGPT_STORE_FILE: &str = ".langchain/chatgpt-auth.json";
pub const CHATGPT_STORE_INSIDE: &str = "/root/.langchain/chatgpt-auth.json";

/// Host ports, persisted in this deployment's .env and reused while they remain available.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Ports {
    pub app: u16,
    pub server: u16,
    pub postgres: u16,
    pub computer: u16,
    pub bot: u16,
    pub langgraph: u16,
    pub supervisor: u16,
    pub harness: Option<u16>,
}

impl Default for Ports {
    fn default() -> Self {
        Self {
            app: 3010,
            server: 3001,
            postgres: 5432,
            computer: 4100,
            bot: 4200,
            langgraph: 4201,
            supervisor: 4500,
            harness: None,
        }
    }
}

impl Ports {
    pub fn read(root: &Path) -> std::io::Result<Self> {
        let values = read_already_set(
            &root.join(".env"),
            &[
                "APP_PORT",
                "SERVER_PORT",
                "POSTGRES_PORT",
                "COMPUTER_PORT",
                "BOT_PORT",
                "LANGGRAPH_PORT",
                "SUPERVISOR_PORT",
                "PICKED_HARNESS_HOST_PORT",
            ],
        )?;
        let mut ports = Self::default();
        for (key, port) in [
            ("APP_PORT", &mut ports.app),
            ("SERVER_PORT", &mut ports.server),
            ("POSTGRES_PORT", &mut ports.postgres),
            ("COMPUTER_PORT", &mut ports.computer),
            ("BOT_PORT", &mut ports.bot),
            ("LANGGRAPH_PORT", &mut ports.langgraph),
            ("SUPERVISOR_PORT", &mut ports.supervisor),
        ] {
            if let Some(value) = values.get(key) {
                *port = parse_port(key, value)?;
            }
        }
        ports.harness = values
            .get("PICKED_HARNESS_HOST_PORT")
            .map(|value| parse_port("PICKED_HARNESS_HOST_PORT", value))
            .transpose()?;
        Ok(ports)
    }

    pub fn settings(&self) -> BTreeMap<String, String> {
        let mut settings: BTreeMap<_, _> = [
            ("APP_PORT", self.app),
            ("SERVER_PORT", self.server),
            ("POSTGRES_PORT", self.postgres),
            ("COMPUTER_PORT", self.computer),
            ("BOT_PORT", self.bot),
            ("LANGGRAPH_PORT", self.langgraph),
            ("SUPERVISOR_PORT", self.supervisor),
        ]
        .into_iter()
        .map(|(key, port)| (key.to_string(), port.to_string()))
        .collect();
        if let Some(port) = self.harness {
            settings.insert("PICKED_HARNESS_HOST_PORT".into(), port.to_string());
        }
        settings
    }


}

fn parse_port(key: &str, value: &str) -> std::io::Result<u16> {
    value.parse().map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, format!("{key}: {error}")))
}

pub fn compose(
    intelligence: &Intelligence,
    model: &Model,
    engine: &EngineStatus,
    ports: &Ports,
    images: &[(String, String)],
    // Absent means no harness was picked, and the package's gated rows stay dropped.
    harness: Option<&PickedHarness>,
    // What a previous run of THIS deployment already minted, so it is not minted again. Empty on a
    // machine that has never run OpenBot, which is exactly when generating is right.
    kept: &BTreeMap<String, String>,
) -> BTreeMap<String, String> {
    let mut env = BTreeMap::new();

    /*
     * Only the keys the choice actually implies, and never a blank one: written empty, Compose
     * passes an empty string and the Bot's refusal becomes a confusing one about a key that is set
     * and useless.
     *
     * THE CLAUDE PLAN DELIBERATELY WRITES NO `ANTHROPIC_API_KEY`. The SDK prefers the key over the
     * OAuth token, so a stale key from an earlier attempt would quietly bill a person who just
     * signed in to a plan. Since `write` below preserves lines it does not own, the key is written
     * as empty here rather than omitted: omitting it would leave an older one in place, which is
     * the same failure by a different route.
     */
    /*
     * Every model key, every time, and empty unless the choice implies it.
     *
     * Clearing only the one key a given arm conflicts with left the others stale, and `write` below
     * preserves lines it does not own, so switching from a key to a plan kept the old key in the
     * file and handed it to every harness. Measured: a run that signed in to a Claude plan still
     * carried the OPENAI_API_KEY from the run before it. Whichever key a harness reads first then
     * decides what the person is billed for, which is the failure the plan path exists to avoid.
     *
     * Written empty rather than omitted, for the same reason: omitting leaves the old line in place.
     */
    if model.credential != ModelCredential::None {
        for key in [
            "OPENAI_API_KEY",
            "OPENAI_BASE_URL",
            "OPENAI_CONTAINER_BASE_URL",
            "ANTHROPIC_API_KEY",
            "CLAUDE_CODE_OAUTH_TOKEN",
            "CHATGPT_AUTH_FILE",
            "OPENBOT_MODEL_OAUTH_FILE",
            "BOT_PROVIDER",
            /*
             * Retired, and cleared for exactly that reason. An earlier version put the ChatGPT
             * plan's access token here; nothing reads it now, and `write` preserves what it does
             * not own, so without this line a machine that ran that version would keep somebody's
             * plan token in a file forever with nothing ever using it again.
             */
            "CHATGPT_OAUTH_TOKEN",
        ] {
            env.insert(key.into(), String::new());
        }
        /*
         * AND THE MODEL NAME, WHICH ONLY ONE ROW IMPLIES.
         *
         * Measured: answering the compatible row sets `BOT_MODEL` to whatever the person's own
         * endpoint calls its model, and switching back to an OpenAI key left it there. The Bot then
         * asked OpenAI for `local-model` and the last screen said "That account cannot use the
         * model that was chosen" — about a model this run never chose. Exactly the failure the
         * clearing above exists for, with one key missed.
         *
         * Removed rather than emptied, so `docker-compose.yml`'s own default applies. Blank would
         * be passed through as a model named "", which is a worse question to ask a provider.
         */
        if !matches!(
            model.credential,
            ModelCredential::Compatible { .. } | ModelCredential::ProviderOAuth { .. }
        ) {
            for key in ["BOT_MODEL", "AGENT_BOT_MODEL"] {
                env.remove(key);
            }
        }
    }
    match &model.credential {
        /*
         * Nothing chosen touches nothing, deliberately.
         *
         * The clearing above is for the case where the model screen HAS answered: whichever keys
         * that answer does not imply are emptied, so switching from a key to a plan cannot leave
         * the old key behind for a harness to prefer. With no answer there is nothing to be
         * consistent with, and a key somebody set by hand is theirs to keep — see `write`, which
         * preserves lines this does not own.
         */
        ModelCredential::None => {}
        ModelCredential::OpenAi { api_key } => {
            insert_if_given(&mut env, "OPENAI_API_KEY", api_key);
        }
        ModelCredential::Anthropic { api_key } => {
            insert_if_given(&mut env, "ANTHROPIC_API_KEY", api_key);
            env.insert("BOT_PROVIDER".into(), "anthropic".into());
            env.insert("BOT_MODEL".into(), "claude-sonnet-4-5".into());
        }
        ModelCredential::ClaudePlan { token } => {
            insert_if_given(&mut env, "CLAUDE_CODE_OAUTH_TOKEN", token);
        }
        /*
         * A path, not the credential. The store itself goes to a file beside this one, because the
         * harness's provider does not merely read it: it writes the renewed tokens back. Through a
         * bind mount that renewal lands on this machine and survives the container; carried as an
         * environment variable it would be lost on every restart, and the refresh token it replaced
         * would already have been spent.
         */
        ModelCredential::ChatGptPlan { store } => {
            if !store.trim().is_empty() {
                env.insert("CHATGPT_AUTH_FILE".into(), CHATGPT_STORE_INSIDE.into());
            }
        }
        ModelCredential::ProviderOAuth {
            path,
            proxy_token,
            model,
            ..
        } => {
            env.insert("OPENBOT_MODEL_OAUTH_FILE".into(), path.clone());
            env.insert("OPENAI_API_KEY".into(), proxy_token.clone());
            env.insert(
                "OPENAI_BASE_URL".into(),
                format!("http://127.0.0.1:{}/api/model-provider/v1", ports.server),
            );
            env.insert(
                "OPENAI_CONTAINER_BASE_URL".into(),
                format!(
                    "http://host.docker.internal:{}/api/model-provider/v1",
                    ports.server
                ),
            );
            env.insert("BOT_PROVIDER".into(), "openai".into());
            env.insert("BOT_MODEL".into(), model.clone());
            env.insert("AGENT_BOT_MODEL".into(), model.clone());
        }
        ModelCredential::Compatible {
            base_url,
            container_base_url,
            api_key,
            model: name,
        } => {
            /*
             * A placeholder when the endpoint needs no key, rather than nothing.
             *
             * Ollama, vLLM, LM Studio and llama.cpp ignore the value, but the OpenAI SDK every Bot
             * is built on refuses to construct a client without a string, so a blank key produced a
             * Bot that exited on startup asking for a key the person's own server does not have.
             * The Bots no longer demand one when a base URL names an endpoint, and this is the half
             * that makes the same choice work against a Bot image published before they learned:
             * the value is sent to an endpoint that does not read it.
             *
             * Not a secret and never treated as one, which is why it is written here in plain sight
             * rather than put in the credential store.
             */
            if api_key.trim().is_empty() {
                env.insert("OPENAI_API_KEY".into(), NO_KEY_NEEDED.into());
            } else {
                insert_if_given(&mut env, "OPENAI_API_KEY", api_key);
            }
            insert_if_given(&mut env, "OPENAI_BASE_URL", base_url);
            if let Some(container_base_url) = container_base_url {
                insert_if_given(&mut env, "OPENAI_CONTAINER_BASE_URL", container_base_url);
            }
            insert_if_given(&mut env, "BOT_MODEL", name);
            /*
             * The bundled Bot's own model variable, set to the same name.
             *
             * It has one because it hand-writes `/v1/chat/completions`, where `gpt-5.6-*` rejects
             * function tools, so `docker-compose.yml` pins it to `gpt-5.5` rather than letting the
             * framework Bot's choice take its tools away. That reasoning is about OpenAI's own
             * models and does not survive a custom endpoint: `gpt-5.5` is not in the catalogue of
             * an Ollama or a vLLM, so the pin asked somebody's own server for a model it has never
             * heard of. The person named exactly one model on that screen and meant it for
             * whichever Bot answers.
             */
            insert_if_given(&mut env, "AGENT_BOT_MODEL", name);
        }
    }

    // Trimmed, the way the model key beside it already is. All four values come from the same
    // setup screen, which enables its button on `value.trim() !== ""` and then sends the untrimmed
    // string, so a key copied from a provider's dashboard with the trailing space the selection
    // picked up arrives here intact. Compose keeps it, the provider rejects the key, and the Bot
    // reports that it cannot answer without ever naming the space.
    env.insert(
        "INTELLIGENCE_API_URL".into(),
        intelligence.api_url.trim().to_string(),
    );
    env.insert(
        "INTELLIGENCE_GATEWAY_WS_URL".into(),
        intelligence.gateway_ws_url.trim().to_string(),
    );
    env.insert(
        "INTELLIGENCE_API_KEY".into(),
        intelligence.api_key.trim().to_string(),
    );

    /*
     * MINTED ONCE PER DEPLOYMENT, NOT ONCE PER START.
     *
     * `KEY_ENCRYPTION_KEY` is the one that makes this data loss rather than churn: every secret the
     * server keeps goes through it, and `encrypt-sso-config.ts` names the symptom itself, that a
     * changed key leaves stored configuration unreadable and sign-in broken until it is registered
     * again. A new one on every Start quietly orphaned everything the last run had encrypted.
     *
     * Two installs still do not share a key. A machine with nothing stored generates, which is what
     * a first run is.
     */
    for key in MINTED {
        let value = kept
            .get(key)
            .map(|value| value.trim().to_string())
            // `usable` and not merely "not empty": an example key copied out of `.env.example` is
            // present, is published, and must still be replaced. It also holds
            // `KEY_ENCRYPTION_KEY` to the 32 bytes it has to decode to.
            .filter(|value| usable(key, value))
            .unwrap_or_else(secret);
        env.insert(key.into(), value);
    }

    env.insert(
        "DATABASE_URL".into(),
        format!(
            "postgres://openbot:openbot@127.0.0.1:{}/openbot",
            ports.postgres
        ),
    );
    env.insert(
        "AGENT_COMPUTER_URL".into(),
        format!("http://127.0.0.1:{}", ports.computer),
    );
    env.insert(
        "MANAGED_AGENT_AG_UI_URL".into(),
        if crate::stack::BundledBots::for_credential(&model.credential).agent_langgraph {
            format!("http://127.0.0.1:{}/ag-ui", ports.langgraph)
        } else {
            // An owned empty value also clears a previously advertised API-key Bot on plan switch.
            // The package loader omits its row while the endpoint is blank.
            String::new()
        },
    );

    /*
     * The picked harness, if there is one.
     *
     * Addressed on loopback rather than by a compose service name, because the server is a host
     * process here and not a container: it reaches `agent-bot` and `agent-langgraph` the same way,
     * over the port those services publish.
     *
     * One address and one kind. The package's single row drops itself while the address is blank,
     * so a deployment that picked nothing registers nothing.
     */
    // KIND describes the wire protocol, not who runs the endpoint. Always replace this
    // nonsecret provenance, including when nothing is picked: `write` preserves omitted keys.
    env.insert(
        "PICKED_HARNESS_SOURCE".into(),
        match harness {
            Some(PickedHarness::Installed { .. }) => "installed",
            Some(PickedHarness::RemoteAgUi { .. }) => "byo",
            None => "",
        }
        .into(),
    );
    if let Some(picked) = harness {
        match picked {
            PickedHarness::Installed {
                image,
                port,
                name,
                mastra,
                run_path,
                remote_agent_id,
            } => {
                let host_port = ports.harness.unwrap_or(*port);
                env.insert("PICKED_HARNESS_IMAGE".into(), image.clone());
                env.insert("PICKED_HARNESS_PORT".into(), port.to_string());
                env.insert("PICKED_HARNESS_NAME".into(), name.clone());
                let run_path = run_path.trim();
                env.insert(
                    "PICKED_HARNESS_URL".into(),
                    if run_path.is_empty() {
                        format!("http://127.0.0.1:{host_port}")
                    } else if run_path.starts_with('/') {
                        format!("http://127.0.0.1:{host_port}{run_path}")
                    } else {
                        format!("http://127.0.0.1:{host_port}/{run_path}")
                    },
                );
                /*
                 * The kind, as the package spells it.
                 *
                 * Interpolated rather than written as a literal row per kind, because the loader
                 * refuses an unknown `agent.type` by refusing the whole file: a package carrying a
                 * literal `remote-mastra` row stops any server predating that kind from starting at
                 * all, picked or not. Measured, not guessed — it is what a v0.0.8 deployment did.
                 */
                env.insert(
                    "PICKED_HARNESS_KIND".into(),
                    if *mastra {
                        "remote-mastra".to_string()
                    } else {
                        "remote-ag-ui".to_string()
                    },
                );
                insert_if_given(&mut env, "PICKED_HARNESS_AGENT_ID", remote_agent_id);
            }
            PickedHarness::RemoteAgUi {
                url,
                name,
                remote_agent_id,
            } => {
                env.insert("PICKED_HARNESS_NAME".into(), name.clone());
                env.insert("PICKED_HARNESS_URL".into(), url.trim().to_string());
                env.insert("PICKED_HARNESS_KIND".into(), "remote-ag-ui".into());
                insert_if_given(&mut env, "PICKED_HARNESS_AGENT_ID", remote_agent_id);
            }
        }
    }

    // Without this the server gives every Bot the same browser. It is the difference between the
    // product this installs and a demo of it.
    env.insert(
        "COMPUTER_SUPERVISOR_URL".into(),
        format!("http://127.0.0.1:{}", ports.supervisor),
    );

    // The worker refuses to start without this, by design: it is a fact about where this process
    // runs, and it would rather stop than guess. `start.sh` sets it at run time, so a `.env` copied
    // from a developer's machine does not carry it either.
    env.insert(
        "SERVER_INTERNAL_URL".into(),
        format!("http://127.0.0.1:{}", ports.server),
    );

    env.extend(ports.settings());
    env.insert(
        "OPENBOT_TOOL_URL".into(),
        format!(
            "http://host.docker.internal:{}/api/agent-tools/call",
            ports.server
        ),
    );

    // Which package the deployment runs. Without it the server falls back rather than using the one
    // that came with the deployment, and the Bots somebody was given are not the Bots they get.
    env.insert("TENANT_PACKAGE_DIR".into(), "../examples/fintech".into());

    // The default actor of this desktop installation.
    env.insert("INITIAL_ADMIN_EMAILS".into(), "dev@openbot.local".into());

    // Pull the published images rather than build them. A desktop install has no toolchain and no
    // reason to compile Chromium.
    env.insert("IMAGE_PULL_POLICY".into(), "missing".into());

    // Which images, by digest, from the release's own manifest. Compose's defaults are local build
    // names, so leaving these unset does not fall back to something workable: it asks a registry
    // for `openbot-supervisor:latest`, which nobody publishes, and the denial that comes back
    // reads as a login problem.
    for (variable, reference) in images {
        env.insert(variable.clone(), reference.clone());
    }

    // Only rootless Podman on Linux needs this; see engine.rs.
    if let Some(socket) = &engine.engine_socket {
        env.insert("ENGINE_SOCKET".into(), socket.clone());
    }

    env
}

#[derive(Clone, Debug)]
pub struct Intelligence {
    pub api_url: String,
    pub gateway_ws_url: String,
    pub api_key: String,
}

/**
The harness somebody picked, as the deployment has to describe it.

Registration is not an API call in this product: Bots come from the tenant package, whose
`agents.yaml` interpolates `${...}` and drops any Bot whose endpoint comes out blank. So a picked
harness becomes these settings, the package's own gated row materialises, and seeding registers it.
Nothing new had to be built to make a Bot appear.

`None` is a deployment that has not picked one, which writes nothing and leaves those rows dropped.
*/
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PickedHarness {
    Installed {
        /// The published image, e.g. `openbot-agent-crewai`. Named by the release, not derived.
        image: String,
        /// The port that image listens on, fixed by its own Dockerfile.
        port: u16,
        /// What the Bot is called on screen.
        name: String,
        /// How it is dialled. A Mastra server has no AG-UI route of its own.
        mastra: bool,
        /// The run route on that harness. Empty means the server root.
        run_path: String,
        /// Which agent on that server, for a Mastra roster. Empty means the only one there.
        remote_agent_id: String,
    },
    RemoteAgUi {
        /// The AG-UI endpoint the person already runs.
        url: String,
        /// What the Bot is called on screen.
        name: String,
        /// Reserved for a future remote roster field. Empty means the only one there.
        remote_agent_id: String,
    },
}

impl PickedHarness {
    pub fn installed_port(&self) -> Option<u16> {
        match self {
            Self::Installed { port, .. } => Some(*port),
            Self::RemoteAgUi { .. } => None,
        }
    }
}

/// The model credential, which belongs to the provider and not to the harness.
///
/// Both Bots the deployment ships refuse to start without one, saying so plainly: "This Bot cannot
/// answer without a model." Which provider is the person's own screen, and no harness constrains
/// it: see `provider::catalogue`.
#[derive(Clone, Debug, Default)]
pub struct Model {
    pub credential: ModelCredential,
}

/// How this deployment reaches a model.
///
/// One type rather than a bag of optional strings, because the combinations that must never be
/// written are the whole point. `ANTHROPIC_API_KEY` takes precedence over the plan's OAuth token in
/// the Claude Agent SDK, so writing both silently bills a person who signed in to a plan they
/// already pay for. Two fields cannot express "never both"; a choice can.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum ModelCredential {
    /// Nothing chosen. Written as nothing at all rather than as empty strings: an empty key set is
    /// a key that is present and useless, and the Bot's refusal then names a key it can see.
    #[default]
    None,
    /// A key typed for OpenAI.
    OpenAi { api_key: String },
    /// A key typed for Anthropic.
    Anthropic { api_key: String },
    /// A Claude plan, signed in to. The token is minted by `claude setup-token` and never typed.
    ClaudePlan { token: String },
    /**
    A ChatGPT plan, signed in to.

    NOT the compatible shape below, and that distinction is load-bearing. A plan token is a bearer
    for `https://chatgpt.com/backend-api/codex`, and `langchain-openai` PINS that address and
    refuses a caller-supplied one, deliberately, so a token cannot be aimed at somebody else's
    server and handed over. Writing this as `OPENAI_BASE_URL` plus a key would be us hand-rolling
    the thing the library exists to prevent, and the Codex path also shapes its requests
    differently, so it would not have worked anyway.

    THE WHOLE STORE, NOT THE ACCESS TOKEN. The token in it lasts under an hour and nothing can
    renew it; the refresh token beside it is what keeps the Bot answering tomorrow. Carrying one
    field would produce a Bot that works this morning and fails this afternoon with an auth error,
    which is the hardest kind of fault for somebody to report.

    The harness picks its model class from the presence of this store. See the harness note in the
    build doc.
    */
    ChatGptPlan { store: String },
    /// A native-held OAuth session; the local proxy owns access-token refresh.
    ProviderOAuth {
        provider: String,
        path: String,
        proxy_token: String,
        model: String,
    },
    /// Anything that speaks the OpenAI wire format, at an address the person gave.
    ///
    /// Also where a signed-in ChatGPT plan lands, because that login yields a token and the address
    /// to send it to, which is this shape and not a special case.
    Compatible {
        base_url: String,
        container_base_url: Option<String>,
        api_key: String,
        model: String,
    },
}

/// What is sent as the key when the endpoint named needs none.
///
/// A placeholder, not a credential: see the compatible branch of `compose`.
pub const NO_KEY_NEEDED: &str = "no-key-needed";

/// Write the file, replacing only what this owns.
/// The line that separates what the shell owns from what it found.
///
/// Named rather than written inline, because `write` has to recognise its own from a previous start
/// as well as put one down.
const BANNER: &str = "# Written by OpenBot Desktop. Anything else in this file is left alone.";

/// The secrets this deployment mints for itself, once.
pub const MINTED: [&str; 3] = [
    "AGENT_TOOL_TOKEN",
    "KEY_ENCRYPTION_KEY",
    "WORKER_SHARED_SECRET",
];

const PUBLISHED: [&str; 4] = [
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    "openbot-dev-supervisor-token",
    "openbot-dev-computer-token",
    "openbot-dev-worker-secret",
];

/// Whether an original installation key can be reused without replacement.
/// Start checks this before composition so an existing installation cannot silently rotate its key.
pub fn usable_encryption_key(value: &str) -> bool {
    !PUBLISHED.contains(&value) && matches!(BASE64.decode(value), Ok(bytes) if bytes.len() == 32)
}

fn usable(key: &str, value: &str) -> bool {
    if key == "KEY_ENCRYPTION_KEY" {
        return usable_encryption_key(value);
    }
    !value.is_empty() && !PUBLISHED.contains(&value)
}

fn carried(existing: &str) -> BTreeMap<String, String> {
    let mut found = BTreeMap::new();
    for line in existing.lines() {
        if line.trim_start().starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        let value = value.trim();
        if MINTED.contains(&key) && usable(key, value) {
            found.insert(key.to_string(), value.to_string());
        }
    }
    found
}

/// Write the file, replacing only what this owns and keeping the secrets it has already minted.
///
/// Lines the shell did not write are kept: somebody who added `OPENAI_API_KEY` by hand, or a
/// setting a later version of this app does not know about, should not lose it because the stack
/// was restarted.
/**
What a previous run already put in the `.env`.

So the wizard never asks twice. A person who has set this up before, or whose IT department laid the
file down for them, should not be made to find a key again — and "find it again" in practice means
opening a dotfile in a text editor, which is the exact thing this product exists not to require.

Only the settings the wizard asks about are read back. Everything else in that file is somebody
else's, and this has no business handing it to a window.
*/
fn already_set_in(text: &str, keys: &[&str]) -> BTreeMap<String, String> {
    let mut found = BTreeMap::new();
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        let value = value.trim();
        // Blank is not a value: the writer clears keys a choice does not imply, and offering those
        // back as though somebody had set them would undo that.
        if keys.contains(&key) && !value.is_empty() {
            found.insert(key.to_string(), value.to_string());
        }
    }
    found
}

pub fn read_already_set(path: &Path, keys: &[&str]) -> std::io::Result<BTreeMap<String, String>> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
        Err(error) => return Err(error),
    };
    Ok(already_set_in(&text, keys))
}

pub fn already_set(path: &Path, keys: &[&str]) -> BTreeMap<String, String> {
    read_already_set(path, keys).unwrap_or_default()
}

/**
Lay down the token store a signed-in ChatGPT plan reads from, beside the `.env`.

Always written, and see `CHATGPT_STORE_FILE` for why: a directory bind mount needs the file already
present inside it before the harness starts. Answering the model screen with anything else clears
it, on the same reasoning as the keys the writer empties. A plan that was signed out of should not
leave a credential on disk for a later run to pick up.

Not called when the screen was not answered at all, which is the one case that must not disturb what
is already there.
*/
pub fn write_plan_store(dir: &Path, credential: &ModelCredential) -> std::io::Result<()> {
    let store = match credential {
        ModelCredential::ChatGptPlan { store } if !store.trim().is_empty() => store.trim(),
        _ => "{}",
    };
    let path = dir.join(CHATGPT_STORE_FILE);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    write_private_file(&path, format!("{store}\n").as_bytes())
}

/// Replace a credential or its intent record only after an owner-only temporary file is durable.
/// A failed write leaves the previous copy available for an explicit retry.
pub(crate) fn write_private_file(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let parent = path
        .parent()
        .ok_or_else(|| std::io::Error::other("missing parent directory"))?;
    let temporary = parent.join(format!(".openbot-write-{:016x}.tmp", rand::random::<u64>()));
    let result = (|| {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        std::fs::rename(&temporary, path)?;
        #[cfg(unix)]
        std::fs::File::open(parent)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temporary);
    }
    result
}

pub fn saved_chatgpt_plan_store(dir: &Path) -> bool {
    read_plan_store(dir)
        .ok()
        .flatten()
        .is_some_and(|store| store.trim() != "{}")
}

pub fn read_plan_store(dir: &Path) -> std::io::Result<Option<String>> {
    let path = dir.join(CHATGPT_STORE_FILE);
    let store = match std::fs::read_to_string(path) {
        Ok(store) => store,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let trimmed = store.trim();
    if trimmed.is_empty() || trimmed == "{}" {
        Ok(None)
    } else {
        Ok(Some(trimmed.to_string()))
    }
}

pub fn write(
    path: &Path,
    owned: &BTreeMap<String, String>,
    // Keys to take out and not put back. This is how a credential leaves the file on a machine that
    // ran a version which wrote it there: the settings move to the store, and without this the old
    // copy would sit in the file forever, since `write` otherwise keeps every line it does not own.
    purge: &BTreeMap<String, String>,
) -> std::io::Result<()> {
    // Each unquoted row is one setting. A line break in a model name must not become another
    // setting, and a refused update must leave the previous file untouched.
    if owned
        .iter()
        .any(|(key, value)| key.contains(['\r', '\n']) || value.contains(['\r', '\n']))
    {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "OpenBot setting names and values must not contain line breaks.",
        ));
    }
    let existing = match std::fs::read_to_string(path) {
        Ok(existing) => existing,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => {
            return Err(std::io::Error::new(
                error.kind(),
                format!("{}: {error}", path.display()),
            ))
        }
    };
    let carried = carried(&existing);
    let mut out = String::new();

    for line in existing.lines() {
        // The shell's own banner is not one of the lines it did not write. Keeping it and then
        // writing another one added a banner and a blank line to the file on every start, so a
        // deployment restarted fifty times had fifty of them above its settings.
        if line.trim() == BANNER {
            continue;
        }
        let key = line.split('=').next().unwrap_or("").trim();
        let ours = owned.contains_key(key) || purge.contains_key(key);
        if key.is_empty() || line.trim_start().starts_with('#') || !ours {
            out.push_str(line);
            out.push('\n');
        }
    }

    // The blank lines the removed banners left behind go with them, so the separator below is one
    // blank line rather than one more on every start.
    let kept = out.trim_end_matches('\n');
    let mut out = if kept.is_empty() {
        String::new()
    } else {
        format!("{kept}\n")
    };
    out.push_str(&format!("\n{BANNER}\n"));
    for (key, value) in owned {
        let value = carried.get(key).unwrap_or(value);
        out.push_str(&format!("{key}={value}\n"));
    }

    // Publish only after the replacement is private and durable. Tightening permissions after
    // writing exposes new bytes through the old mode (and through any links to the old inode).
    write_private_file(path, out.as_bytes())
}
