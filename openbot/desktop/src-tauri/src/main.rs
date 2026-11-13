// A window, not a console. Release builds on Windows must not open one behind the app.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::{Path, PathBuf};
use std::sync::Mutex;

mod desktop_host_access;
mod desktop_telemetry;

use openbot_desktop_lib::{
    acquire, deployment, deployment_release, engine, env as openbot_env, harness, host_access,
    install, preparation, problem::Problem, provider, pull_metrics, quiet, stack,
    telemetry, tray, windows as win,
};

const QUIT_MENU_ACCELERATOR: &str = "CmdOrCtrl+KeyQ";
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

/// What the shell is running, so the window and the tray say the same thing.
#[derive(Default)]
struct Shell {
    /// Session-only local folder authority; shutdown retires it before stopping the API server.
    host_access: Mutex<Option<host_access::HostAccess>>,
    /// Native child handles used by Stop and Quit.
    children: Mutex<Vec<(&'static str, std::process::Child)>>,
    /// Native Linux engine API owned by this desktop session, kept through Stop/Start.
    #[cfg(target_os = "linux")]
    podman_api: Mutex<engine::local_api::Service>,
    /// Why the stack stopped, kept for the screen that has not loaded yet.
    ///
    /// Going back to the setup screen is a navigation, and a navigation is a fresh page: React
    /// remounts with no progress and the sentence explaining what happened is lost at the one
    /// moment it is worth reading. Held here instead, and asked for on load.
    last_failure: Mutex<Option<openbot_desktop_lib::problem::Problem>>,
    selected_root: Mutex<Option<PathBuf>>,
    root: Mutex<Option<PathBuf>>,
    /// An Intelligence sign-in waiting for its loopback callback.
    signing_in_to_intelligence:
        Mutex<Option<openbot_desktop_lib::intelligence::SigningInToIntelligence>>,
    /// The credential that sign-in produced, held so a project can be chosen with it.
    intelligence_credential: Mutex<Option<String>>,
    self_hosted_intelligence:
        Mutex<Option<std::sync::Arc<openbot_desktop_lib::self_hosted_intelligence::SigningIn>>>,
    /// A ChatGPT sign-in waiting for the browser redirect to complete it.
    ///
    /// Held for the same reason the Claude one is: a person leaves and comes back in the middle.
    /// Unlike that one, nothing is typed here — the callback finishes it.
    signing_in_to_chatgpt: Mutex<Option<openbot_desktop_lib::plan::SigningInToChatGpt>>,
    /// A plan sign-in waiting for the code from the browser.
    ///
    /// Held across two commands because a person has to leave and approve in the middle of it, and
    /// the flow that showed the URL is the only one that can redeem the code: each start mints its
    /// own PKCE challenge and state, so a second start invalidates the first.
    signing_in: Mutex<Option<openbot_desktop_lib::plan::SigningIn>>,
    /// The configured setup destination, resolved using Tauri's build mode and platform.
    /// WebView2's current URL can still be about:blank during startup; it is never a setup source.
    setup_url: Mutex<Option<String>>,
}

#[derive(Serialize, Clone)]
struct Progress {
    step: String,
    ok: bool,
    detail: String,
    running: bool,
    #[serde(rename = "downloadBytes", skip_serializing_if = "Option::is_none")]
    download_bytes: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SavedModelApiKeys {
    openai: Option<bool>,
    anthropic: Option<bool>,
    compatible: Option<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SavedModelSessions {
    openai: Option<bool>,
    anthropic: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    google: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    xai: Option<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SavedConfiguration {
    intelligence_api_key: Option<bool>,
    model_api_keys: SavedModelApiKeys,
    model_sessions: SavedModelSessions,
    model: Option<openbot_desktop_lib::saved_intent::ModelIntent>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AlreadyConfigured {
    values: std::collections::BTreeMap<String, String>,
    saved: SavedConfiguration,
    harness: Option<harness::HarnessChoice>,
}

fn report<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    step: &str,
    ok: bool,
    detail: impl Into<String>,
) {
    if !ok {
        let error_class = match step {
            "install-engine" => telemetry::SetupErrorClass::EngineInstallFailed,
            "engine" | "create-machine" | "start-machine" | "health-gate" => {
                telemetry::SetupErrorClass::EngineUnavailable
            }
            "env" | "ports" => telemetry::SetupErrorClass::InvalidConfiguration,
            _ => telemetry::SetupErrorClass::Unknown,
        };
        desktop_telemetry::failure(app, error_class);
    }
    let _ = app.emit(
        "setup:progress",
        Progress {
            step: step.into(),
            ok,
            detail: detail.into(),
            running: false,
            download_bytes: None,
        },
    );
}

fn report_running<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    step: &str,
    detail: impl Into<String>,
    download_bytes: Option<u64>,
) {
    let _ = app.emit(
        "setup:progress",
        Progress {
            step: step.into(),
            ok: true,
            detail: detail.into(),
            running: true,
            download_bytes,
        },
    );
}

fn cancel_self_hosted_sign_in(shell: &Shell) {
    let signing = shell.self_hosted_intelligence.lock().unwrap().take();
    if let Some(signing) = signing {
        signing.cancel();
    }
}

fn remember_selected_root(shell: &Shell, root: &Path) {
    let changed = shell.selected_root.lock().unwrap().as_deref() != Some(root);
    if changed {
        cancel_self_hosted_sign_in(shell);
    }
    *shell.selected_root.lock().unwrap() = Some(root.to_path_buf());
}

fn cleanup_root(shell: &Shell, fallback_root: &Path) -> PathBuf {
    shell
        .root
        .lock()
        .unwrap()
        .clone()
        .or_else(|| shell.selected_root.lock().unwrap().clone())
        .unwrap_or_else(|| fallback_root.to_path_buf())
}

#[tauri::command]
fn detect_engine<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> engine::EngineStatus {
    let status = engine::detect();
    desktop_telemetry::observe_engine(&app, &status);
    status
}

#[tauri::command]
fn windows_blocker<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<Option<win::Blocker>, Problem> {
    let result = win::blocker();
    if cfg!(target_os = "windows") {
        use telemetry::WindowsStageOutcome as Outcome;
        let outcome = match &result {
            Ok(None) => Outcome::Ready,
            Ok(Some(win::Blocker::WslAbsent)) => Outcome::WslAbsent,
            Ok(Some(win::Blocker::WslOne)) => Outcome::WslOne,
            Ok(Some(win::Blocker::WslNoKernel)) => Outcome::WslNoKernel,
            Ok(Some(win::Blocker::VirtualMachinePlatformDisabled)) => {
                Outcome::VirtualMachinePlatformDisabled
            }
            Ok(Some(win::Blocker::VirtualizationDisabled)) => Outcome::VirtualizationDisabled,
            Ok(Some(win::Blocker::NotAdministrator)) => Outcome::NotAdministrator,
            Err(_) => Outcome::CheckFailed,
        };
        desktop_telemetry::record(&app, telemetry::EventData::WindowsStage { outcome });
    }
    result
}

#[tauri::command]
fn record_setup_event<R: tauri::Runtime>(app: tauri::AppHandle<R>, event: serde_json::Value) {
    if let Ok(
        event @ (telemetry::EventData::StepViewed { .. }
        | telemetry::EventData::HarnessChosen { .. }
        | telemetry::EventData::ModelChosen { .. }),
    ) = serde_json::from_value(event)
    {
        desktop_telemetry::record(&app, event);
    }
}

#[tauri::command]
fn windows_blocker_instruction(blocker: win::Blocker) -> String {
    blocker.instruction().to_string()
}

/// Install and start the container engine.
///
/// Reported step by step rather than as one result, because these take minutes and a window with
/// nothing moving in it reads as a hang.
#[tauri::command]
async fn prepare_engine(app: tauri::AppHandle) -> Result<engine::EngineStatus, Problem> {
    engine_ready(&app).await?;
    Ok(engine::detect())
}

/// Install local deployment software.
#[tauri::command]
async fn prepare_installation(app: tauri::AppHandle, root: String, harness: Option<harness::HarnessChoice>) -> Result<(), Problem> {
    let root = stack::root_from(&root);
    let address = engine_ready(&app).await?;
    deployment_ready(&app, &root).await?;
    tauri::async_runtime::spawn_blocking(move || {
        let bun = install::ensure_bun(&root, which_bun())?;
        stack::install_dependencies(&root, &bun)?;
        let picked = harness::picked(harness.as_ref(), &root)?;
        let settings = preparation::image_settings(&root, picked.as_ref())?;
        let mut images = stack::installation_images(&address, &root, picked.as_ref().and_then(|p| p.installed_port()).is_some(), &settings)?;
        for name in [openbot_desktop_lib::plan::SIGN_IN_IMAGE, openbot_desktop_lib::plan::CHATGPT_SIGN_IN_IMAGE] {
            images.push(deployment::reference(&root, name)?);
        }
        images.sort(); images.dedup();
        for image in images {
            pull_metrics::pull_image(&address, &image, |_| {}, |metrics| desktop_telemetry::pull_completed(&app, metrics))?;
        }
        preparation::save_selected_root(&app.path().app_config_dir().map_err(|e| Problem::from(e.to_string()))?, &root)?;
        report(&app, "installation", true, "Local software installed.");
        Ok(())
    }).await.map_err(|e| Problem::from(e.to_string()))?
}

async fn engine_ready(app: &tauri::AppHandle) -> Result<engine::Address, Problem> {
    let found = engine::detect();
    desktop_telemetry::observe_engine(app, &found);
    let address = match found.address {
        Some(address) => address,
        None => {
            report_running(app, "install-engine", "Installing container software.", None);
            let installed = tauri::async_runtime::spawn_blocking(|| install::install_engine(&stack::default_root()))
                .await.map_err(|error| Problem::from(error.to_string()))??;
            report(app, "install-engine", true, installed);
            #[cfg(not(target_os = "linux"))]
            {
                let created = acquire::create_machine(4, 6144, 60);
                report(app, "create-machine", created.ok, created.said.clone());
                if !created.ok { return Err(created.problem()); }
                let started = acquire::start_machine();
                report(app, "start-machine", started.ok, started.said.clone());
                if !started.ok { return Err(started.problem()); }
            }
            acquire::address()
        }
    };
    #[cfg(target_os = "linux")]
    app.state::<Shell>().podman_api.lock().unwrap().start(&address, &stack::default_root())?;
    Ok(address)
}

/// Install the latest published deployment on first use, then keep its recorded version.
///
/// Local preparation fetches the manifest needed by both launch and plan sign-in images.
/// An installed deployment keeps its exact tag without consulting GitHub again.
async fn deployment_ready<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    root: &Path,
) -> Result<(), Problem> {
    report_running(app, "deployment", "Checking the OpenBot release.", None);
    // Both release discovery and downloading use blocking HTTP. Keeping them in a blocking task
    // avoids dropping reqwest's runtime inside this async context.
    let target = root.to_path_buf();
    let handle = app.clone();
    let version = tauri::async_runtime::spawn_blocking(move || {
        let version = deployment_release::resolve_version(&target)?;
        if deployment::needs_fetch(&target, &version) {
            report_running(
                &handle,
                "deployment",
                format!("Downloading OpenBot {version}."),
                None,
            );
            deployment::fetch(&target, &version)?;
        }
        Ok::<_, String>(version)
    })
    .await
    .map_err(|error| format!("the download did not run: {error}"))
    .and_then(|result| result)
    .map_err(|error| {
        report(app, "deployment", false, error.clone());
        Problem::with(
            "OpenBot could not download what it needs to run. Check the internet \
             connection and try again.",
            error,
        )
    })?;
    report(
        app,
        "deployment",
        true,
        format!("{version} in {}", root.display()),
    );
    Ok(())
}

/// The reference for an image the shell runs directly, rather than through Compose.

fn prepared_sign_in(root: &Path, published: &str) -> Result<(engine::Address, String), Problem> {
    let status = engine::detect();
    let address = status.address.ok_or_else(|| Problem::plain(status.detail))?;
    Ok((address, deployment::reference(root, published)?))
}

/// What the model screen chose, as the window sends it.
///
/// Deliberately not the same type as `ModelCredential`: this is whatever arrived over the bridge,
/// and turning it into a credential is a conversion that can fail. Accepting the credential type
/// directly would make an impossible combination representable at the boundary.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChosenModel {
    provider: String,
    login: String,
    api_key: Option<String>,
    base_url: Option<String>,
    container_base_url: Option<String>,
    model: Option<String>,
    /// Minted by signing in, never typed. Absent for every path but a plan.
    token: Option<String>,
    /// A saved credential/session indicator chosen in the window. The value is resolved here.
    saved: Option<bool>,
}

impl ChosenModel {
    fn into_credential(self, root: &Path) -> Result<openbot_env::ModelCredential, Problem> {
        self.into_credential_with(root, saved_secret)
    }

