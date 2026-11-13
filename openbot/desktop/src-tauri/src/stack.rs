//! Raising the stack: the Compose services, then the three processes that are not containers.
//!
//! `docker-compose.yml` has no `app`, `server` or `worker` service, and the root `Dockerfile` leaves
//! out the supervisor because it needs a socket no serverless platform grants. So the shape is not a
//! choice: containers for postgres, the supervisor, `agent-computer`, the Bots and a one-shot
//! `initialize`, and three host processes for the rest. `scripts/start.sh` does exactly this for a
//! developer. This does it for somebody who double-clicked.
//!

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use crate::quiet::{command, said as command_said};

use serde::{Deserialize, Serialize};

use crate::engine::Address;
use crate::problem::Problem;

/// The services Compose owns. `initialize` is deliberately absent: it is run once, to completion,
/// rather than raised, and treating it as a long-lived service makes it look like a crash loop.
const SERVICES: [&str; 3] = ["postgres", "supervisor", "agent-computer"];

/**
The Bots that ship with OpenBot, which only run on an API key.

BOTH REFUSE TO START WITHOUT ONE, saying so themselves: "OPENAI_API_KEY is not set. This Bot cannot
answer without a model." That is correct of them and wrong of us to ignore. Somebody who signs in
with the ChatGPT or Claude subscription they already pay for has no key by design, so raising these
gave them two containers that died on startup and two red lines on the setup screen, about Bots they
never chose.

Started when a key exists and left alone when it does not. The Bot the person actually picked speaks
its plan and answers either way, which is what the last screen proves.
*/
const AGENT_BOT: &str = "agent-bot";
const AGENT_LANGGRAPH: &str = "agent-langgraph";
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct BundledBots {
    pub agent_bot: bool,
    pub agent_langgraph: bool,
}

impl BundledBots {
    /// One provider decision for both service selection and the advertised package endpoint.
    pub fn for_credential(credential: &crate::env::ModelCredential) -> Self {
        use crate::env::ModelCredential;
        match credential {
            ModelCredential::OpenAi { .. }
            | ModelCredential::Compatible { .. }
            | ModelCredential::ProviderOAuth { .. } => Self::openai_compatible(),
            ModelCredential::Anthropic { .. } => Self::anthropic(),
            ModelCredential::None
            | ModelCredential::ClaudePlan { .. }
            | ModelCredential::ChatGptPlan { .. } => Self::none(),
        }
    }

    pub const fn none() -> Self {
        Self {
            agent_bot: false,
            agent_langgraph: false,
        }
    }

    pub const fn openai_compatible() -> Self {
        Self {
            agent_bot: true,
            agent_langgraph: true,
        }
    }

    pub const fn anthropic() -> Self {
        Self {
            agent_bot: false,
            agent_langgraph: true,
        }
    }
}

pub fn selected_services(harness: bool, bots: BundledBots) -> Vec<&'static str> {
    let mut services = SERVICES.to_vec();
    if bots.agent_bot {
        services.push(AGENT_BOT);
    }
    if bots.agent_langgraph {
        services.push(AGENT_LANGGRAPH);
    }
    if harness {
        services.push("agent-harness");
    }
    services
}

/// The three that are not containers, in the order they are started.
///
/// The server first, because the app serves a page that talks to it and the worker claims routines
/// it owns. Nothing here waits on the others: each is supervised on its own and reports its own
/// state, so a worker that dies does not take the window with it.
pub const HOST_PROCESSES: [HostProcess; 3] = [
    HostProcess {
        name: "server",
        cwd: "server",
        script: "src/production-entry.ts",
    },
    // Serve the built frontend in the installed app.
    HostProcess {
        name: "app",
        cwd: "app",
        script: "serve.ts",
    },
    HostProcess {
        name: "worker",
        cwd: "worker",
        script: "src/index.ts",
    },
];

