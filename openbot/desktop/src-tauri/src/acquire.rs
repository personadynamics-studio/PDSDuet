//! Getting an engine onto a machine that has none, and a machine behind it.
//!
//! Two steps that look like one. Installing Podman puts a binary on PATH; it does not give you
//! anything that answers. On macOS and Windows a `podman machine` has to be created and started
//! first, and that is where the platform differences live.
//!
//! **Windows cannot do this from a service.** `podman machine init` shells out to `wsl.exe`, and WSL
//! refuses to run as LocalSystem: `Wsl/WSL_E_LOCAL_SYSTEM_NOT_SUPPORTED`. Meanwhile `wsl --install`
//! needs elevation. So the two halves run in different contexts, and the elevated half is the only
//! part that may be handed to a helper. See `windows.rs`. Fetching and installing Podman itself is
//! `install.rs`.

use crate::quiet::said as command_said;
use std::net::Ipv4Addr;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::engine::{Address, Engine};

/// Named so a caller can say which step failed rather than that a step did.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Step {
    CreateMachine,
    StartMachine,
}

/// How a step went, in both registers when it went badly.
///
/// Two fields and not one for the reason `problem.rs` gives: `podman machine init` failing is
/// exactly the case where the engine's own output was put in front of somebody as the headline.
/// The row shows `said`; `detail` is the output, kept.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StepOutcome {
    pub step: Step,
    pub ok: bool,
    /// The sentence for the step row, and for the failure when there is one.
    pub said: String,
    /// What the command actually said, where a command said anything.
    pub detail: Option<String>,
}

impl StepOutcome {
    fn went(step: Step, said: impl Into<String>) -> Self {
        Self {
            step,
            ok: true,
            said: said.into(),
            detail: None,
        }
    }

    /// A failed step, with the engine's own words kept behind the sentence.
    fn stopped(step: Step, output: &str) -> Self {
        let problem = crate::problem::Problem::with(explain_machine_error(output), output);
        Self {
            step,
            ok: false,
            said: problem.said,
            detail: problem.detail,
        }
    }

    /// This step's failure, for a caller that has to return one.
    pub fn problem(&self) -> crate::problem::Problem {
        let mut problem = crate::problem::Problem::plain(self.said.clone());
        problem.detail = self.detail.clone();
        problem
    }
}

/// The name of the machine this app owns.
///
/// Its own, not `podman-machine-default`: somebody may already have a machine with their own work
/// in it, and an installer that reconfigures or deletes it has taken something that was not
/// offered.
pub const MACHINE: &str = "openbot";

const USER_MODE_NETWORKING_FLAG: &str = "--user-mode-networking=true";
const HOST_GATEWAY_CONFIG: &str = ".config/containers/containers.conf.d/90-openbot-host.conf";

fn podman(args: &[&str]) -> Result<String, String> {
    podman_with(args, || {
        crate::engine::tool(Engine::Podman).args(args).output()
    })
}

fn podman_with(
    args: &[&str],
    run: impl FnOnce() -> std::io::Result<std::process::Output>,
) -> Result<String, String> {
    // Resolved, not named: right after OpenBot installs it, `podman` is not yet on this process's
    // PATH. See the PATH rule in `engine.rs`.
    let output = run().map_err(|error| format!("could not run podman: {error}"))?;
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).trim().to_string());
    }
    Err(command_failure("podman", args, &output))
}

fn command_failure(binary: &str, args: &[&str], output: &std::process::Output) -> String {
    let status = output.status.code().map_or_else(
        || "terminated by signal".to_string(),
        |code| code.to_string(),
    );
    let stdout = command_said(&output.stdout);
    let stderr = command_said(&output.stderr);
    let command = std::iter::once(binary)
        .chain(args.iter().copied())
        .collect::<Vec<_>>()
        .join(" ");
    match (stdout.trim().is_empty(), stderr.trim().is_empty()) {
        (true, true) => format!("{command} exited with status {status}"),
        (false, true) => format!("{command} exited with status {status}; stdout: {stdout}"),
        (true, false) => format!("{command} exited with status {status}; stderr: {stderr}"),
        (false, false) => {
            format!("{command} exited with status {status}; stdout: {stdout}; stderr: {stderr}")
        }
    }
}

