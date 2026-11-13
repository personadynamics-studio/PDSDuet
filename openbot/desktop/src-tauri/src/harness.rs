//! The harness picker's list, as data.
//!
//! One list, and every row resolves to the same thing: an AG-UI URL registered as a Bot. A row is
//! a manifest rather than a branch in wizard code, so adding a harness is an entry here plus an
//! image, and never a new screen.
//!
//! Two things this list deliberately does not contain. OpenBot's own `built-in` agent type, which
//! is a system prompt and not a harness: everybody leaves setup with a real one, either an image we
//! publish or an address they already run. And anything whose AG-UI integration we would have to
//! write ourselves. A harness earns a row only when the integration exists and somebody other than
//! us keeps it working, which is why Codex and Gemini CLI are absent despite being the two most
//! popular harnesses there are.
//!
//! Rows and maintainer classes come from the AG-UI repository's own support table, which is
//! canonical. `docs.ag-ui.com` disagrees on several and is wrong.

use serde::{Deserialize, Serialize};

/// Who keeps the AG-UI integration working.
///
/// Recorded because it is what the no-adapters rule is decided on, not because it ranks anything.
/// "Community" does not mean strangers: `integrations/claude-agent-sdk` lives in the AG-UI
/// repository and its history is largely CopilotKit's own people. It means the model vendor does
/// not maintain it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Maintainer {
    FirstParty,
    Partnership,
    Community,
}

/// What a harness needs before it can answer.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Credential {
    /// Any provider the model screen offers. The choice is the person's and this constrains it not
    /// at all.
    AnyProvider,
    /// Anthropic, and therefore the one row where a subscription can stand in for a key.
    ///
    /// Not because the SDK cannot reach another model: `ANTHROPIC_BASE_URL` aimed at a gateway that
    /// speaks the Anthropic Messages API runs GPT or Gemini through it perfectly well. It is that a
    /// *subscription* only ever buys its own vendor's models, and this is the row where the
    /// subscription path exists.
    Anthropic,
    /// Google, and only Google.
    ///
    /// Separate from `AnyProvider` because Antigravity's bundled harness requires a Gemini key
    /// wherever its base url points — the SDK's own README is explicit about it. Offered as
    /// "any provider you already have", it would install against an OpenAI-only deployment and
    /// answer nothing, which is the failure `webCreate` exists to prevent on the web side.
    Google,
    /// The person's own endpoint. Nothing is installed and no key is ours to ask for.
    TheirEndpoint,
}

