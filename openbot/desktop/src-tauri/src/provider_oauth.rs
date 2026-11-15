//! Desktop provider authorization. Tokens stay in the installation's private runtime store.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[path = "provider_oauth_lock.rs"]
mod credential_lock;

pub const FILE: &str = ".openbot/model-oauth.json";
const XAI_CLIENT: &str = "b1a00492-073a-47ea-816f-4c329264a828";
const XAI_SCOPE: &str = "openid profile email offline_access grok-cli:access api:access";
const GOOGLE_SCOPE: &str = "https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/generative-language.retriever";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Credentials {
    pub version: u8,
    pub session_id: String,
    pub provider: String,
    pub client_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_secret: Option<String>,
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: u64,
    pub scope: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quota_project: Option<String>,
    pub proxy_token: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Authorization {
    pub attempt_id: String,
    pub url: String,
    pub user_code: Option<String>,
}

struct Flow {
    id: String,
    root: PathBuf,
    canceled: AtomicBool,
    pending: Mutex<Option<Pending>>,
}
enum Pending {
    Google {
        listener: TcpListener,
        verifier: String,
        state: String,
        redirect: String,
        client_id: String,
        client_secret: Option<String>,
        project: String,
    },
    Xai {
        client_id: String,
        device_code: String,
        interval: u64,
        expires: Instant,
    },
}
static ACTIVE: OnceLock<Mutex<Option<Arc<Flow>>>> = OnceLock::new();
fn active() -> &'static Mutex<Option<Arc<Flow>>> {
    ACTIVE.get_or_init(|| Mutex::new(None))
}
fn random() -> String {
    let mut bytes = [0; 32];
    rand::rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}
fn configured(name: &str) -> Option<String> {
    let embedded = match name {
        "OPENBOT_GOOGLE_MODEL_OAUTH_CLIENT_ID" => {
            option_env!("OPENBOT_GOOGLE_MODEL_OAUTH_CLIENT_ID")
        }
        "OPENBOT_GOOGLE_MODEL_OAUTH_CLIENT_SECRET" => {
            option_env!("OPENBOT_GOOGLE_MODEL_OAUTH_CLIENT_SECRET")
        }
        "OPENBOT_GOOGLE_MODEL_OAUTH_QUOTA_PROJECT" => {
            option_env!("OPENBOT_GOOGLE_MODEL_OAUTH_QUOTA_PROJECT")
        }
        "OPENBOT_XAI_MODEL_OAUTH_CLIENT_ID" => option_env!("OPENBOT_XAI_MODEL_OAUTH_CLIENT_ID"),
        _ => None,
    };
    std::env::var(name)
        .ok()
        .or_else(|| embedded.map(str::to_owned))
        .map(|v| v.trim().to_owned())
        .filter(|v| !v.is_empty())
}
fn http() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(25))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("OpenBot/desktop-provider-oauth")
        .build()
        .map_err(|e| e.to_string())
}
fn response_json(response: reqwest::blocking::Response) -> Result<serde_json::Value, String> {
    let status = response.status();
    let value: serde_json::Value = response
        .json()
        .map_err(|_| "The provider returned an unreadable sign-in response.".to_string())?;
    if !status.is_success() {
        return Err(format!(
            "Provider sign-in failed ({}): {}",
            status.as_u16(),
            value
                .get("error_description")
                .or_else(|| value.get("error"))
                .and_then(|v| v.as_str())
                .unwrap_or("request refused")
        ));
    }
    Ok(value)
}
fn required(value: &serde_json::Value, field: &str) -> Result<String, String> {
    value
        .get(field)
        .and_then(|v| v.as_str())
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| format!("The provider omitted {field} from its sign-in response."))
}
fn reserve(root: &Path) -> Arc<Flow> {
    let flow = Arc::new(Flow {
        id: random(),
        root: root.to_owned(),
        canceled: AtomicBool::new(false),
        pending: Mutex::new(None),
    });
    if let Some(previous) = active().lock().unwrap().replace(flow.clone()) {
        previous.canceled.store(true, Ordering::SeqCst);
    }
    flow
}
pub fn begin(root: &Path, provider: &str) -> Result<Authorization, String> {
    // Reserve before blocking network work so a late response cannot replace a newer sign-in.
    let flow = reserve(root);
    let (pending, url, user_code) = match provider {
        "google" => {
            let client_id = configured("OPENBOT_GOOGLE_MODEL_OAUTH_CLIENT_ID").ok_or("Google sign-in needs this OpenBot build's registered desktop OAuth client. Use an API key until it is configured.")?;
            let project = configured("OPENBOT_GOOGLE_MODEL_OAUTH_QUOTA_PROJECT").ok_or(
                "Google sign-in needs a Google Cloud quota project with the Gemini API enabled.",
            )?;
            let client_secret = configured("OPENBOT_GOOGLE_MODEL_OAUTH_CLIENT_SECRET");
            let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
            listener.set_nonblocking(true).map_err(|e| e.to_string())?;
            let redirect = format!(
                "http://127.0.0.1:{}/oauth/callback",
                listener.local_addr().map_err(|e| e.to_string())?.port()
            );
            let verifier = random();
            let state = random();
            let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
            let mut url =
                reqwest::Url::parse("https://accounts.google.com/o/oauth2/v2/auth").unwrap();
            url.query_pairs_mut().extend_pairs([
                ("client_id", client_id.as_str()),
                ("redirect_uri", redirect.as_str()),
                ("response_type", "code"),
                ("scope", GOOGLE_SCOPE),
                ("access_type", "offline"),
                ("prompt", "consent"),
                ("state", state.as_str()),
                ("code_challenge", challenge.as_str()),
                ("code_challenge_method", "S256"),
            ]);
            (
                Pending::Google {
                    listener,
                    verifier,
                    state,
                    redirect,
                    client_id,
                    client_secret,
                    project,
                },
                url.to_string(),
                None,
            )
        }
        "xai" => {
            let client_id = configured("OPENBOT_XAI_MODEL_OAUTH_CLIENT_ID")
                .unwrap_or_else(|| XAI_CLIENT.into());
            let body = response_json(
                http()?
                    .post("https://auth.x.ai/oauth2/device/code")
                    .form(&[
                        ("client_id", client_id.as_str()),
                        ("scope", XAI_SCOPE),
                        ("referrer", "openbot"),
                    ])
                    .send()
                    .map_err(|e| e.to_string())?,
            )?;
            let url = xai_verification_url(&body)?;
            let user_code = required(&body, "user_code")?;
            let device_code = required(&body, "device_code")?;
            let interval = body
                .get("interval")
                .and_then(|v| v.as_u64())
                .unwrap_or(5)
                .max(1);
            let expires = Instant::now()
                + Duration::from_secs(
                    body.get("expires_in")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(600)
                        .min(1800),
                );
            (
                Pending::Xai {
                    client_id,
                    device_code,
                    interval,
                    expires,
                },
                url,
                Some(user_code),
            )
        }
        _ => return Err("That provider does not support this sign-in flow.".into()),
    };
    check(&flow)?;
    *flow.pending.lock().unwrap() = Some(pending);
    Ok(Authorization {
        attempt_id: flow.id.clone(),
        url,
        user_code,
    })
}

