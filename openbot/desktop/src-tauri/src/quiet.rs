//! Running a command without putting a console window on somebody's screen.
//!
//! Every shell-out here is a black `conhost` window on Windows unless it is asked not to be.
//! `podman`, `wsl.exe`, `powershell` and `bun` are all console applications, and Windows gives a
//! console application a console: `CreateProcess` allocates one whenever the parent is a GUI
//! process, which the shell is. Redirecting the pipes does not stop it, because the window is
//! allocated before anything is written to.
//!
//! The visible half of this was Stop: `compose down` takes several seconds, so its window had time
//! to be seen, in the foreground, over OpenBot. The rest are quicker and flash instead, once per
//! poll, for the whole of a first run.
//!
//! Unix has no equivalent problem and no equivalent flag, so there the wrapper is the identity.

use std::process::Command;

/// `CREATE_NO_WINDOW`: run the console application without giving it a console.
///
/// Named here rather than pulled from `windows-sys` for one constant that has never moved.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// A command that will not open a window, whatever platform this is.
///
/// Use this instead of `Command::new` everywhere the shell runs another program. The one exception
/// would be a program the person is meant to see, and there is not one.
pub fn command<S: AsRef<std::ffi::OsStr>>(program: S) -> Command {
    // `mut` only matters on Windows; everywhere else the flag block below is compiled away.
    #[allow(unused_mut)]
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

/// What a command said, fit to put in front of somebody.
///
/// Two things make raw stderr the wrong thing to render. Terminal escapes: Podman underlines its
/// own notices, so the card showed a literal `[4m>>>>` before the message on every Linux failure.
/// And Podman's compose shim prefixes *every* invocation, successful or not, with a line naming
/// the external provider it is about to run, so the first thing a person read when the stack
/// failed was a sentence about `docker-compose` that had nothing to do with the failure.
///
/// Only that one known prefix is dropped, and only from the front. Everything else a command says
/// is kept: guessing which of somebody else's lines are unimportant is how real errors disappear.
pub fn said(stderr: &[u8]) -> String {
    let text = String::from_utf8_lossy(stderr);
    let mut clean = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            clean.push(c);
            continue;
        }
        // CSI: ESC [ ... final byte in @-~. Anything else after ESC is a short sequence whose
        // next character is the whole of it.
        match chars.peek() {
            Some('[') => {
                chars.next();
                for inner in chars.by_ref() {
                    if ('@'..='~').contains(&inner) {
                        break;
                    }
                }
            }
            Some(_) => {
                chars.next();
            }
            None => {}
        }
    }

    clean
        .lines()
        .skip_while(|line| {
            line.trim_start()
                .trim_start_matches('>')
                .trim_start()
                .starts_with("Executing external compose provider")
        })
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}
