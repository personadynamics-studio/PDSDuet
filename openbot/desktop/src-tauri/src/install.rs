//! Installing an engine, instead of telling somebody to go and get one.
//!
//! The person this app is for does not have a package manager, has never heard of Podman, and is
//! not going to read a release page. Every sentence that begins "install ..." is a step where an
//! install stops for good, so the engine is fetched and installed here.
//!
//! Two things are fetched, not one, and the second is the one that gets forgotten. Podman ships no
//! Compose implementation: `podman compose` looks for an external provider on PATH and, finding
//! none, answers with seven errors naming `docker-compose`. So a machine with a freshly installed
//! Podman still cannot raise the stack. Compose is a single static binary, which is why it can be
//! placed rather than installed.
//!
//! **Nothing fetched here is run unverified.** These files are executed, so each is pinned to the
//! digest of the release this was tested against, and a mismatch is refused rather than run.
//! Fetching a checksum from the same server that served the file would prove nothing.
//!
//! The three platforms install differently and only one of them is unattended:
//!
//! - **Windows.** The MSI is a per-user install, so it needs no elevation and lands in the profile
//!   of whoever runs it. That is also the trap: run from a service or an elevated helper it lands
//!   in `C:\Windows\system32\config\systemprofile`, where the person's own session cannot see it.
//!   Measured, on Windows Server 2022, by installing it from a service and then watching the app
//!   report no engine while `podman.exe` sat on disk. It has to run as them, which is where the app
//!   already runs.
//! - **macOS.** The package writes to `/opt/podman` and needs administrator rights, so the person
//!   sees one standard macOS authorization prompt. There is no way around that prompt and no reason
//!   to want one: it is the same dialog every other installer raises.
//! - **Linux.** Podman there is not a binary but a set of them (`conmon`, `crun`, `netavark`,
//!   `slirp4netns`), wired to the distribution's own paths, so downloading one file would produce
//!   something that runs nothing. The distribution's package manager installs it, through
//!   `pkexec`, which raises that desktop's own authorization prompt.

use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::engine::{self, Engine};
use crate::problem::Problem;

/// The releases this was tested against.
///
/// Pinned for the reason the deployment pins image digests: a version is what somebody hopes is
/// there, a digest is what was run. Moving these means re-recording the digests below.
pub const PODMAN: &str = "6.1.1";
pub const COMPOSE: &str = "5.5.1";
/// Keep aligned with the repository's packageManager and container runtime.
pub const BUN: &str = "1.4.3";

/// A file to fetch and the digest it has to have.
#[derive(Debug, PartialEq, Eq)]
pub struct Download {
    pub url: String,
    pub sha256: &'static str,
    /// What to call it on disk. Named rather than taken from the URL so a redirect cannot choose
    /// the filename.
    pub file: &'static str,
}

/// The Podman installer for this machine, or why there is not one.
///
/// The Intel Mac case is real and not hypothetical: Podman 6.1.1 publishes `arm64` only. Answering
/// with the arm64 package there would install something that cannot run, so it says so instead.
pub fn podman_download() -> Result<Download, Problem> {
    let (file, sha256) = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => (
            "podman-installer-windows-amd64.msi",
            "91d0e8ea0846c0151d531c88c329bb2729387231e4d1e42306a8e3ae9d09fc8a",
        ),
        ("windows", "aarch64") => (
            "podman-installer-windows-arm64.msi",
            "8ededac563c3b96abe55560f3379962ff59fd8bda1a185ed221891cb6ccf5cba",
        ),
        ("macos", "aarch64") => (
            "podman-installer-macos-arm64.pkg",
            "9c7b90b406681e5458d69cdb1164a589f7c9b214cab1ca6705fe375876491c09",
        ),
        ("macos", _) => {
            return Err(Problem::with(
                "OpenBot cannot install the container engine on an Intel Mac. Install Podman \
                 Desktop or Docker Desktop, then start OpenBot again.",
                format!("Podman {PODMAN} publishes an arm64 package only"),
            ))
        }
        ("linux", _) => {
            return Err(Problem::plain(
                "On Linux the engine comes from the distribution's own packages.",
            ))
        }
        (os, arch) => {
            return Err(Problem::with(
                "OpenBot cannot install the container engine on this kind of computer.",
                format!("no Podman installer for {os} on {arch}"),
            ))
        }
    };
    Ok(Download {
        url: format!(
            "https://github.com/podman-container-tools/podman/releases/download/v{PODMAN}/{file}"
        ),
        sha256,
        file,
    })
}

