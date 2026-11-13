use rand::RngCore;
use reqwest::blocking::Client;
use reqwest::redirect::Policy;
use serde::{Deserialize, Serialize};
use std::env;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread::sleep;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const STATE_SCHEMA_VERSION: u8 = 1;
const STATE_FILE: &str = "telemetry-state.json";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(3);
const FLUSH_BUDGET: Duration = Duration::from_secs(6);

pub type Result<T> = std::result::Result<T, TelemetryError>;

#[derive(Debug)]
pub enum TelemetryError {
    Io(io::Error),
    Json(serde_json::Error),
    Http(reqwest::Error),
    MissingEndpoint,
    InvalidState(String),
    Poisoned,
}

impl From<io::Error> for TelemetryError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<serde_json::Error> for TelemetryError {
    fn from(error: serde_json::Error) -> Self {
        Self::Json(error)
    }
}

impl From<reqwest::Error> for TelemetryError {
    fn from(error: reqwest::Error) -> Self {
        Self::Http(error)
    }
}

impl std::fmt::Display for TelemetryError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "telemetry I/O error: {error}"),
            Self::Json(error) => write!(formatter, "telemetry JSON error: {error}"),
            Self::Http(error) => write!(formatter, "telemetry HTTP error: {error}"),
            Self::MissingEndpoint => formatter.write_str("telemetry endpoint is missing"),
            Self::InvalidState(error) => write!(formatter, "invalid telemetry state: {error}"),
            Self::Poisoned => formatter.write_str("telemetry state lock is poisoned"),
        }
    }
}

impl std::error::Error for TelemetryError {}

#[derive(Debug, Clone)]
pub struct Config {
    pub enabled: bool,
    pub endpoint: Option<String>,
    pub max_queue: usize,
}

