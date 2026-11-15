//! Windows setup, which is a state machine because it crosses a restart.
//!
//! `wsl --install` needs administrator rights and a reboot. `podman machine init` needs the opposite
//! of the first: WSL refuses to run as LocalSystem
//! (`Wsl/WSL_E_LOCAL_SYSTEM_NOT_SUPPORTED`), so it must run in the signed-in person's own session.
//! Setup therefore cannot be one elevated script, and it cannot be one session either. It is:
//!
//! 1. as the person, decide what is missing;
//! 2. elevated, once, enable the features;
//! 3. restart;
//! 4. as the person again, create and start the machine.
//!
//! The step is written to disk before the restart and read back after, so the app returns to the
//! screen it left rather than starting over. That file is the whole reason this is a module and not
//! three function calls.
//!
//! Verified on Windows Server 2022 during S2: the inbox `wsl.exe` rejects `--no-distribution` as an
//! incorrect parameter and does not understand `--version`, so the current WSL is installed
//! separately rather than assumed.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::problem::Problem;

/// Where setup has got to. Persisted, because step 3 ends the process.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SetupStep {
    /// Nothing done yet.
    Start,
    /// Features asked for; the restart has not happened.
    AwaitingRestart,
    /// Back from the restart, machine not yet created.
    FeaturesReady,
    Done,
}

/// The four named ways this fails, each with its own screen.
///
/// A single "setup failed" is the outcome this exists to prevent: these have different fixes and
/// only one of them is ours to perform.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Blocker {
    /// WSL is not installed at all.
    WslAbsent,
    /// WSL1 is present and has to be converted.
    WslOne,
    /// The features are on but the WSL2 kernel is not there, so nothing can actually run.
    WslNoKernel,
    /// WSL is enabled but the Virtual Machine Platform feature needed by WSL2 is off.
    VirtualMachinePlatformDisabled,
    /// Virtualization is off in firmware. Only the person, in their BIOS, can fix this.
    VirtualizationDisabled,
    /// The account cannot elevate.
    NotAdministrator,
}

impl Blocker {
    /// What the screen says. Each names the specific fix, and the one we cannot perform says so.
    pub fn instruction(self) -> &'static str {
        match self {
            Blocker::VirtualMachinePlatformDisabled => {
                "Virtual Machine Platform is switched off. Open Windows Terminal or PowerShell \
                 as an administrator, run `dism.exe /online /enable-feature \
                 /featurename:VirtualMachinePlatform /all /norestart`, restart Windows, and \
                 start OpenBot again."
            }
            // Says what to run, because OpenBot does not do it. The screen used to say "OpenBot
            // can install it", and nothing in this application installs anything: there is no
            // button under the sentence and no code behind one. Somebody read that, waited, and
            // had been told to wait for something that was never going to happen.
            Blocker::WslAbsent => {
                "Windows Subsystem for Linux is not installed. Open Windows Terminal or PowerShell \
                 as an administrator, run `wsl --install`, restart Windows, and start OpenBot \
                 again."
            }
            Blocker::WslOne => {
                "Windows Subsystem for Linux is at version 1. Open Windows Terminal or PowerShell \
                 as an administrator, run `wsl --set-default-version 2`, restart Windows, and \
                 start OpenBot again."
            }
            // Measured on Windows Server 2022. `wsl --install` enabled both features and stopped
            // there, leaving the inbox WSL with no kernel, and `Get-WindowsOptionalFeature` says
            // Enabled for exactly that state. Nothing looked wrong until `podman machine init`
            // died on `wsl --import ... --version 2` with `exit status 0xffffffff`, which is not
            // a sentence anybody can act on.
            Blocker::WslNoKernel => {
                "Windows Subsystem for Linux is switched on but its Linux kernel is missing, so \
                 nothing can run inside it yet. Open Windows Terminal or PowerShell as an \
                 administrator, run `wsl --update`, restart Windows, and start OpenBot again."
            }
            Blocker::VirtualizationDisabled => {
                "Virtualization is switched off in this machine's firmware. It has to be turned on \
                 there, which OpenBot cannot do: restart, open the firmware settings, and enable \
                 Intel VT-x or AMD-V."
            }
            Blocker::NotAdministrator => {
                "Setting up Windows Subsystem for Linux needs administrator rights. Ask an \
                 administrator to open Windows Terminal or PowerShell as an administrator and run \
                 `dism.exe /online /enable-feature \
                 /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart`, \
                 `dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart`, \
                 and `wsl --install`. Restart Windows, then start OpenBot again in your own account."
            }
        }
    }

    /// Whether the shell can clear this itself. Two of the four are ours; two are not.
    /// Whether OpenBot could fix this itself, one day.
    ///
    /// Nothing acts on this yet. `wsl --install` needs elevation and a restart, and the resumable
    /// state machine that would carry somebody across that reboot is designed and not built, so
    /// every blocker screen currently tells a person what to run. Kept because the two halves are
    /// genuinely different: WSL is installable and a firmware setting is not.
    pub fn ours_to_fix(self) -> bool {
        matches!(
            self,
            Blocker::WslAbsent
                | Blocker::WslOne
                | Blocker::WslNoKernel
                | Blocker::VirtualMachinePlatformDisabled
        )
    }
}