/// The Compose provider for this machine.
///
/// One static binary on every platform, which is the whole reason this can be placed beside the
/// engine rather than installed into the system.
pub fn compose_download() -> Result<Download, Problem> {
    let (file, sha256) = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => (
            "docker-compose-windows-x86_64.exe",
            "a3c0c73033eaede90210345d0cc2233edf4fab8fe0282a91dad8fd8436809d2f",
        ),
        ("windows", "aarch64") => (
            "docker-compose-windows-aarch64.exe",
            "4bbb5d1ecc75bde1a9ca4afac43f5907c0d3bd0f88c7f00bf481ee7c8c1737be",
        ),
        ("macos", "x86_64") => (
            "docker-compose-darwin-x86_64",
            "a264d61e824bf08a78867e59cdf32eb09f0aee9ecdf9f6ebfa43f76dc52880f1",
        ),
        ("macos", "aarch64") => (
            "docker-compose-darwin-aarch64",
            "998735c9b6fe68a4f05895e6ea73d71ad06f9fc7046383ad89e47346781b6af5",
        ),
        ("linux", "x86_64") => (
            "docker-compose-linux-x86_64",
            "db1889184726840f75c4f9c001048430d4f25b3be3cb084d3ddd762bc0aed576",
        ),
        ("linux", "aarch64") => (
            "docker-compose-linux-aarch64",
            "732e3a84c1a0f67256ce80bc2598a24546b10ca05f9faa97efceb1171ece2ef7",
        ),
        (os, arch) => {
            return Err(Problem::with(
                "OpenBot cannot install the piece that runs the containers on this kind of \
                 computer.",
                format!("no Compose build for {os} on {arch}"),
            ))
        }
    };
    Ok(Download {
        url: format!("https://github.com/docker/compose/releases/download/v{COMPOSE}/{file}"),
        sha256,
        file,
    })
}

/// Fetch to `into`, refusing anything whose digest is not the pinned one.
///
/// A file already there with the right digest is kept, so a retry after a failed install is not a
/// second download. A file already there with the wrong one is replaced: that is a half-written
/// download far more often than it is an attack, and either way it must not be run.
fn fetch_verified(download: &Download, into: &Path) -> Result<PathBuf, Problem> {
    let path = into.join(download.file);
    if let Ok(existing) = std::fs::read(&path) {
        if digest_of(&existing) == download.sha256 {
            return Ok(path);
        }
    }

    let body = crate::deployment::get(&download.url).map_err(|error| {
        Problem::with(
            "OpenBot could not download the software it needs to run. Check the internet \
             connection and try again.",
            format!("{}: {error}", download.url),
        )
    })?;

    let got = digest_of(&body);
    if got != download.sha256 {
        return Err(Problem::with(
            "What OpenBot downloaded is not what it was expecting, so it has not been run. Try \
             again.",
            format!(
                "{} from {}: expected sha256 {}, got {got}",
                download.file, download.url, download.sha256
            ),
        ));
    }

    std::fs::create_dir_all(into).map_err(|error| unwritable(into, &error.to_string()))?;
    std::fs::write(&path, &body).map_err(|error| unwritable(&path, &error.to_string()))?;
    Ok(path)
}