    fn into_credential_with(
        self,
        root: &Path,
        mut saved_secret: impl FnMut(&Path, &str) -> Result<String, Problem>,
    ) -> Result<openbot_env::ModelCredential, Problem> {
        let given = |value: Option<String>| value.unwrap_or_default().trim().to_string();
        let saved = self.saved.unwrap_or(false);
        match (self.provider.as_str(), self.login.as_str()) {
            ("google" | "xai", "oauth") => {
                let saved = openbot_desktop_lib::provider_oauth::read(root, &self.provider)
                    .map_err(Problem::plain)?;
                let model = given(self.model);
                if model.is_empty() { return Err("Choose a model for this provider.".into()); }
                Ok(openbot_env::ModelCredential::ProviderOAuth {
                    provider: self.provider,
                    path: root.join(openbot_desktop_lib::provider_oauth::FILE).to_string_lossy().into_owned(),
                    proxy_token: saved.proxy_token,
                    model,
                })
            }
            ("openai", "api-key") => {
                let api_key = if saved {
                    saved_secret(root, "OPENAI_API_KEY")?
                } else {
                    given(self.api_key)
                };
                if saved && api_key.is_empty() {
                    return Err("That saved OpenAI API key is no longer available.".into());
                }
                Ok(openbot_env::ModelCredential::OpenAi { api_key })
            }
            ("anthropic", "api-key") => {
                let api_key = if saved {
                    saved_secret(root, "ANTHROPIC_API_KEY")?
                } else {
                    given(self.api_key)
                };
                if saved && api_key.is_empty() {
                    return Err("That saved Anthropic API key is no longer available.".into());
                }
                Ok(openbot_env::ModelCredential::Anthropic { api_key })
            }
            ("anthropic", "plan") => {
                let token = if saved {
                    saved_secret(root, "CLAUDE_CODE_OAUTH_TOKEN")?
                } else {
                    given(self.token)
                };
                if token.is_empty() {
                    // Said rather than written blank. A plan with no token produces a stack that
                    // comes up and a Bot that cannot answer, which reads as a broken product.
                    return Err("That Claude plan was not signed in to.".into());
                }
                Ok(openbot_env::ModelCredential::ClaudePlan { token })
            }
            /*
             * The sign-in hands back the vendor's whole token store, not one token, and it travels
             * in the same field the Claude plan uses. See `ModelCredential::ChatGptPlan`: the
             * refresh token in there is what keeps the Bot answering past the first hour.
             */
            ("openai", "plan") => {
                let store = if saved {
                    openbot_env::read_plan_store(root)
                        .map_err(|error| {
                            Problem::with(
                                "OpenBot could not read the saved ChatGPT sign-in.",
                                format!("{}: {error}", root.join(openbot_env::CHATGPT_STORE_FILE).display()),
                            )
                        })?
                        .unwrap_or_default()
                } else {
                    given(self.token)
                };
                if store.is_empty() {
                    return Err("That ChatGPT plan was not signed in to.".into());
                }
                Ok(openbot_env::ModelCredential::ChatGptPlan { store })
            }
            ("openai-compatible", "endpoint") => {
                let base_url = given(self.base_url);
                if !reqwest::Url::parse(&base_url)
                    .is_ok_and(|url| matches!(url.scheme(), "http" | "https") && url.has_host())
                {
                    return Err(
                        "Enter a valid http:// or https:// address for your model endpoint.".into(),
                    );
                }
                let container_base_url = given(self.container_base_url);
                if !container_base_url.is_empty()
                    && !reqwest::Url::parse(&container_base_url)
                        .is_ok_and(|url| matches!(url.scheme(), "http" | "https") && url.has_host())
                {
                    return Err(
                        "Enter a valid http:// or https:// address for the container model endpoint.".into(),
                    );
                }
                let model = given(self.model);
                if model.is_empty() {
                    return Err("Enter the model name your endpoint serves.".into());
                }
                let api_key = if saved {
                    use openbot_desktop_lib::saved_intent::{
                        compatible_key_from_record, COMPATIBLE_CREDENTIAL,
                    };
                    let record = saved_secret(root, COMPATIBLE_CREDENTIAL)?;
                    compatible_key_from_record(&record)?
                } else {
                    given(self.api_key)
                };
                Ok(openbot_env::ModelCredential::Compatible {
                    base_url,
                    container_base_url: (!container_base_url.is_empty())
                        .then_some(container_base_url),
                    api_key,
                    model,
                })
            }
            (provider, login) => Err(format!(
                "{provider} cannot be connected by {login}, which is not a way in that screen offers."
            )
            .into()),
        }
    }
}

fn start_stack_credential(
    root: &Path,
    model: ChosenModel,
) -> Result<openbot_env::ModelCredential, Problem> {
    model
        .into_credential(root)
        .map_err(|problem| problem.connection(openbot_desktop_lib::problem::Connection::Model))
}

fn saved_secret(root: &Path, key: &str) -> Result<String, Problem> {
    openbot_desktop_lib::vault::already_given_no_ui(root, &root.join(".env"), &[key])
        .map(|found| found.get(key).cloned().unwrap_or_default())
}

fn intelligence_key_for_start(
    root: &Path,
    given: String,
    mut resolve: impl FnMut(&Path, &str) -> Result<String, Problem>,
) -> Result<String, Problem> {
    let key = if given.trim().is_empty() {
        resolve(root, "INTELLIGENCE_API_KEY").map_err(|problem| {
            problem.connection(openbot_desktop_lib::problem::Connection::Intelligence)
        })?
    } else {
        given
    };
    if key.trim().is_empty() {
        return Err(Problem::plain("That saved CopilotKit connection is no longer available. Sign in again or enter a project key.")
            .connection(openbot_desktop_lib::problem::Connection::Intelligence));
    }
    Ok(key)
}

#[tauri::command]
#[allow(
    clippy::too_many_arguments,
    reason = "These named fields preserve the existing Tauri IPC contract."
)]
async fn start_stack<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    root: String,
    api_url: String,
    gateway_ws_url: String,
    api_key: String,
    model: ChosenModel,
    // The row the person picked, with the address only for the bring-your-own row.
    harness: Option<harness::HarnessChoice>,
    // Both registers on the way out: see `problem.rs`. Anything that still returns a bare string
    // converts to the plain half, so a path without its own sentence reads as it always did.
) -> Result<(), openbot_desktop_lib::problem::Problem> {
    let root = stack::root_from(&root);
    start_stack_inner(
        app,
        root,
        api_url,
        gateway_ws_url,
        api_key,
        model,
        harness,
    )
    .await
}