pub fn cancel(id: &str) {
    let mut current = active().lock().unwrap();
    if current.as_ref().is_some_and(|flow| flow.id == id) {
        if let Some(flow) = current.take() {
            flow.canceled.store(true, Ordering::SeqCst);
        }
    }
}
fn check(flow: &Flow) -> Result<(), String> {
    if flow.canceled.load(Ordering::SeqCst) {
        Err("Sign-in was canceled.".into())
    } else {
        Ok(())
    }
}
fn wait(flow: &Flow, duration: Duration) -> Result<(), String> {
    let end = Instant::now() + duration;
    while Instant::now() < end {
        check(flow)?;
        std::thread::sleep(
            Duration::from_millis(100).min(end.saturating_duration_since(Instant::now())),
        );
    }
    check(flow)
}

fn xai_verification_url(body: &serde_json::Value) -> Result<String, String> {
    let value = body
        .get("verification_uri_complete")
        .and_then(|v| v.as_str())
        .map(str::to_owned)
        .map(Ok)
        .unwrap_or_else(|| required(body, "verification_uri"))?;
    let invalid = "xAI returned an unsupported sign-in URL.";
    let parsed = reqwest::Url::parse(&value).map_err(|_| invalid)?;
    // The provider's device verification page is https://accounts.x.ai/oauth2/device.
    if parsed.scheme() != "https"
        || parsed.host_str() != Some("accounts.x.ai")
        || parsed.port_or_known_default() != Some(443)
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err(invalid.into());
    }
    Ok(parsed.into())
}