/// One sentence for every "could not write here", because the person's fix is the same each time.
fn unwritable(path: &Path, error: &str) -> Problem {
    Problem::with(
        "OpenBot could not save the software it downloaded. Check there is free disk space and \
         try again.",
        format!("{}: {error}", path.display()),
    )
}

fn digest_of(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// A fresh account has no developer tools. Acquire the host runtime as that user,
/// without changing PATH or requiring an administrator. Existing installations remain usable.
pub fn ensure_bun(cache: &Path, existing: Option<PathBuf>) -> Result<PathBuf, Problem> {
    ensure_bun_with(existing, || install_bun(cache))
}

fn ensure_bun_with(
    existing: Option<PathBuf>,
    install: impl FnOnce() -> Result<PathBuf, Problem>,
) -> Result<PathBuf, Problem> {
    match existing {
        Some(path) => Ok(path),
        _ => install(),
    }
}

fn bun_download(os: &str, arch: &str) -> Result<Download, Problem> {
    // Official bun-v1.4.3/SHASUMS256.txt. The baseline x64 build also supports older CPUs.
    let (file, sha256) = match (os, arch) {
        ("windows", "x86_64") => (
            "bun-windows-x64-baseline.zip",
            "d7a7d3eb216614544aab0cde2d8d9f2e4e87839bf5a30a1cd11d077f02d84e0c",
        ),
        ("windows", "aarch64") => (
            "bun-windows-aarch64.zip",
            "5e8f142ef722cbc9f67dc068a166e46ee72be8307b38cac7186589d2face668f",
        ),
        ("macos", "x86_64") => (
            "bun-darwin-x64-baseline.zip",
            "0fde04e8b092156b97fe6432e899baf16d9ed6ce52cbb4218d2d9c07a2f827ef",
        ),
        ("macos", "aarch64") => (
            "bun-darwin-aarch64.zip",
            "80afd4c069b46a6fa8f3ec520bebc750a7843e4a8d5b9583d29ad436c00a3403",
        ),
        ("linux", "x86_64") => (
            "bun-linux-x64-baseline.zip",
            "1fc2edac843102909e3a1be1d8d9802cc6071cf074e67e88231f4ffe0f8b397b",
        ),
        ("linux", "aarch64") => (
            "bun-linux-aarch64.zip",
            "efa9813da5ed72423bf847f916e8d2c47c0d776add972354026a75e10da9aa21",
        ),
        _ => {
            return Err(Problem::with(
                "OpenBot cannot install its app runtime on this kind of computer.",
                format!("no Bun {BUN} build for {os} on {arch}"),
            ))
        }
    };
    Ok(Download {
        url: format!("https://github.com/oven-sh/bun/releases/download/bun-v{BUN}/{file}"),
        sha256,
        file,
    })
}

fn install_bun(cache: &Path) -> Result<PathBuf, Problem> {
    let download = bun_download(std::env::consts::OS, std::env::consts::ARCH)?;
    let entry = format!(
        "{}/bun{}",
        download.file.trim_end_matches(".zip"),
        std::env::consts::EXE_SUFFIX,
    );
    let into = crate::acquire::download_dir(cache).join(format!("bun-{BUN}"));
    install_bun_with(
        &into,
        &download,
        |archive, target| extract_bun(archive, target, &entry),
    )
}

fn install_bun_with(
    into: &Path,
    download: &Download,
    extract: impl FnOnce(&Path, &Path) -> Result<(), Problem>,
) -> Result<PathBuf, Problem> {
    let binary = into.join(format!("bun{}", std::env::consts::EXE_SUFFIX));
    if binary.is_file() {
        return Ok(binary);
    }
    let archive = fetch_verified(download, into)?;
    let staged = into.join(format!("bun.download{}", std::env::consts::EXE_SUFFIX));
    let result = extract(&archive, &staged)
        .and_then(|()| {
            std::fs::rename(&staged, &binary)
                .map_err(|error| unwritable(&binary, &error.to_string()))
        });
    if let Err(mut problem) = result {
        if let Err(error) = std::fs::remove_file(&staged) {
            if error.kind() != std::io::ErrorKind::NotFound {
                problem.detail = Some(format!(
                    "{}; could not remove incomplete runtime {}: {error}",
                    problem.detail.as_deref().unwrap_or(&problem.said),
                    staged.display(),
                ));
            }
        }
        return Err(problem);
    }
    Ok(binary)
}

fn extract_bun(archive: &Path, target: &Path, entry: &str) -> Result<(), Problem> {
    let unpack_error = |error: &dyn std::fmt::Display| {
        Problem::with(
            "OpenBot could not unpack its app runtime. Try again.",
            format!("{} entry {entry}: {error}", archive.display()),
        )
    };

    // Only the named executable is copied to our chosen staging path. Archive paths never
    // choose output locations, and installation needs no external archive utility or shell.
    let file = std::fs::File::open(archive).map_err(|error| unpack_error(&error))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|error| unpack_error(&error))?;
    let mut executable = zip.by_name(entry).map_err(|error| unpack_error(&error))?;
    let mut file =
        std::fs::File::create(target).map_err(|error| unwritable(target, &error.to_string()))?;
    std::io::copy(&mut executable, &mut file).map_err(|error| unpack_error(&error))?;
    drop(file);

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(target, std::fs::Permissions::from_mode(0o755))
            .map_err(|error| unwritable(target, &error.to_string()))?;
    }
    Ok(())
}