#[allow(
    clippy::too_many_arguments,
    reason = "Mirror the command fields while testing startup with a resolved root."
)]
async fn start_stack_inner<R: tauri::Runtime>(app: tauri::AppHandle<R>, root: PathBuf, api_url: String, gateway_ws_url: String, api_key: String, model: ChosenModel, harness: Option<harness::HarnessChoice>) -> Result<(), Problem> {
    let shell = app.state::<Shell>();
    remember_selected_root(&shell, &root);
    let credential = start_stack_credential(&root, model)?;
    let picked = harness::picked(harness.as_ref(), &root)?;
    let status = engine::detect();
    let address = status.address.clone().ok_or_else(|| Problem::plain(status.detail.clone()))?;
    let bun = install::ensure_bun(&root, which_bun())?;
    let existing = openbot_desktop_lib::vault::already_given_no_ui(&root, &root.join(".env"), &openbot_env::MINTED[..])?;
    let api_key = intelligence_key_for_start(&root, api_key, saved_secret)?;
    let ports = openbot_env::Ports::read(&root).map_err(|e| Problem::from(e.to_string()))?;
    let settings = openbot_env::compose(&openbot_env::Intelligence { api_url, gateway_ws_url, api_key }, &openbot_env::Model { credential: credential.clone() }, &status, &ports, &deployment::image_variables(&root)?, picked.as_ref(), &existing);
    let (settings, mut secrets) = openbot_desktop_lib::vault::split(settings);
    openbot_desktop_lib::saved_intent::persist_configuration(&root, &settings, &secrets, &secrets, &credential)?;
    secrets.extend(desktop_telemetry::runtime_env(&app));
    stack::up(&address, &root, picked.as_ref().and_then(|p| p.installed_port()).is_some(), stack::BundledBots::for_credential(&credential), &secrets)?;
    stack::migrate(&address, &root, &secrets)?;
    let output = quiet::command(&bun).current_dir(root.join("app")).args(["run", "build"]).output().map_err(|e| Problem::from(e.to_string()))?;
    if !output.status.success() { return Err(Problem::plain(quiet::said(&output.stderr))); }
    use base64::Engine as _;
    let host_token = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(rand::random::<[u8; 32]>());
    secrets.insert("OPENBOT_DESKTOP_HOST_TOKEN".into(), host_token.clone());
    let logs = root.join(".logs");
    *shell.root.lock().unwrap() = Some(root.clone());
    for process in &stack::HOST_PROCESSES {
        let child = stack::spawn_host_process(process, &root, &logs, &bun, &secrets).map_err(|error| Problem::from(error.to_string()))?;
        shell.children.lock().unwrap().push((process.name, child));
        let pids = shell.children.lock().unwrap().iter().map(|(_, child)| child.id()).collect::<Vec<_>>();
        stack::record_host_pids(&root, &pids)?;
        report(&app, process.name, true, "started");
    }
    preparation::save_selected_root(&app.path().app_config_dir().map_err(|e| Problem::from(e.to_string()))?, &root)?;
    let broker = host_access::HostAccess::start_with_approval(
        host_access::HostAccessConfig::new(format!("http://127.0.0.1:{}", ports.server), host_token, address,
            deployment::reference(&root, "agent-computer")?, vec![root.clone()]),
        std::sync::Arc::new(desktop_host_access::NativeApproval(app.clone())),
    ).map_err(|error| Problem::from(error.to_string()))?;
    *shell.host_access.lock().unwrap() = Some(broker);
    report(&app, "started", true, "API, app and worker started.");
    Ok(())
}