fn machine_exists_with(run: impl FnOnce() -> Result<String, String>) -> Result<bool, String> {
    #[derive(Deserialize)]
    struct ListedMachine {
        #[serde(rename = "Name")]
        name: String,
    }

    let listing = run()?;
    let machines: Vec<ListedMachine> = serde_json::from_str(&listing).map_err(|error| {
        format!("could not read podman machine list JSON: {error}; stdout: {listing}")
    })?;
    Ok(machines.iter().any(|machine| machine.name == MACHINE))
}

/// Does this app's machine already exist?
pub fn machine_exists() -> Result<bool, String> {
    // --quiet still uses Podman's human format, which appends '*' to the default machine's name.
    // JSON preserves the raw Name, independently of whether the machine is running or default.
    machine_exists_with(|| podman(&["machine", "list", "--format", "json"]))
}

/// Create the machine.
///
/// No `--provider`: `applehv` has been the default on Apple silicon since Podman 6.1, and pinning it
/// asks for what you already get. The libkrun bind-mount trouble that the pin was written for
/// belonged to 5.7, where libkrun was the default.
pub fn create_machine(cpus: u32, memory_mib: u32, disk_gib: u32) -> StepOutcome {
    create_machine_with(cpus, memory_mib, disk_gib, machine_exists, podman)
}

fn create_machine_with(
    cpus: u32,
    memory_mib: u32,
    disk_gib: u32,
    exists: impl FnOnce() -> Result<bool, String>,
    mut run: impl FnMut(&[&str]) -> Result<String, String>,
) -> StepOutcome {
    match exists() {
        Ok(true) => {
            return StepOutcome::went(Step::CreateMachine, format!("{MACHINE} already exists."));
        }
        Ok(false) => {}
        Err(error) => return StepOutcome::stopped(Step::CreateMachine, &error),
    }
    let args = create_machine_args(cpus, memory_mib, disk_gib, cfg!(target_os = "windows"));
    let refs = args.iter().map(String::as_str).collect::<Vec<_>>();
    match run(&refs) {
        Ok(_) => StepOutcome::went(Step::CreateMachine, format!("{MACHINE} created.")),
        Err(error) => StepOutcome::stopped(Step::CreateMachine, &error),
    }
}

fn create_machine_args(
    cpus: u32,
    memory_mib: u32,
    disk_gib: u32,
    target_is_windows: bool,
) -> Vec<String> {
    let mut args = vec![
        "machine".to_string(),
        "init".to_string(),
        MACHINE.to_string(),
        "--cpus".to_string(),
        cpus.to_string(),
        "--memory".to_string(),
        memory_mib.to_string(),
        "--disk-size".to_string(),
        disk_gib.to_string(),
    ];
    if target_is_windows {
        args.push(USER_MODE_NETWORKING_FLAG.to_string());
    }
    args
}

#[derive(Debug, PartialEq, Eq)]
struct MachineNetworking {
    state: String,
    user_mode: bool,
}

fn prepare_user_mode_networking_before_start(
    run: &mut impl FnMut(&[&str]) -> Result<String, String>,
    target_is_windows: bool,
) -> Result<(), String> {
    if !target_is_windows {
        return Ok(());
    }

    let listing = run(&["machine", "inspect", MACHINE])?;
    let networking = owned_machine_networking(&listing)?;
    if networking.state.eq_ignore_ascii_case("running") && !networking.user_mode {
        return Err(format!(
            "{MACHINE} is already running without Podman user-mode networking. Stop the OpenBot engine machine and start OpenBot again so host callbacks can be configured."
        ));
    }
    if networking.state.eq_ignore_ascii_case("stopped") && !networking.user_mode {
        run(&["machine", "set", USER_MODE_NETWORKING_FLAG, MACHINE])?;
    }
    Ok(())
}

