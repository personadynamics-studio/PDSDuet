use std::path::{Path, PathBuf};
use crate::{deployment, problem::Problem, stack};

pub fn save_selected_root(config: &Path, root: &Path) -> Result<(), Problem> {
    std::fs::create_dir_all(config).map_err(|e| Problem::from(e.to_string()))?;
    let bytes = serde_json::to_vec(root).map_err(|e| Problem::from(e.to_string()))?;
    std::fs::write(config.join("last-launched-root.json"), bytes).map_err(|e| Problem::from(e.to_string()))
}

pub fn selected_root(config: &Path) -> Option<PathBuf> {
    serde_json::from_slice(&std::fs::read(config.join("last-launched-root.json")).ok()?).ok()
}

pub fn image_settings(
    root: &Path,
    picked: Option<&crate::env::PickedHarness>,
) -> Result<stack::Secrets, Problem> {
    let mut settings: stack::Secrets = deployment::image_variables(root)?.into_iter().collect();
    settings.insert("IMAGE_PULL_POLICY".into(), "missing".into());
    if let Some(crate::env::PickedHarness::Installed { image, port, .. }) = picked {
        settings.insert("PICKED_HARNESS_IMAGE".into(), image.clone());
        settings.insert("PICKED_HARNESS_PORT".into(), port.to_string());
    }
    Ok(settings)
}