/// This dedicated command accepts no setting, value, root or policy from the webview.
/// Stop what this started, and only what this started.
///
/// A Bot's computer belongs to the supervisor rather than to Compose and is deliberately left
/// running: its files and browser profile are volumes, and killing it here would sign somebody out
/// of everything their Bot had logged into.
#[tauri::command]
async fn stop_stack<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    root: String,
) -> Result<(), String> {
    // Inventory, held-child cleanup and Compose all block. Keep the complete shutdown off both
    // Tauri's event loop and its async workers, and resolve IPC only when shutdown has finished.
    tauri::async_runtime::spawn_blocking(move || stop_everything(&app, &stack::root_from(&root)))
        .await
        .map_err(|error| format!("the shutdown did not run: {error}"))?
}

/// Take the whole stack down: the host processes, anything left over, and the containers.
///
/// One implementation, because there are three ways to ask for it (the button, the menu bar, and
/// quitting) and a person who used one of them and got a different amount of stopping would be
/// right to call that a bug.
fn stop_everything<R: tauri::Runtime>(app: &tauri::AppHandle<R>, fallback_root: &Path) -> Result<(), String> {
    let shell = app.state::<Shell>();
    let root = cleanup_root(&shell, fallback_root);
    let mut children = std::mem::take(&mut *shell.children.lock().unwrap());
    if children.is_empty() {
        stack::stop_processes_under(&root).map_err(|e| e.said)?;
    } else {
        for (_, child) in &mut children { let _ = child.kill(); let _ = child.wait(); }
        match std::fs::remove_file(stack::host_pids_path(&root)) { Ok(()) => {}, Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}, Err(e) => return Err(e.to_string()) }
    }
    shell.host_access.lock().unwrap().take();
    let status = engine::detect();
    let address = status.address.ok_or(status.detail)?;
    stack::down(&address, &root)?;
    *shell.root.lock().unwrap() = None;
    Ok(())
}

#[tauri::command]
async fn show_openbot<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<(), Problem> {
    tauri::async_runtime::spawn_blocking(move || {
        let ports = ports_for_shell(&app)?;
        show_openbot_on(app, &ports)
    })
    .await
    .map_err(|error| Problem::with("OpenBot could not open its window.", error.to_string()))?
}

fn ports_for_shell<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<openbot_env::Ports, Problem> {
    let root = cleanup_root(&app.state::<Shell>(), &stack::default_root());
    openbot_env::Ports::read(&root).map_err(|error| {
        Problem::with("OpenBot could not read its local ports.", error.to_string())
    })
}

fn show_openbot_on<R: tauri::Runtime>(app: tauri::AppHandle<R>, ports: &openbot_env::Ports) -> Result<(), Problem> {
    app.get_webview_window("main").ok_or("The OpenBot window is unavailable.")?.navigate(format!("http://127.0.0.1:{}", ports.app).parse().map_err(|e| Problem::from(format!("{e}")))?).map_err(|e| Problem::from(e.to_string()))
}

/// Resolve the configured setup page before WebView2's first navigation completes.
/// Tauri 2's App URL mapping uses devUrl in development and the platform app protocol for
/// bundled files. Keep this aligned with Tauri's get_app_url and prepare_webview mapping:
/// https://v2.tauri.app/reference/config/#webviewurl
fn configured_setup_url(
    config: &tauri::utils::config::Config,
    development: bool,
    windows: bool,
) -> Result<tauri::Url, String> {
    let window = config
        .app
        .windows
        .iter()
        .find(|window| window.label == "main")
        .ok_or("the OpenBot setup window is not configured")?;
    match &window.url {
        tauri::WebviewUrl::External(url) | tauri::WebviewUrl::CustomProtocol(url) => {
            Ok(url.clone())
        }
        tauri::WebviewUrl::App(path) => {
            let configured_base = if development {
                config.build.dev_url.as_ref()
            } else {
                match &config.build.frontend_dist {
                    Some(tauri::utils::config::FrontendDist::Url(url)) => Some(url),
                    _ => None,
                }
            };
            let base = match configured_base {
                Some(url) => url.clone(),
                None => {
                    let protocol = if windows {
                        if window.use_https_scheme {
                            "https://tauri.localhost/"
                        } else {
                            "http://tauri.localhost/"
                        }
                    } else {
                        "tauri://localhost/"
                    };
                    protocol
                        .parse()
                        .map_err(|error| format!("invalid setup URL: {error}"))?
                }
            };
            // Tauri omits the default document when creating the initial app URL.
            if path == Path::new("index.html") {
                Ok(base)
            } else {
                base.join(&path.to_string_lossy())
                    .map_err(|error| format!("invalid setup page path: {error}"))
            }
        }
        _ => Err("the OpenBot setup window URL is not supported".into()),
    }
}