fn owned_machine_networking(listing: &str) -> Result<MachineNetworking, String> {
    let machines: Vec<Value> = serde_json::from_str(listing)
        .map_err(|error| format!("could not inspect {MACHINE} networking: {error}"))?;
    let machine = machines
        .iter()
        .find(|machine| machine.get("Name").and_then(Value::as_str) == Some(MACHINE))
        .ok_or_else(|| format!("podman machine inspect did not return {MACHINE}"))?;
    let state = machine
        .get("State")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("podman machine inspect did not include {MACHINE} state"))?
        .to_string();
    let user_mode = machine
        .get("UserModeNetworking")
        .and_then(Value::as_bool)
        .ok_or_else(|| {
            format!("podman machine inspect did not include {MACHINE} user-mode networking")
        })?;
    Ok(MachineNetworking { state, user_mode })
}

fn configure_host_gateway_after_start(
    run: &mut impl FnMut(&[&str]) -> Result<String, String>,
    target_is_windows: bool,
) -> Result<(), String> {
    if !target_is_windows {
        return Ok(());
    }

    let resolved = run(&[
        "machine",
        "ssh",
        MACHINE,
        "getent",
        "ahostsv4",
        "host.containers.internal",
    ])?;
    let ip = first_valid_host_gateway_ip(&resolved)?;
    let script = host_gateway_config_script(ip);
    run(&["machine", "ssh", MACHINE, &script]).map(|_| ())
}

fn configure_owned_windows_podman_for_compose(
    address: &Address,
    mut run: impl FnMut(&[&str]) -> Result<String, String>,
    target_is_windows: bool,
) -> Result<(), String> {
    if !owned_windows_podman_address(address, target_is_windows) {
        return Ok(());
    }
    let listing = run(&["machine", "inspect", MACHINE])?;
    let networking = owned_machine_networking(&listing)?;
    if !networking.user_mode {
        return Err(format!(
            "{MACHINE} is running without Podman user-mode networking. Stop the OpenBot engine machine and start OpenBot again so host callbacks can be configured."
        ));
    }
    configure_host_gateway_after_start(&mut run, true)
}

/// Run before Compose even when an existing engine skipped the install/start steps.
pub fn prepare_for_compose(address: &Address) -> Result<(), String> {
    configure_owned_windows_podman_for_compose(address, podman, cfg!(target_os = "windows"))
}

fn owned_windows_podman_address(address: &Address, target_is_windows: bool) -> bool {
    target_is_windows
        && address.engine == Engine::Podman
        && address.connection.as_deref() == Some(MACHINE)
}

fn first_valid_host_gateway_ip(raw: &str) -> Result<Ipv4Addr, String> {
    for field in raw.split_whitespace() {
        if let Ok(ip) = field.parse::<Ipv4Addr>() {
            return validate_host_gateway_ip(ip);
        }
    }
    Err(format!(
        "could not resolve host.containers.internal in the {MACHINE} VM as IPv4"
    ))
}

fn validate_host_gateway_ip(ip: Ipv4Addr) -> Result<Ipv4Addr, String> {
    if ip.is_unspecified() || ip.is_loopback() {
        return Err(format!(
            "resolved host.containers.internal in the {MACHINE} VM to unusable address {ip}"
        ));
    }
    Ok(ip)
}

fn host_gateway_config_script(ip: Ipv4Addr) -> String {
    format!(
        "set -e; \
         mkdir -p \"$HOME/.config/containers/containers.conf.d\"; \
         target=\"$HOME/{HOST_GATEWAY_CONFIG}\"; \
         tmp=\"$target.tmp\"; \
         cat > \"$tmp\" <<'EOF'\n[containers]\nhost_containers_internal_ip=\"{ip}\"\nEOF\n\
         if [ -f \"$target\" ] && cmp -s \"$tmp\" \"$target\"; then \
           rm \"$tmp\"; \
         else \
           mv \"$tmp\" \"$target\"; \
           systemctl --user try-restart podman.service; \
         fi"
    )
}