pub fn finish(id: &str) -> Result<(), String> {
    let flow = active()
        .lock()
        .unwrap()
        .as_ref()
        .filter(|flow| flow.id == id)
        .cloned()
        .ok_or("That sign-in is no longer active.")?;
    let pending = flow
        .pending
        .lock()
        .unwrap()
        .take()
        .ok_or("That sign-in is already being completed.")?;
    let result = finish_flow(&flow, pending);
    let mut current = active().lock().unwrap();
    if current.as_ref().is_some_and(|current| current.id == id) {
        current.take();
    }
    result
}
pub(crate) fn read_callback_request(
    stream: &mut TcpStream,
    timeout: Duration,
) -> std::io::Result<String> {
    // Winsock accept inherits the listener's nonblocking mode; a timeout does not clear it.
    stream.set_nonblocking(false)?;
    let deadline = Instant::now() + timeout;
    let mut bytes = [0; 8192];
    let mut length = 0;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "Sign-in callback timed out.",
            ));
        }
        stream.set_read_timeout(Some(remaining))?;
        let count = stream.read(&mut bytes[length..])?;
        if count == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "Incomplete sign-in callback.",
            ));
        }
        length += count;
        if let Some(end) = bytes[..length].iter().position(|byte| *byte == b'\n') {
            return Ok(String::from_utf8_lossy(&bytes[..=end]).into_owned());
        }
        if length == bytes.len() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "Sign-in callback is too large.",
            ));
        }
    }
}