fn remember_setup_url<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<(), String> {
    let setup = configured_setup_url(app.config(), tauri::is_dev(), cfg!(windows))?;
    *app.state::<Shell>().setup_url.lock().unwrap() = Some(setup.to_string());
    Ok(())
}

fn setup_destination<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<tauri::Url, String> {
    // Use the intended setup destination even before the initial page has finished loading.
    let setup = app.state::<Shell>().setup_url.lock().unwrap().clone();
    match setup {
        Some(setup) => setup
            .parse()
            .map_err(|error| format!("{setup} is not a URL: {error}")),
        None => configured_setup_url(app.config(), tauri::is_dev(), cfg!(windows)),
    }
}

/// Put the setup screen back, when there is something to set up again.
#[tauri::command]
fn show_setup<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or("the OpenBot window is not there")?;
    window
        .navigate(setup_destination(&app)?)
        .map_err(|error| format!("could not go back to setup: {error}"))
}

/// Both pages are single-page apps. Keep their route and in-memory state on restore.
/// Compare the authority explicitly: tauri:// has an opaque URL origin.
fn same_window_app(current: &tauri::Url, destination: &tauri::Url) -> bool {
    destination.host_str().is_some()
        && current.scheme() == destination.scheme()
        && current.host_str() == destination.host_str()
        && current.port_or_known_default() == destination.port_or_known_default()
}

fn show_setup_and_focus<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<(), String> {
    show_setup(app.clone())?;
    let window = app
        .get_webview_window("main")
        .ok_or("the OpenBot window is not there")?;
    window
        .show()
        .map_err(|error| format!("could not show setup: {error}"))?;
    window
        .unminimize()
        .map_err(|error| format!("could not unminimize setup: {error}"))?;
    window
        .set_focus()
        .map_err(|error| format!("could not focus setup: {error}"))
}

#[tauri::command]
fn already_running<R: tauri::Runtime>(app: tauri::AppHandle<R>, _root: String) -> bool {
    app.state::<Shell>().children.lock().unwrap().iter_mut().any(|(_, child)| matches!(child.try_wait(), Ok(None)))
}

/// What stopped the stack, if anything did, and forget it once it has been read.
///
/// Cleared on reading so a failure from an hour ago does not greet somebody who has since fixed it.
#[tauri::command]
fn last_failure<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Option<Problem> {
    app.state::<Shell>().last_failure.lock().unwrap().take()
}

#[tauri::command]
fn default_root() -> String {
    stack::default_root().to_string_lossy().into_owned()
}

#[tauri::command]
fn selected_root(app: tauri::AppHandle) -> Option<String> {
    app.state::<Shell>()
        .selected_root
        .lock()
        .unwrap()
        .as_ref()
        .map(|root| root.to_string_lossy().into_owned())
}

/**
What a previous run already wrote, so the wizard can arrive filled in.

Returned to the window because that is where the fields are, and it is the same machine and the
same person: reading their own file back to them is not a disclosure. The key is not logged here or
anywhere, and only the settings the wizard asks about are read.
*/
#[tauri::command]
fn already_configured<R: tauri::Runtime>(
    _app: tauri::AppHandle<R>,
    root: String,
) -> AlreadyConfigured {
    already_configured_for_root(root)
}

fn already_configured_for_root(root: String) -> AlreadyConfigured {
    let root = stack::root_from(&root);
    let env_file = root.join(".env");
    let mut values = openbot_desktop_lib::vault::already_given_file_only(
        &env_file,
        &[
            "INTELLIGENCE_API_KEY",
            "INTELLIGENCE_API_URL",
            "INTELLIGENCE_GATEWAY_WS_URL",
            /*
             * The model credentials too, so the wizard never asks twice for one of these either.
             *
             * A key already in the file is one somebody has already produced, and making them find
             * it again means opening a dotfile in an editor. Read back for the same reason the
             * Intelligence key is: it is their own file, on their own machine, and this is the
             * screen that asks for it.
             */
            "OPENAI_API_KEY",
            "ANTHROPIC_API_KEY",
            "OPENAI_BASE_URL",
            "OPENAI_CONTAINER_BASE_URL",
            "BOT_MODEL",
            "PICKED_HARNESS_NAME",
            "PICKED_HARNESS_SOURCE",
            "PICKED_HARNESS_URL",
            "CLAUDE_CODE_OAUTH_TOKEN",
        ],
    );

    use openbot_desktop_lib::saved_intent::{Category, SavedIntent};
    let intent = SavedIntent::read(&root);
    let hint = |category, file_present| {
        (file_present || intent.categories.contains(&category)).then_some(true)
    };
    let claude_plan = values.remove("CLAUDE_CODE_OAUTH_TOKEN").is_some();
    let harness = values.get("PICKED_HARNESS_NAME").and_then(|name| {
        harness::catalogue().into_iter().find(|row| &row.name == name).map(|row| harness::HarnessChoice {
            id: row.id,
            agent_url: values.get("PICKED_HARNESS_URL").cloned(),
        })
    });
    AlreadyConfigured {
        harness,
        saved: SavedConfiguration {
            intelligence_api_key: hint(
                Category::Intelligence,
                values.contains_key("INTELLIGENCE_API_KEY"),
            ),
            model_api_keys: SavedModelApiKeys {
                openai: hint(
                    Category::OpenAiApiKey,
                    values.contains_key("OPENAI_API_KEY"),
                ),
                anthropic: hint(
                    Category::AnthropicApiKey,
                    values.contains_key("ANTHROPIC_API_KEY"),
                ),
                compatible: hint(Category::CompatibleEndpointApiKey, false),
            },
            model_sessions: SavedModelSessions {
                openai: hint(
                    Category::ChatGptPlan,
                    openbot_env::saved_chatgpt_plan_store(&root),
                ),
                anthropic: hint(Category::ClaudePlan, claude_plan),
                google: hint(Category::GoogleOauth, false),
                xai: hint(Category::XaiOauth, false),
            },
            model: intent.model,
        },
        values,
    }
}

/// The harness picker's rows. Data, so the screen is a list and not twelve branches.
#[tauri::command]
fn harnesses() -> Vec<harness::Harness> {
    harness::catalogue()
}

