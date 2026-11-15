//! Metrics for an explicit image pull, before containers or provider sign-in start.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Command, Output, Stdio};
use std::sync::mpsc::{sync_channel, SyncSender};
use std::time::Instant;

use serde::Deserialize;

use crate::engine::Address;
use crate::problem::Problem;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Success,
    Failure,
}

/// No image names, layer IDs, engine output, or credentials cross this boundary.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PullMetrics {
    pub outcome: Outcome,
    /// Wall time of the pull command, excluding capability detection and container startup.
    pub duration_ms: u64,
    /// Download counters actually observed. None means the provider supplied no byte counters.
    /// This excludes extraction, cached image sizes, and unobserved bytes between progress updates.
    pub bytes: Option<u64>,
}

#[derive(Deserialize)]
struct Progress {
    id: String,
    parent_id: Option<String>,
    text: String,
    current: Option<u64>,
}

#[derive(Default)]
struct DownloadBytes(HashMap<String, u64>);

impl DownloadBytes {
    fn observe(&mut self, progress: Progress) {
        if progress.text == "Downloading"
            && !progress.id.is_empty()
            && !progress.parent_id.as_deref().unwrap_or_default().is_empty()
        {
            if let Some(current) = progress.current {
                self.0
                    .entry(progress.id)
                    .and_modify(|maximum| *maximum = (*maximum).max(current))
                    .or_insert(current);
            }
        }
    }

    fn total(&self) -> Option<u64> {
        if self.0.is_empty() {
            return None;
        }
        self.0
            .values()
            .try_fold(0_u64, |sum, current| sum.checked_add(*current))
    }
}

/// Compose's JSON writer carries Docker's byte counters as integers:
/// https://github.com/docker/compose/blob/v2.39.2/pkg/compose/pull.go#L391-L440
/// The same layer can appear beneath multiple services. Keep its maximum download counter,
/// regardless of parent, and never add extraction progress or the advertised total size.
fn download_bytes(stdout: &[u8], stderr: &[u8]) -> Option<u64> {
    let mut layers = DownloadBytes::default();
    for output in [stdout, stderr] {
        for line in output.split(|byte| *byte == b'\n') {
            let Ok(progress) = serde_json::from_slice::<Progress>(line) else {
                continue;
            };
            layers.observe(progress);
        }
    }
    layers.total()
}

/// Pull an image using the selected container CLI.
pub fn pull_image(
    engine: &Address,
    image: &str,
    on_progress: impl FnMut(u64),
    on_complete: impl FnOnce(PullMetrics),
) -> Result<(), Problem> {
    let mut command = engine.command();
    command.args(["pull", image]);
    run_with_progress(command, None, false, on_progress, on_complete)
}

fn run_with_progress(
    mut command: Command,
    input: Option<&[u8]>,
    json_progress: bool,
    mut on_progress: impl FnMut(u64),
    on_complete: impl FnOnce(PullMetrics),
) -> Result<(), Problem> {
    command
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let started = Instant::now();
    let output = (|| {
        let mut child = command.spawn()?;
        if let Some(input) = input {
            let result = child
                .stdin
                .take()
                .expect("piped pull stdin")
                .write_all(input);
            if let Err(error) = result {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        }
        // Drain both pipes concurrently, just as wait_with_output does, while forwarding only
        // structured byte counters. Raw engine output stays in the existing error diagnostics.
        let stdout = child.stdout.take().expect("piped pull stdout");
        let stderr = child.stderr.take().expect("piped pull stderr");
        std::thread::scope(|scope| {
            let (sender, receiver) = sync_channel(64);
            let stdout_sender = sender.clone();
            let out = scope.spawn(move || read_output(stdout, json_progress, stdout_sender));
            let err = scope.spawn(move || read_output(stderr, json_progress, sender));
            let mut layers = DownloadBytes::default();
            let mut last = None;
            for progress in receiver {
                layers.observe(progress);
                let total = layers.total();
                if total != last {
                    if let Some(bytes) = total {
                        on_progress(bytes);
                    }
                    last = total;
                }
            }
            let stdout = out
                .join()
                .map_err(|_| std::io::Error::other("pull stdout reader panicked"));
            let stderr = err
                .join()
                .map_err(|_| std::io::Error::other("pull stderr reader panicked"));
            // Always reap the child, including when reading a pipe failed.
            let status = child.wait()?;
            Ok(Output {
                status,
                stdout: stdout??,
                stderr: stderr??,
            })
        })
    })();
    let duration_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
    let success = output.as_ref().is_ok_and(|output| output.status.success());
    let bytes = if json_progress {
        output
            .as_ref()
            .ok()
            .and_then(|output| download_bytes(&output.stdout, &output.stderr))
    } else {
        None
    };
    on_complete(PullMetrics {
        outcome: if success {
            Outcome::Success
        } else {
            Outcome::Failure
        },
        duration_ms,
        bytes,
    });
    let output = output.map_err(|error| {
        Problem::plain(format!("Could not pull the images OpenBot needs: {error}"))
    })?;
    if output.status.success() {
        return Ok(());
    }
    let raw = crate::quiet::said(if output.stderr.is_empty() {
        &output.stdout
    } else {
        &output.stderr
    });
    Err(Problem::with(crate::problem::said_about(&raw), raw))
}

fn read_output(
    pipe: impl Read,
    json_progress: bool,
    sender: SyncSender<Progress>,
) -> std::io::Result<Vec<u8>> {
    let mut reader = BufReader::new(pipe);
    let mut output = Vec::new();
    let mut line = Vec::new();
    loop {
        line.clear();
        if reader.read_until(b'\n', &mut line)? == 0 {
            return Ok(output);
        }
        output.extend_from_slice(&line);
        if json_progress {
            if let Ok(progress) = serde_json::from_slice(&line) {
                sender
                    .send(progress)
                    .map_err(|_| std::io::Error::other("pull progress receiver closed"))?;
            }
        }
    }
}