#[derive(Clone, Copy, Debug)]
/// One of the three processes Compose does not run.
///
/// The app is started through the package's own `dev` script, which runs Vite through bun rather
/// than through its shebang. `node_modules/.bin/vite` begins `#!/usr/bin/env node`, so a machine
/// with bun and no Node starts the app, fails with `node: command not found`, and is restarted
/// five more times before this gives up on it. Which is what happened on the Linux machine this
/// was tested on, and would happen to anybody who installed OpenBot without also having Node.
pub struct HostProcess {
    pub name: &'static str,
    pub cwd: &'static str,
    pub script: &'static str,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Phase {
    EngineMissing,
    Starting,
    Migrating,
    WaitingForServices,
    Running,
    Stopped,
    Failed,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StackStatus {
    pub phase: Phase,
    pub detail: String,
}

/**
The credentials a deployment needs, handed to a child process rather than left in its `.env`.

THIS IS WHY THE FILE CAN STOP HOLDING THEM. Compose resolves `${VAR}` from its own environment
before it reads `.env`, so a secret passed here reaches exactly the containers that declare it and
is written down nowhere. The host processes take theirs the same way, alongside the `--env-file`
that still carries the settings.

A `BTreeMap` rather than the vault directly: reading a credential store once per run and passing
what it gave is one prompt and one failure point, where reading it per command is neither.
*/
pub type Secrets = std::collections::BTreeMap<String, String>;

fn compose_command(engine: &Address, root: &Path, secrets: &Secrets) -> Command {
    let mut command = engine.command();
    command.current_dir(root).args(["compose"]).envs(secrets);
    command
}

/// Resolve only image references, using public installation overrides before credentials exist.
pub fn installation_images(
    engine: &Address,
    root: &Path,
    harness: bool,
    settings: &Secrets,
) -> Result<Vec<String>, Problem> {
    let mut requested = selected_services(harness, BundledBots::openai_compatible());
    requested.push("initialize");
    let mut command = compose_command(engine, root, settings);
    if harness {
        command.args(["--profile", "harness"]);
    }
    let output = command
        .args(["config", "--images"])
        .args(requested)
        .output()
        .map_err(|e| {
            Problem::with(
                "OpenBot could not check which software to install.",
                e.to_string(),
            )
        })?;
    if !output.status.success() {
        return Err(Problem::with(
            "OpenBot could not check which software to install.",
            command_said(&output.stderr),
        ));
    }
    let images: std::collections::BTreeSet<String> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect();
    if images.is_empty() {
        return Err(Problem::plain(
            "This deployment does not identify the software OpenBot needs to install.",
        ));
    }
    Ok(images.into_iter().collect())
}

/// Raise the selected containers.
pub fn up(
    engine: &Address,
    root: &Path,
    harness: bool,
    // Which bundled Bots can read the provider the model screen selected.
    bots: BundledBots,
    secrets: &Secrets,
) -> Result<Vec<&'static str>, crate::problem::Problem> {
    /*
     * The picked harness rides in on its profile.
     *
     * `agent-harness` is profile-gated so a deployment that picked nothing does not try to start
     * it: its image comes from `.env`, and unset that is a request to pull the empty string, which
     * fails the whole `up` rather than the one service nobody asked for. The flag comes before
     * `up`, because `--profile` is an option of `compose` itself and not of the subcommand.
     */
    let requested = selected_services(harness, bots);
    let mut command = compose_command(engine, root, secrets);
    if harness {
        command.args(["--profile", "harness"]);
    }
    let output = command
        .args(["up", "-d"])
        .args(&requested)
        .output()
        .map_err(|error| format!("could not run {} compose: {error}", engine.engine.binary()))?;

    if output.status.success() {
        return Ok(requested);
    }
    // Both registers: the sentence is chosen from what the engine said, and what it said is kept
    // beside it rather than shown as the headline. See `problem.rs`.
    let raw = command_said(&output.stderr);
    Err(crate::problem::Problem::with(
        crate::problem::said_about(&raw),
        raw,
    ))
}