impl Config {
    pub fn disabled_for_tests() -> Self {
        Self {
            enabled: true,
            endpoint: None,
            max_queue: 256,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnvOverride {
    Process,
    Enabled,
    Disabled,
}

#[derive(Debug)]
pub struct Telemetry {
    state_path: PathBuf,
    context: Mutex<Context>,
    config: Config,
    state: Mutex<Option<PersistedState>>,
    session_last_step_viewed: Mutex<Option<Step>>,
    flush_lock: Mutex<()>,
    client: Client,
}

impl Telemetry {
    pub fn open(data_dir: impl AsRef<Path>, context: Context, config: Config) -> Result<Arc<Self>> {
        Self::open_with_env(data_dir, context, config, EnvOverride::Process)
    }

    pub fn open_with_env(
        data_dir: impl AsRef<Path>,
        context: Context,
        config: Config,
        env_override: EnvOverride,
    ) -> Result<Arc<Self>> {
        let state_path = state_path(data_dir.as_ref());
        if telemetry_disabled(env_override) || !config.enabled {
            let _ = fs::remove_file(&state_path);
            return Ok(Arc::new(Self::disabled(state_path, context, config)?));
        }

        fs::create_dir_all(data_dir.as_ref())?;
        let mut state = if state_path.exists() {
            let state = serde_json::from_slice::<PersistedState>(&fs::read(&state_path)?)?;
            state.validate()?;
            state
        } else {
            PersistedState::new(new_uuid())
        };

        if !state.activated {
            if let Some(step) = state.last_step.take() {
                state.push_bounded(
                    Event::new(EventData::SetupAbandoned { step }, context.clone()),
                    normalized_max_queue(config.max_queue),
                );
            }
        }
        write_state(&state_path, &state)?;

        Ok(Arc::new(Self {
            state_path,
            context: Mutex::new(context),
            config,
            state: Mutex::new(Some(state)),
            session_last_step_viewed: Mutex::new(None),
            flush_lock: Mutex::new(()),
            client: client()?,
        }))
    }

    fn disabled(state_path: PathBuf, context: Context, config: Config) -> Result<Self> {
        Ok(Self {
            state_path,
            context: Mutex::new(context),
            config,
            state: Mutex::new(None),
            session_last_step_viewed: Mutex::new(None),
            flush_lock: Mutex::new(()),
            client: client()?,
        })
    }

    pub fn install_id(&self) -> Option<String> {
        self.state
            .lock()
            .ok()
            .and_then(|guard| guard.as_ref().map(|state| state.install_id.clone()))
    }

    pub fn update_engine(&self, engine: Engine) -> Result<()> {
        let mut context = self.context.lock().map_err(|_| TelemetryError::Poisoned)?;
        context.engine = engine;
        Ok(())
    }

    /// The exact process environment the desktop gives to Bun before runtime imports.
    pub fn runtime_env(&self) -> std::collections::BTreeMap<String, String> {
        let mut env = std::collections::BTreeMap::new();
        let Some(id) = self.install_id() else {
            env.insert("COPILOTKIT_TELEMETRY_DISABLED".into(), "1".into());
            return env;
        };
        let Ok(context) = self.context.lock() else {
            return env;
        };
        env.insert("CPK_TELEMETRY_ID".into(), id);
        env.insert("COPILOTKIT_TELEMETRY_SAMPLE_RATE".into(), "1".into());
        env.insert(
            "OPENBOT_DISTRIBUTION".into(),
            context.distribution.as_str().into(),
        );
        env.insert("OPENBOT_VERSION".into(), context.app_version.to_string());
        env.insert("OPENBOT_PLATFORM".into(), context.platform.as_str().into());
        env.insert("OPENBOT_ARCH".into(), context.arch.as_str().into());
        env.insert("OPENBOT_ENGINE".into(), context.engine.as_str().into());
        if let Some(version) = &context.os_version {
            env.insert("OPENBOT_OS_VERSION".into(), version.to_string());
        }
        env
    }

    pub fn record(&self, data: EventData) -> Result<()> {
        let context = self
            .context
            .lock()
            .map_err(|_| TelemetryError::Poisoned)?
            .clone();
        let mut guard = self.state.lock().map_err(|_| TelemetryError::Poisoned)?;
        let Some(state) = guard.as_mut() else {
            return Ok(());
        };

        match &data {
            EventData::StepViewed { step } => {
                let mut last_step = self
                    .session_last_step_viewed
                    .lock()
                    .map_err(|_| TelemetryError::Poisoned)?;
                if *last_step == Some(*step) {
                    return Ok(());
                }
                *last_step = Some(*step);
                state.last_step = Some(*step);
            }
            EventData::Activated => {
                if state.activated {
                    return Ok(());
                }
                state.activated = true;
                state.last_step = None;
                *self
                    .session_last_step_viewed
                    .lock()
                    .map_err(|_| TelemetryError::Poisoned)? = None;
            }
            EventData::SetupAbandoned { .. } => {
                if state.activated {
                    return Ok(());
                }
                state.last_step = None;
                *self
                    .session_last_step_viewed
                    .lock()
                    .map_err(|_| TelemetryError::Poisoned)? = None;
            }
            _ => {
                *self
                    .session_last_step_viewed
                    .lock()
                    .map_err(|_| TelemetryError::Poisoned)? = None;
            }
        }

        state.push_bounded(
            Event::new(data, context),
            normalized_max_queue(self.config.max_queue),
        );
        write_state(&self.state_path, state)
    }

    pub fn flush(&self) -> Result<()> {
        self.flush_with_lock_wait(Duration::ZERO)
    }

    fn flush_with_lock_wait(&self, lock_wait: Duration) -> Result<()> {
        let started = Instant::now();
        let flush_guard = loop {
            match self.flush_lock.try_lock() {
                Ok(guard) => break guard,
                Err(_) if started.elapsed() < lock_wait => sleep(Duration::from_millis(10)),
                Err(_) => return Ok(()),
            }
        };
        let _flush_guard = flush_guard;
        let endpoint = match self.config.endpoint.as_ref() {
            Some(endpoint) if !endpoint.trim().is_empty() => endpoint,
            _ => return Ok(()),
        };

        loop {
            if started.elapsed() >= FLUSH_BUDGET {
                return Ok(());
            }
            let (install_id, event) = {
                let guard = self.state.lock().map_err(|_| TelemetryError::Poisoned)?;
                let Some(state) = guard.as_ref() else {
                    return Ok(());
                };
                let Some(event) = state.queue.first().cloned() else {
                    return Ok(());
                };
                (state.install_id.clone(), event)
            };

            let response = self
                .client
                .post(endpoint)
                .header("X-CopilotKit-Telemetry-Id", &install_id)
                .json(&event.to_sink_payload())
                .send();
            match response {
                Ok(response) if response.status().is_success() => {
                    let mut guard = self.state.lock().map_err(|_| TelemetryError::Poisoned)?;
                    if let Some(state) = guard.as_mut() {
                        if let Some(index) = state
                            .queue
                            .iter()
                            .position(|queued| queued.event_id == event.event_id)
                        {
                            state.queue.remove(index);
                            write_state(&self.state_path, state)?;
                        }
                    }
                }
                Ok(_) => return Ok(()),
                Err(error) => return Err(TelemetryError::Http(error)),
            }
        }
    }

    pub fn shutdown(&self) -> Result<()> {
        let step = {
            let guard = self.state.lock().map_err(|_| TelemetryError::Poisoned)?;
            guard
                .as_ref()
                .and_then(|state| (!state.activated).then_some(state.last_step).flatten())
        };
        if let Some(step) = step {
            self.record(EventData::SetupAbandoned { step })?;
        }
        self.flush_with_lock_wait(FLUSH_BUDGET)
    }

    pub fn snapshot(&self) -> Result<PersistedState> {
        self.state
            .lock()
            .map_err(|_| TelemetryError::Poisoned)?
            .clone()
            .ok_or(TelemetryError::MissingEndpoint)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SinkPayload {
    pub event: String,
    pub event_id: String,
    pub properties: serde_json::Value,
    pub global_properties: serde_json::Value,
    pub package: SinkPackage,
    pub ts: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SinkPackage {
    pub name: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Context {
    #[serde(rename = "openbot_distribution")]
    pub distribution: Distribution,
    #[serde(rename = "openbot_version")]
    pub app_version: NumericVersion,
    #[serde(rename = "openbot_platform")]
    pub platform: Platform,
    #[serde(rename = "openbot_arch")]
    pub arch: Architecture,
    #[serde(rename = "openbot_os_version", skip_serializing_if = "Option::is_none")]
    pub os_version: Option<NumericVersion>,
    #[serde(rename = "openbot_engine")]
    pub engine: Engine,
    pub runtime_env: RuntimeEnv,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NumericVersion {
    pub parts: Vec<u32>,
}

impl NumericVersion {
    pub fn new(parts: Vec<u32>) -> Result<Self> {
        if (2..=4).contains(&parts.len()) {
            Ok(Self { parts })
        } else {
            Err(TelemetryError::InvalidState(
                "numeric version must have 2 to 4 dot-separated numeric parts".to_string(),
            ))
        }
    }

    pub fn parse(value: &str) -> Result<Self> {
        if value.len() > 32 {
            return Err(TelemetryError::InvalidState(
                "numeric version is too long".to_string(),
            ));
        }
        let parts = value
            .split('.')
            .map(|part| {
                if part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()) {
                    return Err(TelemetryError::InvalidState(format!(
                        "numeric version contains a non-numeric part: {value}"
                    )));
                }
                part.parse::<u32>().map_err(|_| {
                    TelemetryError::InvalidState(format!(
                        "numeric version part is too large: {value}"
                    ))
                })
            })
            .collect::<Result<Vec<_>>>()?;
        Self::new(parts)
    }
}

impl std::fmt::Display for NumericVersion {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        for (index, part) in self.parts.iter().enumerate() {
            if index > 0 {
                formatter.write_str(".")?;
            }
            write!(formatter, "{part}")?;
        }
        Ok(())
    }
}

impl Serialize for NumericVersion {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

impl<'de> Deserialize<'de> for NumericVersion {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::parse(&value).map_err(serde::de::Error::custom)
    }
}

impl Context {
    fn to_global_properties(&self) -> serde_json::Value {
        let mut properties = serde_json::json!({
            "openbot_distribution": self.distribution,
            "openbot_version": &self.app_version,
            "openbot_platform": self.platform,
            "openbot_arch": self.arch,
            "openbot_engine": self.engine,
            "runtime_env": self.runtime_env,
            "sampleRate": 1,
            "sampleWeight": 1,
            "sampleRateAdjustmentFactor": 0
        });
        if let Some(os_version) = &self.os_version {
            properties["openbot_os_version"] =
                serde_json::to_value(os_version).unwrap_or(serde_json::Value::Null);
        }
        properties
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PersistedState {
    pub schema_version: u8,
    pub install_id: String,
    pub activated: bool,
    pub last_step: Option<Step>,
    pub queue: Vec<Event>,
}

impl PersistedState {
    fn new(install_id: String) -> Self {
        Self {
            schema_version: STATE_SCHEMA_VERSION,
            install_id,
            activated: false,
            last_step: None,
            queue: Vec::new(),
        }
    }

    fn push_bounded(&mut self, event: Event, max_queue: usize) {
        self.queue.push(event);
        while self.queue.len() > max_queue {
            self.queue.remove(0);
        }
    }

    fn validate(&self) -> Result<()> {
        if self.schema_version != STATE_SCHEMA_VERSION {
            return Err(TelemetryError::InvalidState(format!(
                "unsupported telemetry state schema {}",
                self.schema_version
            )));
        }
        if !is_uuid(&self.install_id) {
            return Err(TelemetryError::InvalidState(
                "install_id is not a UUID".to_string(),
            ));
        }
        for event in &self.queue {
            event.validate()?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Event {
    pub event_id: String,
    pub occurred_at_ms: u64,
    pub event_name: String,
    pub context: Context,
    pub data: EventData,
}

impl Event {
    pub fn new(data: EventData, context: Context) -> Self {
        let event_name = data.event_name().to_string();
        Self {
            event_id: new_uuid(),
            occurred_at_ms: now_ms(),
            event_name,
            context,
            data,
        }
    }

    pub fn event_name(&self) -> &str {
        &self.event_name
    }

    fn validate(&self) -> Result<()> {
        if !is_uuid(&self.event_id) {
            return Err(TelemetryError::InvalidState(
                "event_id is not a UUID".to_string(),
            ));
        }
        if self.event_name != self.data.event_name() {
            return Err(TelemetryError::InvalidState(format!(
                "event_name {} does not match {:?}",
                self.event_name, self.data
            )));
        }
        Ok(())
    }

    fn to_sink_payload(&self) -> SinkPayload {
        SinkPayload {
            event: self.event_name.clone(),
            event_id: self.event_id.clone(),
            properties: serde_json::to_value(&self.data).unwrap_or_else(|_| serde_json::json!({})),
            global_properties: self.context.to_global_properties(),
            package: SinkPackage {
                name: "openbot-desktop".to_string(),
                version: self.context.app_version.to_string(),
            },
            ts: self.occurred_at_ms / 1000,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum EventData {
    StepViewed {
        step: Step,
    },
    HarnessChosen {
        harness: Harness,
    },
    ModelChosen {
        provider: Provider,
        credential_path: CredentialPath,
        custom_base_url: bool,
    },
    EngineDetected {
        engine: Engine,
    },
    EngineInstalled {
        engine: Engine,
        outcome: EngineInstallOutcome,
    },
    WindowsStage {
        outcome: WindowsStageOutcome,
    },
    ImagePull {
        outcome: Outcome,
        duration_ms: u64,
        bytes: Option<u64>,
    },
    SetupFailed {
        step: Step,
        error_class: SetupErrorClass,
    },
    Activated,
    SetupAbandoned {
        step: Step,
    },
}

impl EventData {
    pub fn event_name(&self) -> &'static str {
        match self {
            Self::StepViewed { .. } => "oss.desktop.step_viewed",
            Self::HarnessChosen { .. } => "oss.desktop.harness_chosen",
            Self::ModelChosen { .. } => "oss.desktop.model_chosen",
            Self::EngineDetected { .. } => "oss.desktop.engine_detected",
            Self::EngineInstalled { .. } => "oss.desktop.engine_installed",
            Self::WindowsStage { .. } => "oss.desktop.windows_stage",
            Self::ImagePull { .. } => "oss.desktop.image_pull",
            Self::SetupFailed { .. } => "oss.desktop.setup_failed",
            Self::Activated => "oss.desktop.activated",
            Self::SetupAbandoned { .. } => "oss.desktop.setup_abandoned",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Distribution {
    Desktop,
}

impl Distribution {
    fn as_str(self) -> &'static str {
        "desktop"
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeEnv {
    Development,
    Production,
    Test,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Platform {
    Windows,
    Macos,
    Linux,
    Other,
}

impl Platform {
    fn as_str(self) -> &'static str {
        match self {
            Self::Windows => "windows",
            Self::Macos => "macos",
            Self::Linux => "linux",
            Self::Other => "other",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Architecture {
    X86_64,
    Aarch64,
    Other,
}

impl Architecture {
    fn as_str(self) -> &'static str {
        match self {
            Self::X86_64 => "x86_64",
            Self::Aarch64 => "aarch64",
            Self::Other => "other",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Step {
    Welcome,
    Harness,
    Install,
    Model,
    Connect,
    Ask,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Harness {
    Crewai,
    Llamaindex,
    Agno,
    Langgraph,
    GoogleAdk,
    PydanticAi,
    MicrosoftAgentFramework,
    ClaudeAgentSdk,
    Strands,
    Ag2,
    Langroid,
    Mastra,
    ByoUrl,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Provider {
    Openai,
    Anthropic,
    Compatible,
    None,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CredentialPath {
    Subscription,
    ApiKey,
    None,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Engine {
    Docker,
    Podman,
    None,
}

impl Engine {
    fn as_str(self) -> &'static str {
        match self {
            Self::Docker => "docker",
            Self::Podman => "podman",
            Self::None => "none",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EngineInstallOutcome {
    Success,
    Failure,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WindowsStageOutcome {
    Ready,
    WslAbsent,
    WslOne,
    WslNoKernel,
    VirtualMachinePlatformDisabled,
    VirtualizationDisabled,
    NotAdministrator,
    CheckFailed,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Success,
    Failure,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SetupErrorClass {
    EngineUnavailable,
    EngineInstallFailed,
    ImagePullFailed,
    InvalidConfiguration,
    NetworkUnavailable,
    PermissionDenied,
    Unknown,
}

pub fn schema_json() -> serde_json::Value {
    serde_json::json!({
        "schema_version": STATE_SCHEMA_VERSION,
        "event_name_prefix": "oss.desktop.",
        "numeric_version_pattern": r"^\d+(?:\.\d+){1,3}$",
        "context": {
            "openbot_distribution": ["desktop"],
            "openbot_version": { "pattern": r"^\d+(?:\.\d+){1,3}$" },
            "openbot_platform": ["windows", "macos", "linux", "other"],
            "openbot_arch": ["x86_64", "aarch64", "other"],
            "openbot_os_version": { "optional": true, "pattern": r"^\d+(?:\.\d+){1,3}$" },
            "openbot_engine": ["docker", "podman", "none"],
            "runtime_env": ["development", "production", "test"]
        },
        "events": {
            "step_viewed": { "step": ["welcome", "harness", "install", "model", "connect", "ask"] },
            "harness_chosen": { "harness": ["crewai", "llamaindex", "agno", "langgraph", "google_adk", "pydantic_ai", "microsoft_agent_framework", "claude_agent_sdk", "strands", "ag2", "langroid", "mastra", "byo_url"] },
            "model_chosen": { "provider": ["openai", "anthropic", "compatible", "none"], "credential_path": ["subscription", "api_key", "none"], "custom_base_url": "bool" },
            "engine_detected": { "engine": ["docker", "podman", "none"] },
            "engine_installed": { "engine": ["docker", "podman", "none"], "outcome": ["success", "failure"] },
            "windows_stage": { "outcome": ["ready", "wsl_absent", "wsl_one", "wsl_no_kernel", "virtual_machine_platform_disabled", "virtualization_disabled", "not_administrator", "check_failed"] },
            "image_pull": { "outcome": ["success", "failure"], "duration_ms": "u64", "bytes": "option_u64" },
            "setup_failed": { "step": ["welcome", "harness", "install", "model", "connect", "ask"], "error_class": ["engine_unavailable", "engine_install_failed", "image_pull_failed", "invalid_configuration", "network_unavailable", "permission_denied", "unknown"] },
            "activated": {},
            "setup_abandoned": { "step": ["welcome", "harness", "install", "model", "connect", "ask"] }
        }
    })
}

pub fn state_path(data_dir: impl AsRef<Path>) -> PathBuf {
    data_dir.as_ref().join(STATE_FILE)
}

fn client() -> Result<Client> {
    Ok(Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .connect_timeout(REQUEST_TIMEOUT)
        .redirect(Policy::none())
        .build()?)
}

fn write_state(path: &Path, state: &PersistedState) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    crate::env::write_private_file(path, &serde_json::to_vec(state)?)?;
    Ok(())
}

fn normalized_max_queue(configured: usize) -> usize {
    configured.clamp(1, 256)
}

fn telemetry_disabled(env_override: EnvOverride) -> bool {
    match env_override {
        EnvOverride::Enabled => false,
        EnvOverride::Disabled => true,
        EnvOverride::Process => {
            disabled_value("COPILOTKIT_TELEMETRY_DISABLED") || disabled_value("DO_NOT_TRACK")
        }
    }
}

fn disabled_value(name: &str) -> bool {
    env::var(name)
        .ok()
        .map(|value| matches!(value.trim().to_ascii_lowercase().as_str(), "1" | "true"))
        .unwrap_or(false)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn is_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    for (index, byte) in bytes.iter().enumerate() {
        if matches!(index, 8 | 13 | 18 | 23) {
            if *byte != b'-' {
                return false;
            }
        } else if !byte.is_ascii_hexdigit() {
            return false;
        }
    }
    true
}

fn new_uuid() -> String {
    let mut bytes = [0u8; 16];
    rand::rng().fill_bytes(&mut bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7], bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]
    )
}
