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

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        root: PathBuf,
        bun: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let root = crate::test_support::temp_root("preparation");
            for package in PACKAGES {
                std::fs::create_dir_all(root.join(package)).unwrap();
                std::fs::write(
                    root.join(package).join("package.json"),
                    r#"{"scripts":{"serve":"bun serve.ts"}}"#,
                )
                .unwrap();
            }
            let root = std::fs::canonicalize(root).unwrap();
            std::fs::write(
                root.join("package.json"),
                r#"{"dependencies":{"synthetic-package":"1"}}"#,
            )
            .unwrap();
            std::fs::write(root.join("bun.lock"), "synthetic-lock").unwrap();
            std::fs::write(root.join("docker-compose.yml"), "services: {}\n").unwrap();
            std::fs::write(root.join("container-images.json"), "{}").unwrap();
            deployment::record(&root, "v-test").unwrap();
            let source = root.join("runtime.rs");
            std::fs::write(&source, r#"
use std::io::Write;
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args == ["--version"] {
        let version = std::env::current_exe().unwrap().parent().unwrap().join("runtime-version");
        println!("{}", std::fs::read_to_string(version).unwrap_or_else(|_| "1.4.3".into()));
        return;
    }
    assert_eq!(args, ["install", "--frozen-lockfile", "--ignore-scripts"]);
    let previous = std::fs::read_to_string("installs").unwrap_or_default();
    writeln!(std::fs::OpenOptions::new().create(true).append(true).open("installs").unwrap(), "install").unwrap();
    std::fs::create_dir_all("node_modules/synthetic-package").unwrap();
    if previous.is_empty() { std::process::exit(71); }
    std::fs::write("node_modules/synthetic-package/package.json", "{}").unwrap();
}
"#).unwrap();
            let bun = root.join(format!("runtime{}", std::env::consts::EXE_SUFFIX));
            crate::test_support::compile_fixture(&source, &bun);
            Self { root, bun }
        }

        fn dependencies(&self) {
            std::fs::create_dir_all(self.root.join("node_modules/synthetic-package")).unwrap();
            std::fs::write(
                self.root
                    .join("node_modules/synthetic-package/package.json"),
                "{}",
            )
            .unwrap();
            record_dependencies(&self.root, &self.bun).unwrap();
        }

        fn prepared(&self, harness: Option<&HarnessChoice>) {
            self.dependencies();
            complete_with(&self.root, harness, vec!["synthetic-image".into()], |_| {
                Ok(())
            })
            .unwrap();
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.root).unwrap();
        }
    }

    #[test]
    fn failed_dependencies_retry_then_auth_reuses_success_without_installing() {
        let f = Fixture::new();
        std::fs::write(f.root.join(".env"), "KEEP_THIS_PUBLIC_SETTING=yes\n").unwrap();
        let install = || install_dependencies_if_needed(&f.root, || Ok(f.bun.clone()));
        assert!(install().is_err());
        assert!(!f.root.join(DEPENDENCIES).exists());
        assert!(f.root.join("node_modules").is_dir());
        install().unwrap();
        install_dependencies_if_needed(&f.root, || panic!("cached runtime must be reused"))
            .unwrap();
        f.prepared(None);
        for _ in 0..2 {
            require_with(&f.root, None, |images| {
                assert_eq!(images, ["synthetic-image"]);
                Ok(())
            })
            .unwrap();
        }
        assert_eq!(
            std::fs::read_to_string(f.root.join("installs")).unwrap(),
            "install\ninstall\n"
        );
        assert_eq!(
            std::fs::read_to_string(f.root.join(".env")).unwrap(),
            "KEEP_THIS_PUBLIC_SETTING=yes\n"
        );
    }

    /// A v0.2.0 install prepared by an app that did not copy `agent-computer` still matched its
    /// fingerprint, so Start ran a server that could not load. Start now sends it back to Install,
    /// which lays the deployment out again.
    #[test]
    fn a_deployment_laid_out_by_an_earlier_app_requires_installation_before_start() {
        let f = Fixture::new();
        // Exactly what an earlier app wrote, in place before it prepared the installation.
        std::fs::write(deployment::stamp_path(&f.root), r#"{"version":"v-test"}"#).unwrap();
        f.prepared(None);
        let problem = require_with(&f.root, None, |_| Ok(()))
            .expect_err("a deployment missing folders this app copies cannot start");
        assert!(problem.said.contains("Finish installing"));
    }

    #[test]
    fn cached_dependencies_with_unsupported_runtime_require_installation_before_start() {
        let f = Fixture::new();
        f.dependencies();
        std::fs::write(f.root.join("runtime-version"), "1.2.15").unwrap();
        let problem = dependencies_ready(&f.root).expect_err("a cached older runtime is not ready");
        assert!(problem.said.contains("Finish installing"));
        assert!(problem
            .detail
            .unwrap_or_default()
            .contains(crate::install::BUN));
    }

    #[test]
    fn failed_image_preparation_cannot_publish_completion() {
        let f = Fixture::new();
        f.dependencies();
        let result = complete_with(&f.root, None, vec!["missing-image".into()], |_| {
            Err(required("missing image"))
        });
        assert!(result.is_err());
        assert!(!f.root.join(FILE).exists());
        assert!(installation(&f.root).is_none());
        complete_with(&f.root, None, vec!["now-present".into()], |_| Ok(())).unwrap();
        assert!(f.root.join(FILE).is_file());
        assert!(installation(&f.root).is_some());
        assert!(
            launch(&f.root).is_none(),
            "installation does not authorize automatic Start"
        );
    }

    #[test]
    fn changed_bot_lockfile_or_deleted_package_requires_installation() {
        let f = Fixture::new();
        let chosen = Some(HarnessChoice {
            id: "langgraph".into(),
            agent_url: None,
        });
        f.prepared(chosen.as_ref());
        require_with(&f.root, Some(&chosen), |_| Ok(())).unwrap();
        assert!(require_with(&f.root, Some(&None), |_| panic!(
            "wrong selection must stop first"
        ))
        .is_err());
        std::fs::remove_file(f.root.join("node_modules/synthetic-package/package.json")).unwrap();
        assert!(require_with(&f.root, Some(&chosen), |_| Ok(())).is_err());
        f.dependencies();
        f.prepared(chosen.as_ref());
        std::fs::write(f.root.join("bun.lock"), "changed-lock").unwrap();
        assert!(require_with(&f.root, Some(&chosen), |_| Ok(())).is_err());
    }

    #[test]
    fn successful_launch_remembers_exact_root_and_bot_without_credentials() {
        let f = Fixture::new();
        let chosen = HarnessChoice {
            id: "byo-url".into(),
            agent_url: Some("https://agent.example/ag-ui".into()),
        };
        f.prepared(Some(&chosen));
        let config = f.root.join("app-config");
        assert!(launch(&f.root).is_none());
        record_launch(&f.root, Some(&chosen)).unwrap();
        save_selected_root(&config, &f.root).unwrap();
        assert_eq!(selected_root(&config), Some(f.root.clone()));
        assert_eq!(launch(&f.root).unwrap().harness, Some(chosen));
        std::fs::remove_file(f.root.join("node_modules/synthetic-package/package.json")).unwrap();
        assert!(
            launch(&f.root).is_some(),
            "resume intent survives missing assets for explicit install recovery"
        );
        invalidate(&f.root).unwrap();
        assert!(launch(&f.root).is_none());
        assert_eq!(
            selected_root(&config),
            Some(f.root.clone()),
            "repair must not forget the last successful folder"
        );
    }
}