/// Query the same current-user WSL registry value that upstream uses for the default version.
fn default_wsl_version_probe_command() -> &'static str {
    r#"$ErrorActionPreference = 'Stop';
$path = 'Software\Microsoft\Windows\CurrentVersion\Lxss';
$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($path);
if ($null -eq $key) { 2; return }
try {
  $value = $key.GetValue('DefaultVersion', $null);
  if ($null -eq $value) { 2; return }
  if ($value -isnot [int]) { throw 'DefaultVersion is not a registry DWORD' }
  $value
} finally {
  $key.Dispose()
}"#
}

fn parse_default_wsl_version(operation: &str, output: &str) -> Result<u8, Problem> {
    match output.trim() {
        "1" => Ok(1),
        "2" => Ok(2),
        other => Err(detection_failed(
            operation,
            format!("Expected default WSL version 1 or 2; probe returned: {other}"),
        )),
    }
}

/// Whether WSL has a kernel to run, given what `wsl --version` said and whether the kernel file
/// that the update package installs is on disk.
///
/// Both are asked because either alone is wrong. `wsl --version` is absent from the older inbox
/// `wsl.exe` on builds where WSL2 nevertheless works perfectly, having had its kernel installed by
/// the standalone update package, so refusing on that alone would block a machine that is fine.
/// The kernel file alone is not enough either: a modern WSL reports its kernel version without
/// that path necessarily being the one in use.
///
/// So this only says "no kernel" when **neither** answers, which is the state actually measured on
/// a Server 2022 machine where `wsl --install` had enabled the features and done nothing else.
/// The caller must check probe success first: command failure is not evidence of a missing kernel.
pub fn wsl_kernel_present(version_output: &str, kernel_file_exists: bool) -> bool {
    if kernel_file_exists {
        return true;
    }
    let component = |line: &str, dotted: bool| {
        line.split_once([':', '：']).is_some_and(|(label, value)| {
            let value = value.trim();
            let (numbers, suffix) = value.split_once('-').unwrap_or((value, ""));
            !label.trim().is_empty()
                && (!dotted || numbers.contains('.'))
                && numbers
                    .split('.')
                    .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
                && (!value.contains('-')
                    || (!suffix.is_empty()
                        && suffix.bytes().all(|byte| {
                            byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.')
                        })))
        })
    };
    // Keep compact English responses, but a label without a version is not positive evidence.
    if version_output.lines().any(|line| {
        line.split_once(':')
            .is_some_and(|(label, _)| label.trim().eq_ignore_ascii_case("kernel version"))
            && component(line, false)
    }) {
        return true;
    }
    // Microsoft's MessagePackageVersions places WSL then kernel first in all shipped locales
    // Only labels and
    // punctuation vary. Require both dotted values; unrelated prose or a lone version is not enough.
    let mut rows = version_output
        .lines()
        .filter(|line| !line.trim().is_empty());
    let (Some(wsl), Some(kernel)) = (rows.next(), rows.next()) else {
        return false;
    };
    wsl.split_once([':', '：']).is_some_and(|(label, _)| {
        label
            .split(|character: char| !character.is_ascii_alphanumeric())
            .any(|word| word.eq_ignore_ascii_case("WSL"))
    }) && kernel
        .split_once([':', '：'])
        .is_some_and(|(label, _)| !label.contains("WSL"))
        && component(wsl, true)
        && component(kernel, true)
}