/// Start a Claude plan sign-in and return the address a browser has to open.
///
/// Blocking work on a blocking thread: it starts a container and waits on its output, and doing
/// that on the UI thread is a window that stops repainting mid-setup.
#[tauri::command]
async fn begin_claude_sign_in(app: tauri::AppHandle, root: String) -> Result<String, Problem> {
    let root = stack::root_from(&root);
    remember_selected_root(&app.state::<Shell>(), &root);
    /*
     * The image is decided here, not by the window, and it is the Claude Agent SDK harness whatever
     * harness the person picked. It is not being used as a Bot: it is the container that happens to
     * carry Anthropic's bundled CLI, which is what does the OAuth. Letting the screen name an image
     * would make the sign-in depend on a choice that has nothing to do with it.
     */
    #[cfg(target_os = "linux")]
    let service_app = app.clone();
    let (signing, url) = tauri::async_runtime::spawn_blocking(move || {
        let (address, image) = prepared_sign_in(&root, openbot_desktop_lib::plan::SIGN_IN_IMAGE)?;
        #[cfg(target_os = "linux")]
        {
            let shell = service_app.state::<Shell>();
            ensure_linux_podman_api(&shell, &address)?;
        }
        openbot_desktop_lib::plan::SigningIn::begin(&address, &image).map_err(Problem::from)
    })
    .await
    .map_err(|error| {
        Problem::with(
            "The sign-in did not start. Try again.",
            format!("the sign-in task did not run: {error}"),
        )
    })??;
    *app.state::<Shell>().signing_in.lock().unwrap() = Some(signing);

    /*
     * Opened here rather than by the window, because the window would need the shell plugin's JS
     * half for the one call. The URL is returned as well, and the screen shows it: on Linux without
     * a registered browser, and in a session where the open silently does nothing, a link somebody
     * can copy is the difference between a stuck screen and a finished sign-in.
     */
    let _ = tauri_plugin_opener::OpenerExt::opener(&app).open_url(&url, None::<&str>);
    Ok(url)
}

/**
Redeem the code from the browser and return the plan token.

The token crosses to the window and comes back in the model choice, which is the same path a typed
key takes. It is never logged, and the failure messages never carry the command's output: see
`SigningIn::gave_up`.
*/
#[tauri::command]
async fn finish_claude_sign_in(app: tauri::AppHandle, code: String) -> Result<String, String> {
    // Taken, not borrowed. A sign-in is single-use, and leaving it in place would let a second
    // attempt write a code into a flow that has already finished.
    let signing = app
        .state::<Shell>()
        .signing_in
        .lock()
        .unwrap()
        .take()
        .ok_or_else(|| "That sign-in is no longer running. Start it again.".to_string())?;
    tauri::async_runtime::spawn_blocking(move || signing.finish(&code))
        .await
        .map_err(|error| format!("The sign-in did not finish: {error}"))?
}

/// Start a ChatGPT plan sign-in and return the address a browser has to open.
#[tauri::command]
async fn begin_chatgpt_sign_in(
    app: tauri::AppHandle,
    root: String,
) -> Result<String, openbot_desktop_lib::problem::Problem> {
    let root = stack::root_from(&root);
    remember_selected_root(&app.state::<Shell>(), &root);
    #[cfg(target_os = "linux")]
    let service_app = app.clone();
    let (signing, url) = tauri::async_runtime::spawn_blocking(move || {
        let (address, image) =
            prepared_sign_in(&root, openbot_desktop_lib::plan::CHATGPT_SIGN_IN_IMAGE)?;
        #[cfg(target_os = "linux")]
        {
            let shell = service_app.state::<Shell>();
            ensure_linux_podman_api(&shell, &address)?;
        }
        openbot_desktop_lib::plan::SigningInToChatGpt::begin(&address, &image)
    })
    .await
    .map_err(|error| {
        Problem::with(
            "The sign-in did not start. Try again.",
            format!("the sign-in task did not run: {error}"),
        )
    })??;
    *app.state::<Shell>().signing_in_to_chatgpt.lock().unwrap() = Some(signing);
    let _ = tauri_plugin_opener::OpenerExt::opener(&app).open_url(&url, None::<&str>);
    Ok(url)
}

/**
Wait for the ChatGPT redirect to land, and return the plan token.

Nothing is sent: the browser's callback is what finishes it. So this is a wait rather than a
redemption, which is why there is no code field on that half of the screen.
*/
#[tauri::command]
async fn finish_chatgpt_sign_in(app: tauri::AppHandle) -> Result<String, String> {
    let signing = app
        .state::<Shell>()
        .signing_in_to_chatgpt
        .lock()
        .unwrap()
        .take()
        .ok_or_else(|| "That sign-in is no longer running. Start it again.".to_string())?;
    tauri::async_runtime::spawn_blocking(move || signing.finish())
        .await
        .map_err(|error| format!("The sign-in did not finish: {error}"))?
}

/// A self-hosted server authenticates in its own browser session. Only the selected project's
/// runtime key crosses into the window; the helper owns and then closes the temporary browser.
#[tauri::command]
async fn begin_self_hosted_intelligence_sign_in(
    app: tauri::AppHandle,
    root: String,
    api_url: String,
) -> Result<Vec<openbot_desktop_lib::intelligence::Project>, Problem> {
    let root = stack::root_from(&root);
    let shell = app.state::<Shell>();
    remember_selected_root(&shell, &root);
    cancel_self_hosted_sign_in(&shell);
    tauri::async_runtime::spawn_blocking(move || {
        let bun = install::ensure_bun(&root, which_bun())?;
        let signing = openbot_desktop_lib::self_hosted_intelligence::SigningIn::begin(&root, &bun, &api_url)?;
        *app.state::<Shell>().self_hosted_intelligence.lock().unwrap() = Some(signing.clone());
        let result = signing.projects();
        if result.is_err() {
            app.state::<Shell>().self_hosted_intelligence.lock().unwrap().take();
            signing.cancel();
        }
        result
    })
    .await
    .map_err(|_| Problem::plain("Intelligence sign-in could not finish."))?
}

#[tauri::command]
async fn finish_self_hosted_intelligence_sign_in(
    app: tauri::AppHandle,
    root: String,
    project: String,
) -> Result<String, Problem> {
    let _root = stack::root_from(&root);
    let signing = app
        .state::<Shell>()
        .self_hosted_intelligence
        .lock()
        .unwrap()
        .take()
        .ok_or_else(|| Problem::plain("Sign in to this Intelligence server first."))?;
    tauri::async_runtime::spawn_blocking(move || {
        let result = signing.connect(&project);
        let provisioned = match result {
            Ok(provisioned) => provisioned,
            Err(problem) => {
                signing.cancel();
                return Err(problem);
            }
        };
        let key = provisioned.api_key.clone();
        Ok(key)
    })
    .await
    .map_err(|_| Problem::plain("Intelligence sign-in could not finish."))?
}