/// Initialize the fresh local database schema.
///
/// A release step rather than a start step, for the reason `server/Dockerfile` gives: two replicas
/// starting together would race, and a failed migration should stop the start rather than leave a
/// half-migrated database serving.
pub fn initialize(
    engine: &Address,
    root: &Path,
    secrets: &Secrets,
) -> Result<(), crate::problem::Problem> {
    let output = compose_command(engine, root, secrets)
        .args(["run", "--rm", "initialize"])
        .output()
        .map_err(|error| format!("could not initialize the schema: {error}"))?;

    if output.status.success() {
        return Ok(());
    }
    // Both registers: the sentence is chosen from what the engine said, and what it said is kept
    // beside it rather than shown as the headline. See `problem.rs`.
    let raw = command_said(&output.stderr);
    Err(crate::problem::Problem::with(
        crate::problem::said_about(&raw),
        raw,
    ))
}

/// The label the supervisor stamps on every container it creates.
///
/// Matching on this rather than on a name prefix. `openbot-` is also the prefix of a kind cluster's
/// nodes and of anything else somebody has called openbot, and stopping a person's Kubernetes
/// cluster because it shares six letters with this one would be unforgivable.
/// Written as the whole filter, `label=` and all. Handed to the engine without that prefix it
/// answers `invalid filter`, and it does so at the moment somebody is being told their stack has
/// stopped, so the prefix belongs with the label rather than at the call site.
const SUPERVISOR_FILTER: &str = "label=openbot.supervisor=true";

/// Resolve the same namespace the selected deployment gives its supervisor. Compose owns
/// interpolation, env-file quoting and defaults; parsing .env independently can select a different
/// deployment. Never include the resolved configuration (which can contain secrets) in an error.
fn computer_namespace(engine: &Address, root: &Path) -> Result<Option<String>, String> {
    let config = root.join("docker-compose.yml");
    match std::fs::metadata(&config) {
        Ok(metadata) if metadata.is_file() => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if !crate::deployment::stamp_path(root)
                .try_exists()
                .map_err(|error| format!("could not verify computer namespace ownership: {error}"))?
            {
                // Welcome/setup has no deployment yet. In particular, do not let Compose search
                // a parent directory for a file belonging to another installation.
                return Ok(None);
            }
            return Err("could not resolve computer namespace: installed deployment is missing docker-compose.yml".into());
        }
        _ => return Err("could not resolve computer namespace: selected deployment configuration is not readable".into()),
    }
    let output = compose_command(engine, root, &Secrets::new())
        .args(["-f", "docker-compose.yml", "config", "--format", "json"])
        .output()
        .map_err(|error| format!("could not resolve computer namespace: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "could not resolve computer namespace: Compose configuration failed ({})",
            output.status
        ));
    }
    let config: serde_json::Value = serde_json::from_slice(&output.stdout).map_err(|error| {
        format!("could not resolve computer namespace: unreadable Compose response ({error})")
    })?;
    let configured = config
        .pointer("/services/supervisor/environment/COMPUTER_NAMESPACE")
        .and_then(serde_json::Value::as_str)
        .ok_or("could not resolve computer namespace: supervisor configuration has no namespace")?;
    // Match supervisor/src/names.ts: trim, default only an empty value, then the same 64-character
    // ASCII identifier grammar. A malformed/missing response never becomes an unscoped filter.
    let namespace = match configured.trim() {
        "" => "openbot",
        value => value,
    };
    if namespace.len() > 64
        || !namespace.as_bytes()[0].is_ascii_alphanumeric()
        || !namespace
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err("could not resolve computer namespace: supervisor namespace is invalid".into());
    }
    Ok(Some(namespace.to_string()))
}