/// One row.
/**
Which Bot can use a signed-in subscription, by vendor.

THE CONSTRAINT IS ON THE LOGIN, NOT THE FRAMEWORK, and this is where that bites. Every harness on
the list takes any model through an API key, so the Bot step and the model step are independent
there. A subscription is different: it only ever buys that vendor's own models, and only through a
path that speaks that vendor's subscription auth. Anthropic's is the Claude Agent SDK, which reads
`CLAUDE_CODE_OAUTH_TOKEN`; OpenAI's is the Codex model, which the LangGraph AG-UI image selects from
the token store.

MEASURED, on the screen built to catch it: signing in to a Claude plan and keeping the default Bot
produced a stack that came up clean and a Bot whose own log said "Missing credentials. Please pass
an `api_key`". The last screen showed the failure, which is what it is for, but the person had done
nothing wrong and had no way to know which of two correct-looking answers to change.

Nobody is asked to know this. The plan picks the Bot that can use it.
*/
pub fn speaking_for(provider: &str) -> Option<&'static str> {
    match provider {
        "anthropic" => Some("claude-agent-sdk"),
        "openai" => Some("langgraph"),
        _ => None,
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Harness {
    pub id: String,
    pub name: String,
    pub summary: String,
    /// The published name of the image that speaks AG-UI. Resolved to a digest-pinned reference
    /// through the release's manifest; see `crate::deployment::reference`.
    ///
    /// `None` only for the row where the person supplies the address.
    pub image: Option<String>,
    /// Where the container says it is ready.
    pub health_path: Option<String>,
    /// Where AG-UI run requests are served inside the harness.
    ///
    /// Empty means the server root. Readiness stays in `health_path` because Compose polls that
    /// before a run token exists.
    pub run_path: String,
    /// The port the image listens on, which differs per harness and is fixed by its Dockerfile.
    ///
    /// Carried because the one compose service that runs the picked harness has to be told, and
    /// because the endpoint the Bot is registered at is built from it. `None` only for the row where
    /// the person supplies the address.
    pub port: Option<u16>,
    pub credential: Credential,
    pub maintainer: Maintainer,
    /// The vendored mark's file stem, or `None` where no maintained set has one.
    ///
    /// A row with `None` shows its name alone. Nothing is drawn to fill the gap: see
    /// `desktop/src/marks/README.md` for why an invented monogram is the one thing that would be a
    /// problem. The name is on every row regardless, so an unmarked row is not a lesser one.
    pub mark: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessChoice {
    pub id: String,
    #[serde(default)]
    pub agent_url: Option<String>,
}

fn byo_remote_ag_ui_url(value: &str) -> Result<String, String> {
    if value.chars().any(char::is_control) {
        return Err("Enter a valid http:// or https:// address for the agent endpoint.".into());
    }
    let trimmed = value.trim();
    let parsed = reqwest::Url::parse(trimmed).map_err(|_| {
        "Enter a valid http:// or https:// address for the agent endpoint.".to_string()
    })?;
    if matches!(parsed.scheme(), "http" | "https") && parsed.has_host() {
        Ok(trimmed.into())
    } else {
        Err("Enter a valid http:// or https:// address for the agent endpoint.".into())
    }
}

/// The list, ranked as the build doc ranks it: stars first, with downloads as the sanity check,
/// because each misleads alone.
///
/// Anything the AG-UI table marks In Progress is left out. OpenAI's Agents SDK, AWS Bedrock Agents
/// and Cloudflare Agents are all In Progress, and a picker that offers a harness which cannot yet
/// answer is worse than a shorter picker.
///
/// Mastra is here on different terms from the rest, and the difference is in the server rather than
/// in this list. Every other row is an image serving an AG-UI route; Mastra's image is a plain
/// Mastra server, and OpenBot dials it through `getRemoteAgents` from `@ag-ui/mastra`, the bridge
/// Mastra and AG-UI maintain between them. See `remoteTransport` in server/src/copilot.ts.
///
/// It reads as a harness like any other because the difference ends at the transport: a Mastra Bot
/// arrives as the same `AbstractAgent` and is governed by the same wrapper as an AG-UI one. What
/// this list still refuses is writing that translation by hand, which is what mounting
/// `registerCopilotKit` in the harness amounted to: that route serves the CopilotKit Runtime
/// protocol, not AG-UI, and a run reached it and came back asking for a `method` field.
pub fn catalogue() -> Vec<Harness> {
    /*
     * Read from `shared/harnesses.json`, the one file every language reads, rather than written
     * here. The web app's New Bot dialog names the same frameworks, and a second copy of this list
     * would drift — which matters more than for most lists, because this one carries other
     * companies' trade marks and the rules in `shared/marks/README.md` about what may be drawn for
     * them.
     *
     * Baked in with `include_str!` rather than read at runtime: the setup window draws before it
     * has a working directory it can rely on, and a catalogue that can fail to load is a catalogue
     * that can leave the picker empty on a first run with nothing on screen to say why.
     */
    #[derive(Deserialize)]
    struct CatalogFile {
        harnesses: Vec<CatalogRow>,
    }

    /*
     * Its own struct rather than deserializing `Harness` directly, because the two shapes differ on
     * purpose. The file is camelCase, which is what the web app reads; `Harness` is snake_case,
     * which is what the Tauri command has always sent `desktop/src/HarnessPicker.tsx`. Renaming
     * `Harness` to match the file would change that wire format for a UI that declares
     * `health_path`. Unknown keys — `_readme`, and the web-only `webSummary` and `webCreate` — are
     * ignored by serde, which is what lets the web app add a field without touching this.
     */
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct CatalogRow {
        id: String,
        name: String,
        summary: String,
        image: Option<String>,
        port: Option<u16>,
        health_path: Option<String>,
        run_path: String,
        credential: Credential,
        maintainer: Maintainer,
        mark: Option<String>,
    }

    let file: CatalogFile = serde_json::from_str(include_str!("../../../shared/harnesses.json"))
        .expect("shared/harnesses.json is baked in at build time and must parse");

    file.harnesses
        .into_iter()
        .map(|row| Harness {
            id: row.id,
            name: row.name,
            summary: row.summary,
            image: row.image,
            health_path: row.health_path,
            run_path: row.run_path,
            port: row.port,
            credential: row.credential,
            maintainer: row.maintainer,
            mark: row.mark,
        })
        .collect()
}

/**
Which harness a picked id means, as the settings it implies.

Extracted from `start_stack` so the refusals can be tested. Each one is a real state: a window that
sends an id this build does not have (a downgrade, or a stale page), and the row that installs
nothing because the person is bringing their own address.

An unknown id is refused here rather than written into `.env`, where it would become a Bot pointing
at a container nobody started — which looks like a broken Bot rather than a bad pick.
*/
pub fn picked(
    choice: Option<&HarnessChoice>,
    // Where the deployment is, because the image reference is read from the manifest laid down
    // beside it. A name built from a version was what this took before, and an unqualified name
    // sends every engine to Docker Hub: the pull was refused there and the person was shown a
    // registry permissions error for a repository that had never been pushed.
    root: &std::path::Path,
) -> Result<Option<crate::env::PickedHarness>, String> {
    let Some(choice) = choice else {
        return Ok(None);
    };
    let id = choice.id.trim();
    if id.is_empty() {
        return Ok(None);
    };
    let row = catalogue()
        .into_iter()
        .find(|row| row.id == id)
        .ok_or_else(|| format!("There is no Bot called \"{id}\" to install."))?;
    if row.id == "byo-url" {
        let url = choice
            .agent_url
            .as_deref()
            .ok_or_else(|| {
                "Enter a valid http:// or https:// address for the agent endpoint.".to_string()
            })
            .and_then(byo_remote_ag_ui_url)?;
        return Ok(Some(crate::env::PickedHarness::RemoteAgUi {
            url,
            name: row.name,
            remote_agent_id: String::new(),
        }));
    }
    let (Some(image), Some(port)) = (row.image, row.port) else {
        return Err(format!("\"{id}\" is not a Bot this can install."));
    };
    let mastra = row.id == "mastra";
    Ok(Some(crate::env::PickedHarness::Installed {
        image: crate::deployment::reference(root, &image)?,
        port,
        name: row.name,
        mastra,
        run_path: row.run_path,
        // Our own Mastra image serves one agent, named for the product. Somebody pointing at their
        // own Mastra server names theirs on the Bot's page.
        remote_agent_id: if mastra {
            "openbot".to_string()
        } else {
            String::new()
        },
    }))
}
