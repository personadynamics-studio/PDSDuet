//! Root-local hints about credentials explicitly saved by Start. No protected-store discovery.
//! A hint records past persistence, never current authentication or the outcome of starting services.
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use crate::env::ModelCredential;
use crate::problem::Problem;

pub const FILE: &str = ".openbot-saved.json";

#[derive(
    Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, serde::Serialize, serde::Deserialize,
)]
#[serde(rename_all = "kebab-case")]
pub enum Category {
    OpenAiApiKey,
    AnthropicApiKey,
    ClaudePlan,
    ChatGptPlan,
    CompatibleEndpointApiKey,
    GoogleOauth,
    XaiOauth,
}

// A closed enum intentionally cannot contain fields from the secret-bearing ChosenModel request.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ModelIntent {
    OpenAiApiKey,
    AnthropicApiKey,
    ClaudePlan,
    ChatGptPlan,
    CompatibleEndpoint,
    GoogleOauth,
    XaiOauth,
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct SavedIntent {
    version: u8,
    pub categories: BTreeSet<Category>,
    pub model: Option<ModelIntent>,
}

impl Default for SavedIntent {
    fn default() -> Self {
        Self {
            version: 1,
            categories: BTreeSet::new(),
            model: None,
        }
    }
}

impl SavedIntent {
    /// Missing, unreadable and invalid records are unknown. Never discover or migrate secrets here.
    pub fn read(root: &Path) -> Self {
        std::fs::read(root.join(FILE))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Self>(&bytes).ok())
            .filter(|record| record.version == 1)
            .unwrap_or_default()
    }

    fn record(&mut self, secrets: &BTreeMap<String, String>, credential: &ModelCredential) {
        for (key, category) in [
            ("OPENAI_API_KEY", Category::OpenAiApiKey),
            ("ANTHROPIC_API_KEY", Category::AnthropicApiKey),
            ("CLAUDE_CODE_OAUTH_TOKEN", Category::ClaudePlan),
        ] {
            if let Some(value) = secrets.get(key) {
                if value.trim().is_empty() {
                    self.categories.remove(&category);
                } else {
                    self.categories.insert(category);
                }
            }
        }
        // Compatible endpoints share the legacy OPENAI_API_KEY slot, but that key was not
        // established for the OpenAI provider. Keep its recorded hint out of that provider's UI.
        self.categories.remove(&Category::CompatibleEndpointApiKey);
        if let ModelCredential::Compatible {
            api_key, ..
        } = credential
        {
            self.categories.remove(&Category::OpenAiApiKey);
            if has_endpoint_key(api_key) {
                self.categories.insert(Category::CompatibleEndpointApiKey);
            }
        }
        // write_plan_store persists the selected plan, and clears it for other selections.
        self.categories.remove(&Category::ChatGptPlan);
        self.categories.remove(&Category::GoogleOauth);
        self.categories.remove(&Category::XaiOauth);
        if matches!(credential, ModelCredential::ProviderOAuth { .. }) {
            self.categories.remove(&Category::OpenAiApiKey);
        }
        if matches!(credential, ModelCredential::None) {
            self.model = None;
            return;
        }
        self.model = Some(match credential {
            ModelCredential::None => unreachable!("no model selection was handled above"),
            ModelCredential::OpenAi { .. } => ModelIntent::OpenAiApiKey,
            ModelCredential::Anthropic { .. } => ModelIntent::AnthropicApiKey,
            ModelCredential::ClaudePlan { .. } => ModelIntent::ClaudePlan,
            ModelCredential::ChatGptPlan { store } => {
                if !store.trim().is_empty() {
                    self.categories.insert(Category::ChatGptPlan);
                }
                ModelIntent::ChatGptPlan
            }
            ModelCredential::Compatible { .. } => ModelIntent::CompatibleEndpoint,
            ModelCredential::ProviderOAuth { provider, .. } => {
                if provider == "google" {
                    self.categories.insert(Category::GoogleOauth);
                    ModelIntent::GoogleOauth
                } else {
                    self.categories.insert(Category::XaiOauth);
                    ModelIntent::XaiOauth
                }
            }
        });
    }

    fn write(&self, root: &Path) -> std::io::Result<()> {
        crate::env::write_private_file(&root.join(FILE), &serde_json::to_vec(self)?)
    }
}

// Compatible model credentials use their own saved record.
pub const COMPATIBLE_CREDENTIAL: &str = "OPENAI_COMPATIBLE_CREDENTIAL";

#[derive(serde::Serialize, serde::Deserialize)]
struct CompatibleCredential {
    api_key: String,
}

fn has_endpoint_key(api_key: &str) -> bool {
    !api_key.trim().is_empty() && api_key.trim() != crate::env::NO_KEY_NEEDED
}

pub fn compatible_key_from_record(record: &str) -> Result<String, Problem> {
    serde_json::from_str::<CompatibleCredential>(record).map(|saved| saved.api_key).map_err(|e| Problem::from(e.to_string()))
}

/// Start's credential transaction: protected writes, plan file, durable hints, then legacy purge.
/// On any persistence failure the old .env remains migration input for an explicit retry.
pub fn persist_configuration(
    root: &Path,
    settings: &BTreeMap<String, String>,
    secrets: &BTreeMap<String, String>,
    purge: &BTreeMap<String, String>,
    credential: &ModelCredential,
) -> Result<(), Problem> {
    let mut scoped_secrets = secrets.clone();
    let record = match credential {
        ModelCredential::Compatible {
            api_key, ..
        } if has_endpoint_key(api_key) => Some(
            serde_json::to_string(&CompatibleCredential {
                api_key: api_key.trim().to_string(),
            })
            .map_err(|_| {
                Problem::plain("OpenBot could not prepare the endpoint key for saving.")
            })?,
        ),
        _ if SavedIntent::read(root)
            .categories
            .contains(&Category::CompatibleEndpointApiKey) =>
        {
            Some(String::new())
        }
        _ => None,
    };
    if let Some(record) = record {
        scoped_secrets.insert(COMPATIBLE_CREDENTIAL.into(), record);
    }
    crate::vault::remember_all(root, &scoped_secrets)?;
    crate::env::write_plan_store(root, credential).map_err(|error| {
        Problem::with(
            "OpenBot could not save the model sign-in. Try Start again.",
            error.to_string(),
        )
    })?;
    let mut intent = SavedIntent::read(root);
    intent.record(secrets, credential);
    intent.write(root).map_err(|error| Problem::with(
        "OpenBot could not record the saved connections. Your previous settings are kept; try Start again.",
        error.to_string(),
    ))?;
    crate::env::write(&root.join(".env"), settings, purge)
        .map_err(|error| Problem::with("OpenBot could not write its settings.", error.to_string()))
}