/// Stop the computers the supervisor made, which Compose does not know about.
///
/// A Bot's computer is created at runtime, not declared in `docker-compose.yml`, so `compose down`
/// leaves it running: an idle Ubuntu container per Bot, with the application gone and nothing on
/// screen to stop it from. Stopped rather than removed, because the supervisor starts an existing
/// owned container back up and the Bot keeps the profile and workspace volumes attached to it.
/// Quiesce the supervisor before listing so in-flight creates and restarts are included.
/// Returns false only when the selected root has no installed deployment to take down.
pub fn stop_computers(engine: &Address, root: &Path) -> Result<bool, String> {
    let Some(namespace) = computer_namespace(engine, root)? else {
        return Ok(false);
    };
    // Validate ownership before stopping anything, then wait for the creator to exit. A list taken
    // while the supervisor is active can miss a new computer or one it restarts after being stopped.
    let supervisor = compose_command(engine, root, &Secrets::new())
        .args(["-f", "docker-compose.yml", "stop", "supervisor"])
        .output()
        .map_err(|error| format!("could not stop the supervisor: {error}"))?;
    if !supervisor.status.success() {
        return Err(format!(
            "could not stop the supervisor ({}): {}",
            supervisor.status,
            command_said(&supervisor.stderr)
        ));
    }

    let namespace_filter = format!("label=openbot.namespace={namespace}");
    let listed = engine
        .command()
        .args([
            "ps",
            "--quiet",
            "--filter",
            SUPERVISOR_FILTER,
            "--filter",
            &namespace_filter,
        ])
        .output()
        .map_err(|error| format!("could not list the Bots' computers: {error}"))?;
    if !listed.status.success() {
        return Err(command_said(&listed.stderr));
    }

    let running: Vec<String> = String::from_utf8_lossy(&listed.stdout)
        .split_whitespace()
        .map(str::to_string)
        .collect();
    if running.is_empty() {
        return Ok(true);
    }

    let stopped = engine
        .command()
        .arg("stop")
        .args(&running)
        .output()
        .map_err(|error| format!("could not stop the Bots' computers: {error}"))?;
    if stopped.status.success() {
        return Ok(true);
    }
    Err(command_said(&stopped.stderr))
}

pub fn down(engine: &Address, root: &Path) -> Result<(), String> {
    // Stop the supervisor and its runtime-created computers before removing the Compose stack.
    if !stop_computers(engine, root)? {
        return Ok(());
    }

    /*
     * WITH THE PROFILE, OR THE PICKED BOT KEEPS RUNNING.
     *
     * Measured: after pressing Stop, `compose ps` still listed `agent-harness`. Compose only acts
     * on a profiled service when the profile is named, so Stop was leaving the one container the
     * person actually chose running on their laptop, still holding its port. The next Start then
     * refused because something was listening on it.
     *
     * Named unconditionally rather than only when a harness was picked: this has to stop what an
     * earlier run started, and whether that run picked one is not something a Stop can know.
     */
    let output = compose_command(engine, root, &Secrets::new())
        .args(["-f", "docker-compose.yml", "--profile", "harness", "down"])
        .output()
        .map_err(|error| format!("could not stop the stack: {error}"))?;

    if output.status.success() {
        return Ok(());
    }
    Err(command_said(&output.stderr))
}

/// Install the deployment's dependencies.
pub fn install_dependencies(root: &Path, bun: &Path) -> Result<(), String> {
    // `--ignore-scripts`, for two reasons that point the same way.
    //
    // A postinstall script is arbitrary code from somebody else's package, and an installer that
    // runs it on a person's machine while they watch a progress bar is doing something they did not
    // ask for. And they are not all portable: `@scarf/scarf` shells out to `node`, which a machine
    // that has bun need not have, so the install fails at "node: command not found" after the
    // containers are already up. Found on a Linux machine with bun and no node.
    let output = command(bun)
        .current_dir(root)
        .args(["install", "--ignore-scripts"])
        .output()
        .map_err(|error| format!("could not run bun install: {error}"))?;

    if output.status.success() {
        return Ok(());
    }
    Err(format!(
        "installing the deployment's dependencies failed: {}",
        command_said(&output.stderr)
    ))
}