#[tauri::command]
async fn cancel_self_hosted_intelligence_sign_in(app: tauri::AppHandle) -> Result<(), Problem> {
    tauri::async_runtime::spawn_blocking(move || cancel_self_hosted_sign_in(&app.state::<Shell>()))
        .await
        .map_err(|_| Problem::plain("The Intelligence sign-in could not be closed."))
}

/// Start signing in to Intelligence and return the address a browser has to open.
#[tauri::command]
async fn begin_intelligence_sign_in(app: tauri::AppHandle) -> Result<String, String> {
    let (signing, url) = openbot_desktop_lib::intelligence::SigningInToIntelligence::begin()?;
    *app.state::<Shell>()
        .signing_in_to_intelligence
        .lock()
        .unwrap() = Some(signing);
    let _ = tauri_plugin_opener::OpenerExt::opener(&app).open_url(&url, None::<&str>);
    Ok(url)
}

/// Wait for that sign-in, and answer with the projects it can see.
///
/// The credential is kept on this side rather than handed to the window: the window's business is
/// which project, and a credential it never holds is one it cannot leak into a log or a screenshot.
#[tauri::command]
async fn finish_intelligence_sign_in(
    app: tauri::AppHandle,
) -> Result<Vec<openbot_desktop_lib::intelligence::Project>, openbot_desktop_lib::problem::Problem>
{
    let signing = app
        .state::<Shell>()
        .signing_in_to_intelligence
        .lock()
        .unwrap()
        .take()
        .ok_or_else(|| {
            openbot_desktop_lib::problem::Problem::plain(
                "That sign-in is no longer running. Start it again.",
            )
        })?;
    let (credential, projects) = tauri::async_runtime::spawn_blocking(move || signing.finish())
        .await
        .map_err(|error| {
            openbot_desktop_lib::problem::Problem::plain(format!(
                "The sign-in did not finish: {error}"
            ))
        })??;
    *app.state::<Shell>().intelligence_credential.lock().unwrap() = Some(credential);
    Ok(projects)
}

/// Create a project using the account already signed in, without exposing its credential to the UI.
#[tauri::command]
async fn create_intelligence_project(
    app: tauri::AppHandle,
    name: String,
) -> Result<openbot_desktop_lib::intelligence::Project, Problem> {
    let credential = app
        .state::<Shell>()
        .intelligence_credential
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| Problem::plain("Sign in to CopilotKit first."))?;
    tauri::async_runtime::spawn_blocking(move || {
        openbot_desktop_lib::intelligence::create_project(&credential, &name)
    })
    .await
    .map_err(|error| Problem::with("Your project could not be created.", error.to_string()))?
}

/// Create a key for the project somebody chose, and hand it back for the field.
#[tauri::command]
async fn intelligence_key_for(
    app: tauri::AppHandle,
    project: String,
) -> Result<String, openbot_desktop_lib::problem::Problem> {
    let credential = app
        .state::<Shell>()
        .intelligence_credential
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| {
            openbot_desktop_lib::problem::Problem::plain("Sign in to CopilotKit first.")
        })?;
    let provisioned = tauri::async_runtime::spawn_blocking(move || {
        openbot_desktop_lib::intelligence::provision_connection(&credential, &project)
    })
    .await
    .map_err(|error| {
        openbot_desktop_lib::problem::Problem::plain(format!("A key could not be created: {error}"))
    })??;
    let key = provisioned.api_key.clone();
    Ok(key)
}

/// The model screen's rows. Independent of the picker above, and required to stay that way: no
/// harness on that list is tied to a vendor's models, so choosing one may not narrow this.
#[tauri::command]
fn providers() -> Vec<provider::Provider> {
    provider::catalogue()
}

