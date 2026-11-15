/*!
Where a secret lives, which is not the `.env`.

WHAT EACH PLATFORM ACTUALLY GETS.

- **macOS and Linux: an owner-only file** under the selected deployment root.
- **Windows: DPAPI**, through PowerShell's `ProtectedData`, encrypting to the signed-in user so the
  ciphertext is useless to any other account on the machine, and to anybody who copies the file off
  it.

THE VALUE NEVER GOES ON A COMMAND LINE. `ps` is readable by every process the person runs. Windows
writes over stdin, since PowerShell reading the console to the end has no buffer limit of its own.
*/

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use crate::problem::Problem;

/**
Whether a setting is a credential.

By name, and the list is the point. A classifier that guessed from the value would be wrong in both
directions: `OPENAI_BASE_URL` looks like nothing and `POSTGRES_PORT` looks like nothing, while
a generated token looks exactly like a random string of settings. Anything not named here is a
setting and goes in the file where somebody can read it.
*/
pub fn is_secret(key: &str) -> bool {
    matches!(
        key,
        // Somebody's own credentials, pasted or signed in for.
        "OPENAI_API_KEY"
            | "ANTHROPIC_API_KEY"
            | "CLAUDE_CODE_OAUTH_TOKEN"
            // Retired, and still swept up: a machine that ran an older version has one of these.
            | "CHATGPT_OAUTH_TOKEN"
            // Generated here, and no less a credential for it. These are what the services prove
            // themselves to each other with, and what a Bot's computer is driven with.
            | "MANAGED_AGENT_TOKEN"
            | "AGENT_TOOL_TOKEN"
            | "COMPUTER_TOKEN"
            | "SUPERVISOR_TOKEN"
            | "WORKER_SHARED_SECRET"
            | "KEY_ENCRYPTION_KEY"
            | crate::saved_intent::COMPATIBLE_CREDENTIAL
    )
}

/// Split what a run produced into what the file may hold and what it may not.
pub fn split(
    all: BTreeMap<String, String>,
) -> (BTreeMap<String, String>, BTreeMap<String, String>) {
    let mut settings = BTreeMap::new();
    let mut secrets = BTreeMap::new();
    for (key, value) in all {
        if is_secret(&key) {
            secrets.insert(key, value);
        } else {
            settings.insert(key, value);
        }
    }
    (settings, secrets)
}

/**
Put every secret away, and take each one out of the file it used to be written to.

Both halves matter. Storing without clearing would leave the old copy behind on every machine that
has run an earlier version, which is the same credential in the same file for no benefit at all.
*/
pub fn remember_all(root: &Path, secrets: &BTreeMap<String, String>) -> Result<(), Problem> {
    remember_all_with(root, secrets, &mut remember, &mut forget)
}

pub fn write_env_after_remembering(
    root: &Path,
    path: &Path,
    settings: &BTreeMap<String, String>,
    secrets: &BTreeMap<String, String>,
    purge: &BTreeMap<String, String>,
) -> Result<(), Problem> {
    write_env_after_remembering_with(root, path, settings, secrets, purge, remember, forget)
}

fn write_env_after_remembering_with(
    root: &Path,
    path: &Path,
    settings: &BTreeMap<String, String>,
    secrets: &BTreeMap<String, String>,
    purge: &BTreeMap<String, String>,
    mut remember_one: impl FnMut(&Path, &str, &str) -> Result<(), Problem>,
    mut forget_one: impl FnMut(&Path, &str) -> Result<(), Problem>,
) -> Result<(), Problem> {
    remember_all_with(root, secrets, &mut remember_one, &mut forget_one)?;
    crate::env::write(path, settings, purge)
        .map_err(|e| format!("could not write .env: {e}").into())
}

pub(crate) fn remember_all_with(
    root: &Path,
    secrets: &BTreeMap<String, String>,
    remember_one: &mut impl FnMut(&Path, &str, &str) -> Result<(), Problem>,
    forget_one: &mut impl FnMut(&Path, &str) -> Result<(), Problem>,
) -> Result<(), Problem> {
    for (key, value) in secrets {
        if value.trim().is_empty() {
            forget_one(root, key)?;
            continue;
        }
        remember_one(root, key, value)?;
    }
    Ok(())
}