/// Start one host process, with its output on disk rather than nowhere.
///
/// A window has no console to inherit, so a process whose output is dropped fails invisibly: the
/// symptom is a port that never answers and a log directory that explains why.
pub fn host_pids_path(root: &Path) -> PathBuf { root.join(".logs").join("host-pids.json") }

pub fn record_host_pids(root: &Path, pids: &[u32]) -> Result<(), Problem> {
    let bytes = serde_json::to_vec(pids).map_err(|e| Problem::from(e.to_string()))?;
    std::fs::write(host_pids_path(root), bytes).map_err(|e| Problem::from(e.to_string()))
}

pub fn stop_processes_under(root: &Path) -> Result<usize, Problem> {
    let file = host_pids_path(root);
    let bytes = match std::fs::read(&file) { Ok(bytes) => bytes, Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0), Err(e) => return Err(Problem::from(e.to_string())) };
    let pids: Vec<u32> = serde_json::from_slice(&bytes).map_err(|e| Problem::from(e.to_string()))?;
    for pid in &pids {
        #[cfg(windows)]
        let output = command("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"]).output();
        #[cfg(not(windows))]
        let output = command("kill").args(["-TERM", &pid.to_string()]).output();
        output.map_err(|e| Problem::from(e.to_string()))?;
    }
    std::fs::remove_file(file).map_err(|e| Problem::from(e.to_string()))?;
    Ok(pids.len())
}

fn configure_host_process_env(command: &mut Command, name: &str, secrets: &Secrets) {
    command.envs(secrets);
    if name != "server" { command.env_remove("OPENBOT_DESKTOP_HOST_TOKEN"); }
}

pub fn spawn_host_process(
    process: &HostProcess,
    root: &Path,
    logs: &Path,
    bun: &Path,
    secrets: &Secrets,
) -> std::io::Result<std::process::Child> {
    std::fs::create_dir_all(logs)?;
    let out = std::fs::File::create(logs.join(format!("{}.log", process.name)))?;
    let err = out.try_clone()?;

    let mut command = command(bun);
    command.current_dir(root.join(process.cwd));
    /*
     * The credentials, alongside the `--env-file` that carries the settings.
     *
     * They are not in that file any more, and this is where they rejoin. The environment wins over
     * the file either way, so a machine still holding an older run's copy is overridden rather than
     * fought with.
     */
    configure_host_process_env(&mut command, process.name, secrets);
    command.args(["--env-file=../.env", process.script]);
    command
        .stdout(Stdio::from(out))
        .stderr(Stdio::from(err))
        .stdin(Stdio::null());
    command.spawn()
}

/// Where the shell keeps the deployment it manages.
pub fn default_root() -> PathBuf {
    dirs_home().join("OpenBot")
}

/// The deployment directory somebody typed, as a path.
///
/// Trimmed, the way the four settings entered beside it on the same screen already are. That screen
/// enables Start on `root.trim() !== ""` and then sends the untrimmed string, so a path pasted with
/// the space the selection picked up, or with the newline a copied line carries, arrives here whole
/// -- and this is the one of the five values that is not a credential but a place on disk.
///
/// A trailing space makes a second directory beside the one everything else means: the tray's Stop
/// and the next launch both ask `default_root`, which has no space in it, so a person is left with
/// a deployment nothing on screen can reach. A leading one is worse, because a path that begins
/// with a space does not begin with a separator: it stops being absolute, and the whole deployment
/// is laid out relative to wherever the window happens to be running from.
///
/// Only the ends. A space inside a path is part of a directory's name and stays where it is.
pub fn root_from(typed: &str) -> PathBuf {
    PathBuf::from(typed.trim())
}

fn dirs_home() -> PathBuf {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
}