#[tauri::command]
async fn begin_model_oauth(
    root: String,
    provider: String,
) -> Result<openbot_desktop_lib::provider_oauth::Authorization, String> {
    tauri::async_runtime::spawn_blocking(move || {
        openbot_desktop_lib::provider_oauth::begin(&stack::root_from(&root), &provider)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn finish_model_oauth(attempt_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        openbot_desktop_lib::provider_oauth::finish(&attempt_id)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn cancel_model_oauth(attempt_id: String) {
    openbot_desktop_lib::provider_oauth::cancel(&attempt_id);
}

/// `bun` from PATH, or the places an installer puts it when PATH has not been reloaded.
fn which_bun() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("PATH").and_then(|path| {
        std::env::split_paths(&path)
            .map(|directory| directory.join(if cfg!(windows) { "bun.exe" } else { "bun" }))
            .find(|path| path.is_file())
    }) { return Some(path); }
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()?;
    let candidates = [
        PathBuf::from(&home).join(".bun/bin/bun"),
        PathBuf::from(&home).join(".bun/bin/bun.exe"),
    ];
    candidates.into_iter().find(|path| path.exists())
}

/// Point the window at OpenBot if it is up, and at the setup screen if it is not.
///
/// Used by the tray and by a second launch, both of which happen at moments when the caller has no
/// idea which of the two the person should be looking at.
fn show_whichever_applies(app: &tauri::AppHandle) {
    match ports_for_shell(app) {
        Ok(ports) => restore_window_on(app, &ports),
        Err(problem) => {
            *app.state::<Shell>().last_failure.lock().unwrap() = Some(problem);
            if let Err(error) = show_setup_and_focus(app.clone()) {
                eprintln!("{error}");
            }
        }
    }
}

fn restore_window_on<R: tauri::Runtime>(app: &tauri::AppHandle<R>, ports: &openbot_env::Ports) {
    if app.state::<Shell>().root.lock().unwrap().is_some() { let _ = show_openbot_on(app.clone(), ports); }
    else { let _ = show_setup(app.clone()); }
    if let Some(window) = app.get_webview_window("main") { let _ = window.show(); let _ = window.unminimize(); let _ = window.set_focus(); }
}

fn schedule_second_instance_restore<T, F>(
    context: T,
    restore: F,
) -> std::io::Result<std::thread::JoinHandle<()>>
where
    T: Send + 'static,
    F: FnOnce(T) + Send + 'static,
{
    std::thread::Builder::new()
        .name("openbot-second-instance-restore".into())
        .spawn(move || restore(context))
}

fn restore_after_second_instance(app: &tauri::AppHandle) {
    let app = app.clone();
    let reporting_app = app.clone();
    if let Err(error) = schedule_second_instance_restore(app, |app| {
        show_whichever_applies(&app);
    }) {
        eprintln!("[single-instance] restore scheduling failed: {error}");
        report(
            &reporting_app,
            "open",
            false,
            format!("OpenBot could not show the existing window: {error}"),
        );
    }
}

fn stop_from_menu<R: tauri::Runtime>(app: tauri::AppHandle<R>) {
    std::thread::spawn(move || {
        if let Err(error) = stop_everything(&app, &stack::default_root()) { *app.state::<Shell>().last_failure.lock().unwrap() = Some(Problem::plain(error)); }
        let _ = show_setup(app);
    });
}

/// What each of the three items does, wherever it was chosen from.
///
/// The tray and the window menu carry the same items, so they share one function: two copies would
/// be two chances for Stop to mean something different depending on where somebody clicked.
fn chose(app: &tauri::AppHandle, item: &str) {
    match item {
        "open" => show_whichever_applies(app),
        // Stop without quitting: the stack is what costs something to leave running, and somebody
        // who wants it stopped does not necessarily want the application gone.
        "stop" => stop_from_menu(app.clone()),
        // Exit rather than hide: quitting is a decision to stop, and the exit handler is what stops
        // the processes with it.
        "quit" => {
            app.exit(0);
        }
        _ => {}
    }
}

fn quit_menu_accelerator() -> Option<&'static str> {
    Some(QUIT_MENU_ACCELERATOR)
}

fn main() {
    tauri::Builder::default()
        // A second launch is somebody looking for the window they already have, not a request for a
        // second stack. Without this both copies bind the same ports and the loser reports a
        // failure that belongs to the winner.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            restore_after_second_instance(app);
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Shell::default())
        .invoke_handler(tauri::generate_handler![
            record_setup_event,
            detect_engine,
            windows_blocker,
            windows_blocker_instruction,
            prepare_engine,
            prepare_installation,
            start_stack,
            stop_stack,
            show_openbot,
            show_setup,
            already_running,
            last_failure,
            default_root,
            selected_root,
            harnesses,
            providers,
            already_configured,
            begin_claude_sign_in,
            finish_claude_sign_in,
            begin_chatgpt_sign_in,
            begin_model_oauth,
            finish_model_oauth,
            cancel_model_oauth,
            finish_chatgpt_sign_in,
            begin_self_hosted_intelligence_sign_in,
            finish_self_hosted_intelligence_sign_in,
            cancel_self_hosted_intelligence_sign_in,
            begin_intelligence_sign_in,
            finish_intelligence_sign_in,
            intelligence_key_for,
            create_intelligence_project,
        ])
        // A packaged application is not a browser tab. Left alone, WebView2 answers a right-click
        // with Back, Refresh, Save as and Print: Back walks the window out of OpenBot with nothing
        // to walk it home, and Save as offers to write the page to disk as `Webpage, complete`.
        // macOS never showed this because Tauri suppresses it there in release builds; Windows has
        // no such setting, and Tauri has no configuration option for it either, so the page is
        // asked to refuse. Every navigation, because the window navigates to OpenBot and back.
        .on_page_load(|window, _| {
            let _ = window
                .eval("document.addEventListener('contextmenu', e => e.preventDefault(), true)");
        })
        // Closing the window hides it. A tray application whose window is destroyed on close has a
        // menu item that points at nothing: `get_webview_window` returns None from then on, and the
        // only way back is to quit and start again, with a stack still running that nothing on
        // screen can reach.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .setup(|app| {
            desktop_telemetry::initialize(app.handle());
            if let Some(root) = app
                .path()
                .app_config_dir()
                .ok()
                .and_then(|config| preparation::selected_root(&config))
            {
                remember_selected_root(&app.state::<Shell>(), &root);
            }
            // Where the Compose provider OpenBot installs itself lives, told once so every engine
            // command can put it on the child's PATH. Before anything asks for an engine.
            engine::tools_live_in(engine::tools_dir_under(&acquire::download_dir(
                &stack::default_root(),
            )));

            remember_setup_url(app.handle())?;

            // The status menu lets somebody open the window, stop the stack, or quit the app.
            use tauri::menu::{Menu, MenuItem};
            use tauri::tray::TrayIconBuilder;

            let open = MenuItem::with_id(app, "open", "Open OpenBot", true, None::<&str>)?;
            let stop = MenuItem::with_id(app, "stop", "Stop OpenBot", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, quit_menu_accelerator())?;
            let menu = Menu::with_items(app, &[&open, &stop, &quit])?;

            TrayIconBuilder::with_id("openbot")
                .icon(tray::icon())
                .icon_as_template(false)
                .tooltip("OpenBot")
                .menu(&menu)
                .build(app)?;

            // The same three items on the window itself, because the tray cannot be relied on and
            // Stop lives nowhere else.
            //
            // Linux needs a tray host to draw the icon, and Windows can place it in overflow.
            // The tray library restores the Windows icon after Explorer restarts, but the window
            // menu still provides access when the tray is unavailable or hard to find.
            // Its own items, not the tray's: a menu item belongs to one menu, and the two menus
            // outlive each other. The ids match so both arrive at the same function.
            use tauri::menu::Submenu;
            let window_open = MenuItem::with_id(app, "open", "Open OpenBot", true, None::<&str>)?;
            let window_stop = MenuItem::with_id(app, "stop", "Stop OpenBot", true, None::<&str>)?;
            let window_quit =
                MenuItem::with_id(app, "quit", "Quit", true, quit_menu_accelerator())?;
            // A submenu, because a top-level entry in a menu bar has to be one to open at all.
            let openbot = Submenu::with_items(
                app,
                "OpenBot",
                true,
                &[&window_open, &window_stop, &window_quit],
            )?;
            /*
             * AN EDIT MENU, WITHOUT WHICH COMMAND-V DOES NOTHING.
             *
             * MEASURED, on the screen that asks for a paste. macOS routes the clipboard shortcuts
             * through the menu bar, so a window with no Edit menu has no Paste, and a webview text
             * field silently ignores the keystroke. Typing worked and pasting did not, on the one
             * screen whose own instruction is "paste the code it shows you". Every person signing
             * in to a Claude plan would have reached that field, pressed the shortcut everybody
             * knows, and had nothing happen.
             *
             * Predefined items rather than our own: these carry the standard shortcuts and the
             * standard behaviour, which is the whole point of them being where a person expects.
             */
            use tauri::menu::PredefinedMenuItem;
            let edit = Submenu::with_items(
                app,
                "Edit",
                true,
                &[
                    &PredefinedMenuItem::undo(app, None)?,
                    &PredefinedMenuItem::redo(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::cut(app, None)?,
                    &PredefinedMenuItem::copy(app, None)?,
                    &PredefinedMenuItem::paste(app, None)?,
                    &PredefinedMenuItem::select_all(app, None)?,
                ],
            )?;
            app.set_menu(Menu::with_items(app, &[&openbot, &edit])?)?;
            app.on_menu_event(|app, event| chose(app, event.id().as_ref()));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("the OpenBot window could not be created")
        .run(|app, event| {
            match event {
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Reopen { .. } => {
                    show_whichever_applies(app);
                }
                tauri::RunEvent::ExitRequested { .. } => {
                    desktop_telemetry::shutdown(app);
                    if let Err(error) = stop_everything(app, &stack::default_root()) { eprintln!("{error}"); }
                }
                _ => {}
            }
        });
}