/// A raw secret read, separated by whether the operating system may ask the person.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReadPolicy {
    /// No protected store at all. This is the startup and React-mount policy.
    FileOnly,
    /// Access protected storage without permitting operating-system authorization UI.
    NoUi,
}

/**
What a previous run left, under the selected interaction policy.

The file path is always read first because legacy `.env` credentials must still migrate. Protected
storage is layered on top only for Start and Ask, without authorization UI. Refusal is an error. Passive saved hints come from local nonsecret intent metadata.
*/
pub fn already_given_with_policy(
    root: &Path,
    env_file: &Path,
    keys: &[&str],
    policy: ReadPolicy,
) -> Result<BTreeMap<String, String>, Problem> {
    already_given_with_reader(root, env_file, keys, policy, recall_no_ui)
}

fn already_given_with_reader(
    root: &Path,
    env_file: &Path,
    keys: &[&str],
    policy: ReadPolicy,
    mut read: impl FnMut(&Path, &str) -> Result<Option<String>, Problem>,
) -> Result<BTreeMap<String, String>, Problem> {
    let mut found = match policy {
        ReadPolicy::FileOnly => crate::env::already_set(env_file, keys),
        ReadPolicy::NoUi => crate::env::read_already_set(env_file, keys).map_err(|error| {
            Problem::with(
                "OpenBot could not read its settings.",
                format!("{}: {error}", env_file.display()),
            )
        })?,
    };
    if policy == ReadPolicy::FileOnly {
        return Ok(found);
    }

    for key in keys.iter().copied().filter(|key| is_secret(key)) {
        let value = match policy {
            ReadPolicy::FileOnly => None,
            ReadPolicy::NoUi => read(root, key)?,
        };
        if let Some(value) = value.filter(|value| !value.trim().is_empty()) {
            found.insert(key.to_string(), value);
        }
    }
    Ok(found)
}

/// Passive startup hydration. It never asks protected storage for a raw secret.
pub fn already_given_file_only(env_file: &Path, keys: &[&str]) -> BTreeMap<String, String> {
    crate::env::already_set(env_file, keys)
}

/// Protected retrieval for a user-triggered action.
pub fn already_given_no_ui(
    root: &Path,
    env_file: &Path,
    keys: &[&str],
) -> Result<BTreeMap<String, String>, Problem> {
    already_given_with_policy(root, env_file, keys, ReadPolicy::NoUi)
}

// Cache only successfully retrieved credentials. Absence and refusal must be rechecked on the next
// attempt. Hold the cache lock across store access so a late read cannot overwrite a newer
// write/delete. Passive hydration never enters this cache.
type CachedRead = Result<Option<String>, Problem>;

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct CacheKey {
    root: PathBuf,
    name: String,
}

static REMEMBERED: std::sync::OnceLock<std::sync::Mutex<BTreeMap<CacheKey, CachedRead>>> =
    std::sync::OnceLock::new();

fn cache() -> &'static std::sync::Mutex<BTreeMap<CacheKey, CachedRead>> {
    REMEMBERED.get_or_init(|| std::sync::Mutex::new(BTreeMap::new()))
}

pub fn recall(root: &Path, name: &str) -> Result<Option<String>, Problem> {
    recall_no_ui(root, name)
}

fn recall_no_ui(root: &Path, name: &str) -> Result<Option<String>, Problem> {
    recall_no_ui_cached(root, name, cache(), recall_from_store)
}

fn cache_problem() -> Problem {
    Problem::plain("OpenBot could not access its credential cache. Restart OpenBot and try again.")
}

fn recall_no_ui_cached(
    root: &Path,
    name: &str,
    cache: &std::sync::Mutex<BTreeMap<CacheKey, CachedRead>>,
    recall_one: impl FnOnce(&Path, &str) -> Result<Option<String>, Problem>,
) -> Result<Option<String>, Problem> {
    let mut held = cache.lock().map_err(|_| cache_problem())?;
    let key = CacheKey {
        root: root.to_path_buf(),
        name: name.to_string(),
    };
    if let Some(known) = held.get(&key) {
        return known.clone();
    }
    let found = recall_one(root, name);
    if matches!(&found, Ok(Some(_))) {
        held.insert(key, found.clone());
    }
    found
}

/// Store a secret, and keep the cache in step so the next read does not ask again.
pub fn remember(root: &Path, name: &str, value: &str) -> Result<(), Problem> {
    remember_cached(root, name, value, cache(), remember_in_store)
}