pub fn state_path(data_dir: &Path) -> PathBuf {
    data_dir.join("windows-setup.json")
}

pub fn read_step(data_dir: &Path) -> SetupStep {
    std::fs::read_to_string(state_path(data_dir))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or(SetupStep::Start)
}

pub fn write_step(data_dir: &Path, step: SetupStep) -> std::io::Result<()> {
    std::fs::create_dir_all(data_dir)?;
    std::fs::write(
        state_path(data_dir),
        serde_json::to_string(&step).unwrap_or_default(),
    )
}

/// Read the machine and say which of the four, if any, is in the way.
///
/// Order matters. Firmware virtualization is checked first because nothing else can be fixed while
/// it is off, and telling somebody to install WSL when their BIOS will not allow a VM wastes a
/// restart to arrive at the same place.
/// Whether this machine can run a virtual machine, from the two things Windows will say about it.
///
/// Either answer is enough. `VirtualizationFirmwareEnabled` reports False once a hypervisor has
/// claimed the extensions, which is exactly the state of a machine where WSL2 already works, so
/// asking only that sends everybody running Hyper-V to a screen telling them to switch on a
/// firmware setting that is already on. Measured on Windows Server 2022: firmware False,
/// hypervisor True.
// Only `blocker` calls it, and only on Windows, but the rule is pure and the test that pins it
// should run everywhere rather than on the one platform nobody runs the tests on.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn virtualization_available(hypervisor_present: bool, firmware_enabled: bool) -> bool {
    hypervisor_present || firmware_enabled
}