fn start_machine_with(
    mut run: impl FnMut(&[&str]) -> Result<String, String>,
    target_is_windows: bool,
) -> StepOutcome {
    if let Err(error) = prepare_user_mode_networking_before_start(&mut run, target_is_windows) {
        return StepOutcome::stopped(Step::StartMachine, &error);
    }
    let started = match run(&["machine", "start", MACHINE]) {
        Ok(_) => format!("{MACHINE} started."),
        Err(error) if error.contains("already running") => {
            format!("{MACHINE} was already running.")
        }
        Err(error) => return StepOutcome::stopped(Step::StartMachine, &error),
    };
    if let Err(error) = configure_host_gateway_after_start(&mut run, target_is_windows) {
        return StepOutcome::stopped(Step::StartMachine, &error);
    }
    StepOutcome::went(Step::StartMachine, started)
}

pub fn start_machine() -> StepOutcome {
    start_machine_with(podman, cfg!(target_os = "windows"))
}

/// Turn Podman's own words into an instruction, where we know one.
///
/// Every string matched here was produced by a real failure on a real machine during S2. A person
/// reading "exit status 0xffffffff" learns nothing; a person reading "Windows needs restarting"
/// knows what to do next.
fn explain_machine_error(error: &str) -> String {
    if error.contains("WSL_E_LOCAL_SYSTEM_NOT_SUPPORTED") {
        return "WSL will not run as the system account, so this step has to run as you. \
                Restart OpenBot without elevation."
            .into();
    }
    if error.contains("WSL_E_WSL_OPTIONAL_COMPONENT_REQUIRED") {
        return "Windows Subsystem for Linux is installed but not active yet. Windows needs \
                restarting before a machine can be created."
            .into();
    }
    if error.contains("not enough space") || error.contains("no space left") {
        return "There is not enough disk space to create the engine's virtual machine.".into();
    }
    error.to_string()
}

/// How to reach the machine this app just started.
///
/// Always by name. The default connection belongs to whoever set it, and after `machine init` it is
/// usually still pointing somewhere else.
pub fn address() -> Address {
    Address::new(Engine::Podman, Some(MACHINE.to_string()))
}

/// What to install, named, rather than seven errors about a file that is not there.
///
/// A last resort, not the plan: OpenBot installs a Compose provider itself, so somebody only reads
/// this when that copy is missing or is not being found. The restart comes first for that reason,
/// and the platform's own instruction is behind it.
///
/// Compose v2 rather than `podman-compose`: v2 is what the stack was tested against, and it is what
/// reads the healthchecks and `depends_on` conditions in `docker-compose.yml`. `podman-compose` is
/// a separate reimplementation with its own coverage of those, and choosing it here would mean
/// shipping a deployment nobody has run.
pub fn missing_compose(binary: &str) -> String {
    // Named per platform, because the generic sentence sent a Windows install looking for a
    // package manager it does not have. Podman ships no Compose provider on Windows either, which
    // was measured rather than assumed: a fresh Podman 6.1.1 there stops at exactly this gate.
    let install = if cfg!(target_os = "linux") {
        "Install Compose v2: `sudo apt install docker-compose-v2` on Debian or Ubuntu, or \
         `sudo dnf install docker-compose` on Fedora."
    } else if cfg!(target_os = "windows") {
        "Install Compose v2: either install Docker Desktop, or download `docker-compose` from \
         github.com/docker/compose/releases and put it beside the engine on PATH."
    } else {
        "Install Compose v2: `brew install docker-compose`, or install Docker Desktop, and make \
         sure `docker-compose` is on PATH."
    };
    format!(
        "{binary} is answering, but it has no Compose to run the stack with, and OpenBot's own \
         copy of one is not being found. Restart OpenBot and try again. If this comes back: \
         {install}"
    )
}

/// Where a downloaded installer is kept, so a failed run can be retried without downloading again.
pub fn download_dir(cache: &Path) -> std::path::PathBuf {
    cache.join("openbot-engine")
}