fn remember_cached(
    root: &Path,
    name: &str,
    value: &str,
    cache: &std::sync::Mutex<BTreeMap<CacheKey, CachedRead>>,
    remember_one: impl FnOnce(&Path, &str, &str) -> Result<(), Problem>,
) -> Result<(), Problem> {
    let mut held = cache.lock().map_err(|_| cache_problem())?;
    let key = CacheKey {
        root: root.to_path_buf(),
        name: name.to_string(),
    };
    // A successful store read/write confirms these exact bytes for this process. In particular,
    // do not repeat a just-authorized write on the person's explicit ordinary Start retry.
    if held
        .get(&key)
        .is_some_and(|known| matches!(known, Ok(Some(saved)) if saved == value))
    {
        return Ok(());
    }
    // A failed restoration can follow a successful OS write. Discard any stale cache entry.
    held.remove(&key);
    remember_one(root, name, value)?;
    held.insert(key, Ok(Some(value.to_string())));
    Ok(())
}

/// Drop a secret from the store. Refusal must not be published as absence.
pub fn forget(root: &Path, name: &str) -> Result<(), Problem> {
    forget_cached(root, name, cache(), forget_in_store)
}

fn forget_cached(
    root: &Path,
    name: &str,
    cache: &std::sync::Mutex<BTreeMap<CacheKey, CachedRead>>,
    forget_one: impl FnOnce(&Path, &str) -> Result<(), Problem>,
) -> Result<(), Problem> {
    let mut held = cache.lock().map_err(|_| cache_problem())?;
    held.remove(&CacheKey {
        root: root.to_path_buf(),
        name: name.to_string(),
    });
    forget_one(root, name)
}

/// Read back what was stored, preserving protected-store failures.
pub fn recall_all(root: &Path, keys: &[&str]) -> Result<BTreeMap<String, String>, Problem> {
    let mut found = BTreeMap::new();
    for key in keys {
        if let Some(value) = recall(root, key)? {
            if !value.trim().is_empty() {
                found.insert((*key).to_string(), value);
            }
        }
    }
    Ok(found)
}

/*
 * DPAPI, through the only interpreter Windows is guaranteed to have.
 *
 * `ProtectedData` with `CurrentUser` ties the ciphertext to the signed-in account, so the file is
 * useless on another account and useless copied off the machine. The plaintext arrives on stdin
 * and the ciphertext leaves on stdout, so neither is ever an argument.
 */
#[cfg(target_os = "windows")]
fn remember_in_store(root: &Path, name: &str, value: &str) -> Result<(), Problem> {
    const PROTECT: &str = r#"
$ErrorActionPreference = 'Stop'
$plain = [Console]::In.ReadToEnd()
$bytes = [Text.Encoding]::UTF8.GetBytes($plain)
Add-Type -AssemblyName System.Security
$sealed = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, 'CurrentUser')
[Convert]::ToBase64String($sealed)
"#;
    let sealed = powershell(PROTECT, Some(value))?;
    let path = vault_dir(root)?.join(format!("{name}.dpapi"));
    std::fs::write(&path, sealed.trim())
        .map_err(|error| dpapi_write_problem(format!("{}: {error}", path.display())))
}

#[cfg(target_os = "windows")]
fn recall_from_store(root: &Path, name: &str) -> Result<Option<String>, Problem> {
    const UNPROTECT: &str = r#"
$ErrorActionPreference = 'Stop'
$sealed = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())
Add-Type -AssemblyName System.Security
$bytes = [Security.Cryptography.ProtectedData]::Unprotect($sealed, $null, 'CurrentUser')
[Text.Encoding]::UTF8.GetString($bytes)
"#;
    let path = vault_dir(root)?.join(format!("{name}.dpapi"));
    let Some(sealed) = read_dpapi_store_file(&path)? else {
        return Ok(None);
    };
    powershell(UNPROTECT, Some(&sealed)).map(|plain| Some(plain.trim().to_string()))
}