#[cfg(target_os = "windows")]
pub fn blocker() -> Result<Option<Blocker>, Problem> {
    blocker_with(
        |program, args| crate::quiet::command(program).args(args).output(),
        || {
            let root = std::env::var_os("SystemRoot")
                .filter(|root| !root.is_empty())
                .ok_or_else(|| {
                    detection_failed("the WSL kernel file", "SystemRoot is missing or empty")
                })?;
            let path = Path::new(&root).join(r"System32\lxss\tools\kernel");
            match std::fs::metadata(&path) {
                Ok(metadata) if metadata.is_file() => Ok(true),
                Ok(_) => Err(detection_failed(
                    "the WSL kernel file",
                    format!("{} is not a file", path.display()),
                )),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
                Err(error) => Err(detection_failed(
                    "the WSL kernel file",
                    format!("{}: {error}", path.display()),
                )),
            }
        },
    )
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn detection_failed(operation: &str, detail: impl Into<String>) -> Problem {
    Problem::with(
        format!("OpenBot could not check {operation}. Close and reopen OpenBot to try again."),
        detail,
    )
}

/// Inspect the exit status before interpreting stdout as a machine state. Keep both streams:
/// wsl.exe can put its diagnostic on stdout, and a failed PowerShell pipeline can have partial output.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn probe_text(
    operation: &str,
    output: std::io::Result<std::process::Output>,
) -> Result<String, Problem> {
    let output = output
        .map_err(|error| detection_failed(operation, format!("Could not start probe: {error}")))?;
    let stdout = decode_probe_text(&output.stdout);
    let stderr = decode_probe_text(&output.stderr);
    if !output.status.success() {
        // Decoding failures are diagnostics too; retain the bytes if they were not valid text.
        let stdout = stdout.unwrap_or_else(|error| format!("{error}: {:?}", output.stdout));
        let stderr = stderr.unwrap_or_else(|error| format!("{error}: {:?}", output.stderr));
        return Err(detection_failed(
            operation,
            format!(
                "Probe exited with {}\nstdout:\n{stdout}\nstderr:\n{stderr}",
                output.status
            ),
        ));
    }
    let stdout = stdout.map_err(|error| {
        detection_failed(operation, format!("Could not decode probe stdout: {error}"))
    })?;
    let stderr = stderr.map_err(|error| {
        detection_failed(operation, format!("Could not decode probe stderr: {error}"))
    })?;
    if stdout.trim().is_empty() {
        return Err(detection_failed(
            operation,
            format!("Probe returned empty output.\nstderr:\n{stderr}"),
        ));
    }
    Ok(stdout.trim().to_string())
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn decode_probe_text(bytes: &[u8]) -> Result<String, String> {
    // wsl.exe writes UTF-16LE to redirected pipes on inbox builds. Stripping NUL bytes corrupts
    // non-ASCII diagnostics; PowerShell's ASCII boolean results and modern UTF-8 also work here.
    if bytes.starts_with(&[0xff, 0xfe]) || bytes.contains(&0) {
        let bytes = bytes.strip_prefix(&[0xff, 0xfe]).unwrap_or(bytes);
        if bytes.len() % 2 != 0 {
            return Err("Truncated UTF-16 probe output".into());
        }
        let units = bytes
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect::<Vec<_>>();
        String::from_utf16(&units).map_err(|error| error.to_string())
    } else {
        String::from_utf8(bytes.to_vec()).map_err(|error| error.to_string())
    }
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn probe_bool(operation: &str, output: &str) -> Result<bool, Problem> {
    match output.trim().to_ascii_lowercase().as_str() {
        "true" => Ok(true),
        "false" => Ok(false),
        _ => Err(detection_failed(
            operation,
            format!("Expected True or False; probe returned: {output}"),
        )),
    }
}

/// Local WMI reads work in the signed-in user's token; the DISM cmdlet
/// Get-WindowsOptionalFeature requires elevation even when it only reads state.
fn optional_feature_probe_command(feature: &str) -> String {
    format!(
        "$ErrorActionPreference = 'Stop'; \
         $features = @(Get-CimInstance -ClassName Win32_OptionalFeature -Filter \"Name = '{feature}'\"); \
         if ($features.Count -ne 1 -or $null -eq $features[0].InstallState) {{ \
           throw '{feature} query did not return one feature state' \
         }}; \
         $features[0].InstallState"
    )
}

fn probe_feature_enabled(operation: &str, output: &str) -> Result<bool, Problem> {
    // https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-optionalfeature
    // Unknown (4) is not evidence that a feature is disabled.
    match output.trim() {
        "1" => Ok(true),
        "2" | "3" => Ok(false),
        _ => Err(detection_failed(
            operation,
            format!("Expected InstallState 1 (enabled), 2 (disabled), or 3 (absent); probe returned: {output}"),
        )),
    }
}

fn modern_wsl_probe_command() -> &'static str {
    "$ErrorActionPreference = 'Stop'; \
     $null -ne (Get-CimInstance -ClassName Win32_Service -Filter \"Name = 'WslService'\")"
}

/// The native adapter above only supplies process execution and the legacy kernel-file check.
/// Keeping the decision path shared lets failure tests run without touching Windows components.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn blocker_with(
    mut run: impl FnMut(&str, &[&str]) -> std::io::Result<std::process::Output>,
    kernel_file_exists: impl FnOnce() -> Result<bool, Problem>,
) -> Result<Option<Blocker>, Problem> {
    // A running hypervisor is positive virtualization evidence even when firmware reports False.
    // Stop converts CIM non-terminating errors into failed probes instead of partial answers.
    let virtualization = "Windows virtualization support (powershell)";
    let reported = probe_text(
        virtualization,
        run(
            "powershell",
            &[
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "$ErrorActionPreference = 'Stop'; \
         'hypervisor=' + (Get-CimInstance Win32_ComputerSystem).HypervisorPresent; \
         'firmware=' + ((Get-CimInstance Win32_Processor | \
           ForEach-Object { $_.VirtualizationFirmwareEnabled }) -contains $true)",
            ],
        ),
    )?;
    let lines: Vec<_> = reported.lines().map(str::trim).collect();
    let [hypervisor, firmware] = lines.as_slice() else {
        return Err(detection_failed(
            virtualization,
            format!("Unexpected probe output: {reported}"),
        ));
    };
    let hypervisor = hypervisor.strip_prefix("hypervisor=").ok_or_else(|| {
        detection_failed(
            virtualization,
            format!("Missing hypervisor result: {reported}"),
        )
    })?;
    let firmware = firmware.strip_prefix("firmware=").ok_or_else(|| {
        detection_failed(
            virtualization,
            format!("Missing firmware result: {reported}"),
        )
    })?;
    if !virtualization_available(
        probe_bool(virtualization, hypervisor)?,
        probe_bool(virtualization, firmware)?,
    ) {
        return Ok(Some(Blocker::VirtualizationDisabled));
    }

    let administrator = "Windows administrator rights (powershell)";
    let elevated = probe_bool(administrator, &probe_text(administrator, run("powershell", &[
        "-NoProfile", "-NonInteractive", "-Command",
        "$ErrorActionPreference = 'Stop'; \
         ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
    ]))?)?;

    let wsl_feature = "the WSL feature state (powershell)";
    let enabled = probe_feature_enabled(
        wsl_feature,
        &probe_text(
            wsl_feature,
            run(
                "powershell",
                &[
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    &optional_feature_probe_command("Microsoft-Windows-Subsystem-Linux"),
                ],
            ),
        )?,
    )?;
    if !enabled {
        // Modern WSL2 uses WslService and does not require the legacy WSL1 optional component.
        // https://learn.microsoft.com/en-us/windows/wsl/faq#was-lxssmanager-replaced-by-wslservice
        // Service presence only establishes installation; VMP and kernel health are checked below.
        let modern_wsl = "the WSL service (powershell)";
        let installed = probe_bool(
            modern_wsl,
            &probe_text(
                modern_wsl,
                run(
                    "powershell",
                    &[
                        "-NoProfile",
                        "-NonInteractive",
                        "-Command",
                        modern_wsl_probe_command(),
                    ],
                ),
            )?,
        )?;
        if !installed {
            return Ok(Some(if elevated {
                Blocker::WslAbsent
            } else {
                Blocker::NotAdministrator
            }));
        }
    }

    let vmp_feature = "the Virtual Machine Platform feature state (powershell)";
    let enabled = probe_feature_enabled(
        vmp_feature,
        &probe_text(
            vmp_feature,
            run(
                "powershell",
                &[
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    &optional_feature_probe_command("VirtualMachinePlatform"),
                ],
            ),
        )?,
    )?;
    if !enabled {
        return Ok(Some(if elevated {
            Blocker::VirtualMachinePlatformDisabled
        } else {
            Blocker::NotAdministrator
        }));
    }

    let default_version = "the default WSL version (registry)";
    let default_version = parse_default_wsl_version(
        default_version,
        &probe_text(
            default_version,
            run(
                "powershell",
                &[
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    default_wsl_version_probe_command(),
                ],
            ),
        )?,
    )?;
    if default_version == 1 {
        return Ok(Some(Blocker::WslOne));
    }

    // Inbox WSL predates --version. A positively inspected kernel file is enough, so do not run
    // an unsupported command in that case. An executed probe failing is never "no kernel".
    if kernel_file_exists()? {
        return Ok(None);
    }
    let version_output = probe_text(
        "the WSL version (wsl.exe --version)",
        run("wsl.exe", &["--version"]),
    )?;
    if !wsl_kernel_present(&version_output, false) {
        return Ok(Some(Blocker::WslNoKernel));
    }
    Ok(None)
}

#[cfg(not(target_os = "windows"))]
pub fn blocker() -> Result<Option<Blocker>, Problem> {
    Ok(None)
}