/// Put the engine on this machine, and a Compose it can run.
///
/// Both halves, in that order, because the second is invisible until the first has succeeded and
/// somebody presses Start. Answers with the sentence for the step row, or a failure in both
/// registers.
pub fn install_engine(cache: &Path) -> Result<String, Problem> {
    install_engine_observed(cache, |_| {})
}

/// Observe an actual Podman installer invocation, excluding existing engines and Compose repair.
pub fn install_engine_observed(
    cache: &Path,
    installed: impl FnMut(bool),
) -> Result<String, Problem> {
    install_engine_with(cache, installed, install_podman, place_compose)
}

fn install_engine_with(
    cache: &Path,
    mut installed: impl FnMut(bool),
    install_podman: impl FnOnce(&Path) -> Result<(), Problem>,
    place_compose: impl FnOnce(&Path) -> Result<String, Problem>,
) -> Result<String, Problem> {
    let into = crate::acquire::download_dir(cache);

    // engine_ready can start an installed Podman machine, but cannot start Docker. A stopped
    // Docker CLI must not skip installing the Podman that preparation will then try to run.
    if engine::program(Engine::Podman).is_some() || engine::program(Engine::Docker).is_some()
    {
        return place_compose(&into);
    }

    let result = install_podman(&into);
    installed(result.is_ok());
    result?;

    place_compose(&into)?;
    Ok(format!("Podman {PODMAN} and Compose {COMPOSE} installed."))
}

/// Place the Compose provider where the engine will find it, unless something already provides one.
///
/// Nothing is placed when Compose already answers. Docker Desktop ships a provider, and a Linux
/// machine may have `docker-compose-v2` from its own packages; putting a second one in front of
/// either is a version somebody did not choose.
fn place_compose(into: &Path) -> Result<String, Problem> {
    let download = compose_download()?;
    let staged = fetch_verified(&download, into)?;

    let bin = engine::tools_dir_under(into);
    std::fs::create_dir_all(&bin).map_err(|error| unwritable(&bin, &error.to_string()))?;

    // The name matters: Podman looks up a provider called `docker-compose`, so a binary called
    // whatever the release asset was called is a provider nothing finds.
    let named = bin.join(compose_provider_name());
    std::fs::copy(&staged, &named).map_err(|error| unwritable(&named, &error.to_string()))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&named, std::fs::Permissions::from_mode(0o755)).map_err(
            |error| {
                Problem::with(
                    "OpenBot could not finish installing the piece that runs the containers.",
                    format!("chmod 755 {}: {error}", named.display()),
                )
            },
        )?;
    }

    Ok(format!("Compose {COMPOSE} installed."))
}