#[cfg(target_os = "windows")]
fn read_dpapi_store_file(path: &Path) -> Result<Option<String>, Problem> {
    match std::fs::read_to_string(path) {
        Ok(sealed) => Ok(Some(sealed)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(dpapi_read_problem(format!("{}: {error}", path.display()))),
    }
}

#[cfg(target_os = "windows")]
fn forget_in_store(root: &Path, name: &str) -> Result<(), Problem> {
    remove_secret_file(&vault_dir(root)?.join(format!("{name}.dpapi")))
}

#[cfg(target_os = "windows")]
fn powershell(program: &str, input: Option<&str>) -> Result<String, Problem> {
    let child = powershell_command(program)
        .spawn()
        .map_err(|error| dpapi_problem(error.to_string()))?;
    dpapi_output(child, input)
}

#[cfg(target_os = "windows")]
fn powershell_command(program: &str) -> std::process::Command {
    let mut command = crate::quiet::command("powershell");
    command
        .args(["-NoProfile", "-NonInteractive", "-Command", program])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    command
}

#[cfg(target_os = "windows")]
fn write_dpapi_stdin(stdin: Option<impl Write>, input: Option<&str>) -> Result<(), Problem> {
    if let Some(text) = input {
        let mut stdin = stdin.ok_or_else(|| {
            dpapi_problem("DPAPI stdin write failed: piped stdin is missing".into())
        })?;
        stdin
            .write_all(text.as_bytes())
            .map_err(|error| dpapi_problem(format!("DPAPI stdin write failed: {error}")))?;
    }
    // Taking ownership closes the pipe before the caller waits, including empty/absent input.
    Ok(())
}

#[cfg(target_os = "windows")]
fn dpapi_output(mut child: std::process::Child, input: Option<&str>) -> Result<String, Problem> {
    if let Err(mut problem) = write_dpapi_stdin(child.stdin.take(), input) {
        // The input pipe is already closed. Do not leave a protector waiting after an early return,
        // and keep the stdin failure primary even if termination or reaping also fails.
        if let Err(error) = child.kill() {
            problem
                .detail
                .get_or_insert_with(String::new)
                .push_str(&format!("; terminating DPAPI child: {error}"));
        }
        if let Err(error) = child.wait() {
            problem
                .detail
                .get_or_insert_with(String::new)
                .push_str(&format!("; reaping DPAPI child: {error}"));
        }
        return Err(problem);
    }
    let done = child
        .wait_with_output()
        .map_err(|error| dpapi_problem(error.to_string()))?;
    if !done.status.success() {
        return Err(dpapi_problem(
            String::from_utf8_lossy(&done.stderr).to_string(),
        ));
    }
    Ok(String::from_utf8_lossy(&done.stdout).to_string())
}

#[cfg(target_os = "windows")]
fn dpapi_problem(detail: String) -> Problem {
    dpapi_write_problem(detail)
}

#[cfg(target_os = "windows")]
fn dpapi_write_problem(detail: String) -> Problem {
    Problem::with(
        "OpenBot could not save your sign-in details to this computer's protected storage.",
        detail,
    )
}

#[cfg(target_os = "windows")]
fn dpapi_read_problem(detail: String) -> Problem {
    Problem::with(
        "OpenBot could not read your sign-in details from this computer's protected storage.",
        detail,
    )
}

#[cfg(not(target_os = "windows"))]
fn remember_in_store(root: &Path, name: &str, value: &str) -> Result<(), Problem> {
    let path = vault_dir(root)?.join(format!("{name}.secret"));
    write_secret_file(&path, value)
}

#[cfg(not(target_os = "windows"))]
fn write_secret_file(path: &Path, value: &str) -> Result<(), Problem> {
    write_secret_file_with(path, value, |tmp, value| {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(tmp)?;
        file.write_all(value.as_bytes())?;
        file.sync_all()
    })
}

#[cfg(not(target_os = "windows"))]
fn write_secret_file_with(
    path: &Path,
    value: &str,
    write_tmp: impl FnOnce(&Path, &str) -> std::io::Result<()>,
) -> Result<(), Problem> {
    reject_unsafe_final(path)?;
    let tmp = path.with_file_name(format!(
        ".{}.{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("credential"),
        std::process::id()
    ));
    let result = write_tmp(&tmp, value)
        .and_then(|()| {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))?;
            }
            std::fs::rename(&tmp, path)
        })
        .map_err(|error| {
            Problem::with(
                "OpenBot could not save your sign-in details on this computer.",
                format!("{}: {error}", path.display()),
            )
        });
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

