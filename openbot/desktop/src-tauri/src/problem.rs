//! What a person is told when something fails, and what a developer is told at the same time.
//!
//! TWO PARTS, ALWAYS, and this exists because one part is never enough for both readers. The
//! person needs a sentence about their situation and what to do next; whoever is debugging needs
//! the actual output, verbatim, including the bits that are only meaningful to them. Collapse them
//! and one of the two is failed: a plain sentence alone throws away the evidence, and raw engine
//! output alone is what put "pull access denied for openbot-agent-langgraph-agui, repository does
//! not exist or may require 'docker login'" in front of somebody who was setting up an app.
//!
//! The window shows `said` as the failure and keeps `detail` behind a disclosure, so the default
//! reading is the human one and nothing is lost.

use serde::Serialize;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Connection {
    Model,
}

/// A failure, in both registers.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct Problem {
    /// For the person. Their situation, and the next thing they can do about it.
    pub said: String,
    /// For whoever is debugging. Verbatim, and never shown as the headline.
    ///
    /// `None` where the plain sentence IS the whole truth — a refusal this deployment decided, with
    /// no underlying output behind it.
    pub detail: Option<String>,
    /// The credential operation that failed, never inferred from provider log text.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connection: Option<Connection>,
}

impl Problem {
    /// A refusal this deployment made itself, where there is nothing underneath to show.
    pub fn plain(said: impl Into<String>) -> Self {
        Self {
            said: said.into(),
            detail: None,
            connection: None,
        }
    }

    /// A sentence for the person, with the real output kept beside it.
    pub fn with(said: impl Into<String>, detail: impl Into<String>) -> Self {
        let detail = detail.into();
        Self {
            said: said.into(),
            detail: (!detail.trim().is_empty()).then_some(detail),
            connection: None,
        }
    }

    pub fn connection(mut self, connection: Connection) -> Self {
        self.connection = Some(connection);
        self
    }
}

/*
 * Every error that is still a bare string becomes a plain problem.
 *
 * So `?` keeps working on the paths that have not been given a sentence yet, and those read exactly
 * as they did before rather than losing their message during the conversion. What it does NOT do is
 * let a raw engine dump masquerade as a sentence: `said_about` below is what turns one of those into
 * both halves, and the call sites that produce engine output use it.
 */
impl From<String> for Problem {
    fn from(said: String) -> Self {
        Self::plain(said)
    }
}

impl From<&str> for Problem {
    fn from(said: &str) -> Self {
        Self::plain(said)
    }
}

/**
A sentence for engine output, chosen by what the output actually says.

Pure and tested, because these are the failures a first run hits and the sentence is the only part
the person reads. Anything unrecognised keeps a general sentence rather than a guess: being vague is
fixable, and being confidently wrong about somebody's machine is not.
*/
pub fn said_about(output: &str) -> String {
    let lower = output.to_lowercase();

    // The one this was written for. A pull that is refused reads as a permissions problem, and is
    // almost always an image this release did not publish.
    if lower.contains("pull access denied")
        || lower.contains("repository does not exist")
        || lower.contains("manifest unknown")
        || lower.contains("not found: manifest")
    {
        return "OpenBot could not download one of the parts it needs. That version may not have \
                been published yet. Check for an OpenBot update, and try again."
            .into();
    }
    if lower.contains("port is already allocated") || lower.contains("address already in use") {
        return "Something else on this computer is using a port OpenBot needs. Close it, or \
                restart the computer, and try again."
            .into();
    }
    if lower.contains("no space left") {
        return "This computer has run out of disk space, so OpenBot could not finish. Free some \
                space and try again."
            .into();
    }
    if lower.contains("cannot connect")
        || lower.contains("is the docker daemon running")
        || lower.contains("connection refused")
    {
        return "OpenBot cannot reach the container engine. Start Docker or Podman, wait for it to \
                finish starting, and try again."
            .into();
    }
    if lower.contains("timeout") || lower.contains("timed out") {
        return "That took too long and stopped. It is usually a slow or interrupted connection, \
                so trying again often works."
            .into();
    }
    if lower.contains("unauthorized") || lower.contains("permission denied") {
        return "OpenBot was refused permission for something it needed. The details below say \
                what, and are worth sending to whoever set this up."
            .into();
    }

    "Something went wrong while setting OpenBot up. The details below are worth sending to \
     whoever set this up."
        .into()
}