fn receive_callback(stream: &mut TcpStream, state: &str) -> Result<Option<String>, String> {
    let request =
        read_callback_request(stream, Duration::from_secs(2)).map_err(|error| error.to_string())?;
    let path = request
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .unwrap_or("");
    let parsed = reqwest::Url::parse(&format!("http://localhost{path}"))
        .map_err(|_| "Invalid sign-in callback.")?;
    let query: std::collections::HashMap<_, _> = parsed.query_pairs().into_owned().collect();
    if parsed.path() != "/oauth/callback" || query.get("state").map(String::as_str) != Some(state) {
        let _ = stream.write_all(
            b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\nInvalid sign-in callback.",
        );
        return Ok(None);
    }
    if let Some(error) = query.get("error") {
        let _ = stream.write_all(b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\nSign-in was not approved. Return to OpenBot.");
        return Err(format!("Google sign-in was not approved: {error}"));
    }
    let code = query
        .get("code")
        .filter(|v| !v.is_empty())
        .cloned()
        .ok_or("Google did not return an authorization code.")?;
    stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nReturn to OpenBot to finish signing in.").map_err(|e| e.to_string())?;
    Ok(Some(code))
}

fn finish_flow(flow: &Flow, pending: Pending) -> Result<(), String> {
    let (provider, client_id, client_secret, project, scope, tokens) = match pending {
        Pending::Google {
            listener,
            verifier,
            state,
            redirect,
            client_id,
            client_secret,
            project,
        } => {
            let deadline = Instant::now() + Duration::from_secs(600);
            let code = loop {
                check(flow)?;
                if Instant::now() >= deadline {
                    return Err("Google sign-in timed out. Try signing in again.".into());
                }
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        if let Some(code) = receive_callback(&mut stream, &state)? {
                            break code;
                        }
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        wait(flow, Duration::from_millis(100))?
                    }
                    Err(error) => return Err(error.to_string()),
                }
            };
            let mut form = vec![
                ("client_id", client_id.as_str()),
                ("code", code.as_str()),
                ("code_verifier", verifier.as_str()),
                ("redirect_uri", redirect.as_str()),
                ("grant_type", "authorization_code"),
            ];
            if let Some(secret) = &client_secret {
                form.push(("client_secret", secret));
            }
            let tokens = response_json(
                http()?
                    .post("https://oauth2.googleapis.com/token")
                    .form(&form)
                    .send()
                    .map_err(|e| e.to_string())?,
            )?;
            (
                "google",
                client_id,
                client_secret,
                Some(project),
                GOOGLE_SCOPE,
                tokens,
            )
        }
        Pending::Xai {
            client_id,
            device_code,
            mut interval,
            expires,
        } => {
            let tokens = loop {
                if Instant::now() >= expires {
                    return Err("xAI sign-in expired. Try signing in again.".into());
                }
                wait(flow, Duration::from_secs(interval))?;
                let response = http()?
                    .post("https://auth.x.ai/oauth2/token")
                    .form(&[
                        ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
                        ("client_id", client_id.as_str()),
                        ("device_code", device_code.as_str()),
                    ])
                    .send()
                    .map_err(|e| e.to_string())?;
                let status = response.status();
                let body: serde_json::Value = response
                    .json()
                    .map_err(|_| "xAI returned an unreadable sign-in response.")?;
                if status.is_success() {
                    break body;
                }
                match body.get("error").and_then(|v| v.as_str()) {
                    Some("authorization_pending") => continue,
                    Some("slow_down") => {
                        interval = interval.saturating_add(5);
                        continue;
                    }
                    Some("access_denied") => return Err("xAI sign-in was not approved.".into()),
                    Some("expired_token") => {
                        return Err("xAI sign-in expired. Try signing in again.".into())
                    }
                    _ => {
                        return Err(format!(
                            "xAI sign-in failed ({}). Try signing in again.",
                            status.as_u16()
                        ))
                    }
                }
            };
            ("xai", client_id, None, None, XAI_SCOPE, tokens)
        }
    };
    check(flow)?;
    let credentials =
        credentials_from_tokens(provider, client_id, client_secret, project, scope, &tokens)?;
    write(&flow.root, &credentials, || check(flow))
}
fn credentials_from_tokens(
    provider: &str,
    client_id: String,
    client_secret: Option<String>,
    quota_project: Option<String>,
    scope: &str,
    tokens: &serde_json::Value,
) -> Result<Credentials, String> {
    let duration = tokens
        .get("expires_in")
        .and_then(|v| v.as_u64())
        .filter(|v| *v > 0)
        .or_else(|| (provider == "xai").then_some(3600))
        .ok_or("The provider did not return a token expiry.")?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis() as u64;
    Ok(Credentials {
        version: 1,
        session_id: random(),
        provider: provider.into(),
        client_id,
        client_secret,
        access_token: required(tokens, "access_token")?,
        refresh_token: required(tokens, "refresh_token")?,
        expires_at: now.saturating_add(duration.saturating_mul(1000)),
        scope: tokens
            .get("scope")
            .and_then(|v| v.as_str())
            .unwrap_or(scope)
            .into(),
        quota_project,
        proxy_token: random(),
    })
}
pub fn read(root: &Path, provider: &str) -> Result<Credentials, String> {
    let bytes = std::fs::read(root.join(FILE))
        .map_err(|_| "The saved provider sign-in is unavailable. Sign in again.")?;
    let saved: Credentials = serde_json::from_slice(&bytes)
        .map_err(|_| "The saved provider sign-in is unreadable. Sign in again.")?;
    if saved.version != 1
        || saved.provider != provider
        || saved.refresh_token.is_empty()
        || saved.proxy_token.is_empty()
    {
        return Err("The saved sign-in does not match this provider. Sign in again.".into());
    }
    Ok(saved)
}
fn write(
    root: &Path,
    credentials: &Credentials,
    current: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let path = root.join(FILE);
    let directory = path.parent().unwrap();
    std::fs::create_dir_all(directory).map_err(|e| e.to_string())?;
    let metadata = std::fs::symlink_metadata(directory).map_err(|e| e.to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("The provider credential directory must be a plain directory.".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
    }
    #[cfg(windows)]
    {
        use std::os::windows::{fs::MetadataExt, process::CommandExt};
        if metadata.file_attributes() & 0x400 != 0 {
            return Err("The provider credential directory cannot be redirected.".into());
        }
        // Give new atomically replaced files an owner-only inherited DACL, including runtime refreshes.
        let script = "$ErrorActionPreference='Stop'; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=New-Object System.Security.AccessControl.DirectorySecurity; $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false); $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $acl.AddAccessRule($rule); Set-Acl -LiteralPath $env:OPENBOT_OAUTH_DIRECTORY -AclObject $acl";
        let output = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .env("OPENBOT_OAUTH_DIRECTORY", directory)
            // A PowerShell 7 parent passes its incompatible modules through Cargo/OpenBot.
            // Let Windows PowerShell rebuild its own default module search path.
            .env_remove("PSModulePath")
            .creation_flags(0x08000000)
            .output()
            .map_err(|e| e.to_string())?;
        if !output.status.success() {
            return Err(format!(
                "OpenBot could not make the provider sign-in private to your Windows account. {}",
                crate::quiet::said(&output.stderr)
            ));
        }
    }
    let _lock = credential_lock::acquire(&path)
        .map_err(|error| format!("Could not save provider sign-in: {error}"))?;
    current().and_then(|()| {
        serde_json::to_vec(credentials)
            .map_err(|e| e.to_string())
            .and_then(|bytes| {
                crate::env::write_private_file(&path, &bytes).map_err(|e| e.to_string())
            })
    })
}