#[cfg(not(target_os = "windows"))]
fn reject_unsafe_final(path: &Path) -> Result<(), Problem> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.file_type().is_file() => {
            Err(Problem::with(
                "OpenBot could not save your sign-in details on this computer.",
                format!("{}: credential path is not a regular file", path.display()),
            ))
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(Problem::with(
            "OpenBot could not save your sign-in details on this computer.",
            format!("{}: {error}", path.display()),
        )),
    }
}

#[cfg(not(target_os = "windows"))]
fn recall_from_store(root: &Path, name: &str) -> Result<Option<String>, Problem> {
    recall_secret_file(&vault_dir(root)?.join(format!("{name}.secret")))
}

#[cfg(not(target_os = "windows"))]
fn recall_secret_file(path: &Path) -> Result<Option<String>, Problem> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.file_type().is_file() => {
            return Err(Problem::with(
                "OpenBot could not read your saved sign-in details on this computer.",
                format!("{}: credential path is not a regular file", path.display()),
            ));
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(Problem::with(
                "OpenBot could not read your saved sign-in details on this computer.",
                format!("{}: {error}", path.display()),
            ));
        }
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options.open(path).map_err(|error| {
        Problem::with(
            "OpenBot could not read your saved sign-in details on this computer.",
            format!("{}: {error}", path.display()),
        )
    })?;
    let mut value = String::new();
    file.read_to_string(&mut value).map_err(|error| {
        Problem::with(
            "OpenBot could not read your saved sign-in details on this computer.",
            format!("{}: {error}", path.display()),
        )
    })?;
    Ok(Some(value.trim().to_string()))
}

#[cfg(not(target_os = "windows"))]
fn forget_in_store(root: &Path, name: &str) -> Result<(), Problem> {
    remove_secret_file(&vault_dir(root)?.join(format!("{name}.secret")))
}

fn remove_secret_file(path: &Path) -> Result<(), Problem> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(Problem::with(
            "OpenBot could not remove a saved credential on this computer.",
            format!("{}: {error}", path.display()),
        )),
    }
}

/// Where the platforms that keep a file keep it. Created owner-only, not merely written so.
pub(crate) fn vault_dir(root: &Path) -> Result<PathBuf, Problem> {
    let dir = root.join(".secrets");
    let prepare = || -> std::io::Result<()> {
        match require_credential_directory(&dir) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let mut builder = std::fs::DirBuilder::new();
                builder.recursive(true);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::DirBuilderExt;
                    builder.mode(0o700);
                }
                builder.create(&dir)?;
                // Check again when another creator won the race to create this directory.
                require_credential_directory(&dir)
            }
            Err(error) => Err(error),
        }
    };
    prepare().map_err(|error| {
        Problem::with(
            "OpenBot could not access the place it keeps your sign-in details.",
            format!("{}: {error}", dir.display()),
        )
    })?;
    owner_only(&dir)?;
    Ok(dir)
}

/// Checking the final credential file alone does not stop `.secrets` redirecting into another
/// deployment. Validate the directory before changing its permissions or accessing any item.
fn require_credential_directory(path: &Path) -> std::io::Result<()> {
    let metadata = std::fs::symlink_metadata(path)?;
    let redirected = metadata.file_type().is_symlink();
    #[cfg(windows)]
    let redirected = {
        use std::os::windows::fs::MetadataExt;
        // FILE_ATTRIBUTE_REPARSE_POINT also covers junctions, not just symbolic links.
        const REPARSE_POINT: u32 = 0x400;
        redirected || metadata.file_attributes() & REPARSE_POINT != 0
    };
    if redirected || !metadata.is_dir() {
        return Err(std::io::Error::other(
            "credential directory is not a plain directory",
        ));
    }
    Ok(())
}

/// Owner-only where the platform has the notion, and a no-op where it does not.
///
/// Only where a file is kept; the Windows store path uses its platform protection separately.
#[cfg(unix)]
fn owner_only(path: &Path) -> Result<(), Problem> {
    use std::os::unix::fs::PermissionsExt;
    let mode = if path.is_dir() { 0o700 } else { 0o600 };
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).map_err(|error| {
        Problem::with(
            "OpenBot could not make your saved sign-in details private to your account.",
            format!("{}: {error}", path.display()),
        )
    })
}

#[cfg(not(unix))]
fn owner_only(_path: &Path) -> Result<(), Problem> {
    Ok(())
}