/// The filename Podman looks a provider up by.
pub fn compose_provider_name() -> &'static str {
    if cfg!(windows) {
        "docker-compose.exe"
    } else {
        "docker-compose"
    }
}

#[cfg(target_os = "windows")]
fn install_podman(into: &Path) -> Result<(), Problem> {
    let download = podman_download()?;
    let msi = fetch_verified(&download, into)?;
    let log = into.join("podman-install.log");
    install_podman_msi(&msi, &log, msiexec)
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn install_podman_msi(
    msi: &Path,
    log: &Path,
    mut run: impl FnMut(&[&str], &Path, &Path) -> Result<(), MsiexecFailure>,
) -> Result<(), Problem> {
    match run(&["/i"], msi, log) {
        Ok(()) => return Ok(()),
        // 1603 is "fatal error during installation", which is what Windows says when a product it
        // still believes is installed cannot be repaired. Measured on a machine where a previous
        // Podman had been removed by deleting its folder: the registration survived, so `/i`
        // became a reconfigure, and the reconfigure had no source to read from. Somebody who once
        // uninstalled Podman by dragging it to the bin arrives here.
        Err(MsiexecFailure::Exit(1603)) => {}
        Err(error) => return Err(installer_stopped("/i", msi, error, log)),
    }

    // Remove the registration, then install cleanly. `/x` does not need the original source, so
    // it succeeds where the repair could not. If cleanup itself fails, retrying `/i` only hides the
    // step that left the broken registration behind.
    run(&["/x"], msi, log).map_err(|error| installer_stopped("/x", msi, error, log))?;
    run(&["/i"], msi, log).map_err(|error| installer_stopped("/i", msi, error, log))
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
#[derive(Clone, Debug, PartialEq, Eq)]
enum MsiexecFailure {
    Exit(i32),
    Start(String),
}

/// Run msiexec quietly and answer with its exit code when it is not success.
///
/// `/qn` and not `/passive`: a progress bar somebody cannot cancel is worse than the app's own
/// step, which says what is happening and can be retried. The log is kept because msiexec's exit
/// code alone does not say which action failed, and it is what turned 1603 into a diagnosis.
#[cfg(target_os = "windows")]
fn msiexec(verb: &[&str], msi: &Path, log: &Path) -> Result<(), MsiexecFailure> {
    let output = crate::quiet::command("msiexec")
        .args(verb)
        .arg(msi)
        .args(["/qn", "/norestart", "/l*v"])
        .arg(log)
        .output()
        .map_err(|error| MsiexecFailure::Start(error.to_string()))?;
    if output.status.success() {
        return Ok(());
    }
    Err(MsiexecFailure::Exit(output.status.code().unwrap_or(-1)))
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn installer_stopped(verb: &str, msi: &Path, failure: MsiexecFailure, log: &Path) -> Problem {
    match failure {
        MsiexecFailure::Start(error) => Problem::with(
            "OpenBot could not start the installer for the software it needs. Try again.",
            format!(
                "msiexec {verb} {} could not start: {error}; intended log path is {}",
                msi.display(),
                log.display()
            ),
        ),
        MsiexecFailure::Exit(code) => Problem::with(
            if code == 1625 {
                // ERROR_INSTALL_PACKAGE_REJECTED requires an administrator to resolve policy.
                // https://learn.microsoft.com/en-us/windows/win32/msi/error-codes
                "Windows policy blocks installing Podman, the container engine OpenBot needs. \
                 Ask an administrator to allow the installation or install Podman for your \
                 account, then try again."
            } else {
                "Installing the software OpenBot needs did not finish. Try again."
            },
            format!(
                "msiexec {verb} {} stopped with exit code {code}; its log is at {}",
                msi.display(),
                log.display()
            ),
        ),
    }
}

#[cfg(target_os = "macos")]
fn install_podman(into: &Path) -> Result<(), Problem> {
    let download = podman_download()?;
    let pkg = fetch_verified(&download, into)?;

    // The package writes to `/opt/podman`, which needs administrator rights. `do shell script ...
    // with administrator privileges` is how macOS asks for them: the person sees the standard
    // authorization dialog, and no password passes through this process.
    let script = format!(
        "do shell script \"/usr/sbin/installer -pkg {} -target /\" with administrator privileges",
        applescript_shell_arg(&pkg)
    );
    let output = crate::quiet::command("osascript")
        .args(["-e", &script])
        .output()
        .map_err(|error| {
            Problem::with(
                "OpenBot could not start the installer for the software it needs.",
                format!("osascript: {error}"),
            )
        })?;

    if output.status.success() {
        return Ok(());
    }
    let said = crate::quiet::said(&output.stderr);
    // -128 is AppleScript's "user cancelled", which is a decision rather than a failure.
    if said.contains("-128") {
        return Err(Problem::plain(
            "The install was cancelled, so OpenBot does not have the software it needs yet. Press \
             Start to try again.",
        ));
    }
    Err(Problem::with(
        "Installing the software OpenBot needs did not finish. Try again.",
        said,
    ))
}

/// A path that has to survive being a shell word inside an AppleScript string.
///
/// Two layers, applied in this order: single-quote it for the shell, then escape what AppleScript
/// treats as special in the double-quoted string that carries it.
#[cfg(target_os = "macos")]
fn applescript_shell_arg(path: &Path) -> String {
    let quoted = format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"));
    quoted.replace('\\', "\\\\").replace('"', "\\\"")
}

#[cfg(target_os = "linux")]
fn install_podman(_into: &Path) -> Result<(), Problem> {
    let (manager, args) = linux_package_manager().ok_or_else(|| {
        Problem::with(
            "OpenBot cannot install the software it needs on this system. Install the `podman` \
             package, then start OpenBot again.",
            "no apt-get, dnf, zypper or pacman in /usr/bin",
        )
    })?;

    // `pkexec` rather than `sudo`: sudo on a desktop with no terminal has nowhere to ask for a
    // password, and pkexec raises the desktop's own authorization dialog.
    let output = crate::quiet::command("pkexec")
        .arg(manager)
        .args(args)
        .arg("podman")
        .output()
        .map_err(|error| {
            Problem::with(
                "OpenBot could not start the installer for the software it needs.",
                format!("pkexec {manager}: {error}"),
            )
        })?;

    if output.status.success() {
        return Ok(());
    }
    // pkexec's own refusal. 126 is "not authorized", 127 is "dialog dismissed", and neither is a
    // package manager that failed.
    if matches!(output.status.code(), Some(126) | Some(127)) {
        return Err(Problem::plain(
            "The install was not allowed, so OpenBot does not have the software it needs yet. \
             Press Start to try again.",
        ));
    }
    Err(Problem::with(
        "Installing the software OpenBot needs did not finish. Try again.",
        crate::quiet::said(&output.stderr),
    ))
}

/// The package manager this distribution uses, and the words for "install without asking".
#[cfg(target_os = "linux")]
fn linux_package_manager() -> Option<(&'static str, &'static [&'static str])> {
    for (binary, args) in [
        ("apt-get", &["install", "-y"] as &[&str]),
        ("dnf", &["install", "-y"]),
        ("zypper", &["--non-interactive", "install"]),
        ("pacman", &["-S", "--noconfirm"]),
    ] {
        if Path::new("/usr/bin").join(binary).exists() {
            return Some((binary, args));
        }
    }
    None
}
