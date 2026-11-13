#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::OnceLock;

    fn fixture(mode: &str, patience: Duration) -> Arc<SigningIn> {
        static BINARY: OnceLock<PathBuf> = OnceLock::new();
        let binary = BINARY.get_or_init(|| {
            let root = crate::test_support::temp_root("self-hosted-sign-in");
            std::fs::create_dir_all(&root).unwrap();
            let source = root.join("helper.rs");
            let binary = root.join(format!("helper{}", std::env::consts::EXE_SUFFIX));
            std::fs::write(&source, r##"
                use std::io::{self, BufRead, Write};
                fn main() {
                    let mode = std::env::args().nth(1).unwrap();
                    if mode == "malformed" { println!("secret-invalid-json"); return; }
                    if mode == "error" { println!("{}", r#"{"type":"error","message":"Sign-in was refused."}"#); return; }
                    if mode != "pending" { println!("{}", r#"{"type":"projects","projects":[{"id":"7","name":"Team"}]}"#); io::stdout().flush().unwrap(); }
                    for line in io::stdin().lock().lines() {
                        let line = line.unwrap();
                        if line.contains("cancel") { return; }
                        if mode == "mismatch" { println!("{}", r#"{"type":"connection","apiKey":"test-key","apiUrl":"https://other.test","learningContainerId":"openbot"}"#); }
                        else { println!("{}", r#"{"type":"connection","apiKey":"test-key","apiUrl":"https://intelligence.test/","learningContainerId":"openbot"}"#); }
                        return;
                    }
                }
            "##).unwrap();
            crate::test_support::compile_fixture(&source, &binary);
            binary
        });
        let mut command = Command::new(binary);
        command.arg(mode);
        SigningIn::spawn(
            command,
            Path::new("installation"),
            "https://intelligence.test".into(),
            patience,
        )
        .unwrap()
    }

    #[test]
    fn helper_project_selection_produces_matching_connection_after_exit() {
        let signing = fixture("success", PATIENCE);
        assert_eq!(
            signing.projects().unwrap(),
            vec![Project {
                id: "7".into(),
                name: "Team".into()
            }]
        );
        assert!(signing.connect("not-listed").is_err());
        let proof = signing.connect("7").unwrap();
        assert_eq!(proof.api_key, "test-key");
        assert_eq!(proof.api_url, "https://intelligence.test");
        assert_eq!(proof.learning_container_id, "openbot");
        assert!(signing.child.lock().unwrap().is_none());
    }
    #[test]
    fn mismatched_connection_and_malformed_output_are_not_published() {
        let signing = fixture("mismatch", PATIENCE);
        signing.projects().unwrap();
        assert!(signing.connect("7").is_err());
        let malformed = fixture("malformed", PATIENCE);
        let problem = malformed.projects().unwrap_err();
        assert!(!problem.said.contains("secret"));
        assert!(problem.detail.is_none());
        assert_eq!(
            fixture("error", PATIENCE).projects().unwrap_err().said,
            "Sign-in was refused."
        );
    }
    #[test]
    fn cancellation_closes_helper_during_login_and_project_selection() {
        for mode in ["pending", "success"] {
            let signing = fixture(mode, PATIENCE);
            if mode == "success" {
                signing.projects().unwrap();
            }
            signing.cancel();
            assert!(signing.child.lock().unwrap().is_none());
            assert!(signing.projects().is_err());
        }
    }
    #[test]
    fn abandoned_project_picker_times_out_and_reaps_helper() {
        let signing = fixture("success", Duration::from_secs(2));
        signing.projects().unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while !signing.cancelled.load(Ordering::SeqCst) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(25));
        }
        assert!(signing.cancelled.load(Ordering::SeqCst));
        assert!(signing.connect("7").is_err());
    }
    #[test]
    fn api_addresses_require_secure_remote_origins() {
        assert_eq!(
            normalize_api_url("https://intelligence.test/").unwrap(),
            "https://intelligence.test"
        );
        for url in [
            "http://localhost:3000/",
            "http://127.0.0.1:3000",
            "http://[::1]:3000",
        ] {
            assert!(normalize_api_url(url).is_ok());
        }
        for url in [
            "http://remote.test",
            "https://intelligence.test/base/",
            "https://user:password@remote.test",
            "https://remote.test?key=secret",
            "file:///tmp/test",
        ] {
            assert!(normalize_api_url(url).is_err());
        }
    }
    /// Run explicitly against an isolated Intelligence project; the operator completes SSO in
    /// the helper's temporary browser. Never print the runtime credential.
    #[test]
    #[ignore = "requires an isolated Intelligence server and interactive browser SSO"]
    fn live_self_hosted_browser_connection() {
        let root =
            PathBuf::from(std::env::var("OPENBOT_LIVE_SELF_HOSTED_ROOT").expect("test root"));
        let bun = PathBuf::from(std::env::var("OPENBOT_LIVE_SELF_HOSTED_BUN").expect("owned Bun"));
        let api = std::env::var("OPENBOT_LIVE_SELF_HOSTED_API_URL").expect("test API");
        let project = std::env::var("OPENBOT_LIVE_SELF_HOSTED_PROJECT_ID").expect("test project");
        let signing = SigningIn::begin(&root, &bun, &api).unwrap();
        let projects = signing.projects().unwrap();
        assert!(projects.iter().any(|candidate| candidate.id == project));
        println!("self-hosted project discovered: {project}");
        let connection = signing.connect(&project).unwrap();
        assert!(!connection.api_key.is_empty());
        assert_eq!(connection.api_url, normalize_api_url(&api).unwrap());
        assert_eq!(connection.learning_container_id, "openbot");
        println!("self-hosted connection provisioned; browser helper exited");
    }
    /// Observe only descendants of this helper, never the user's browsers or another sign-in.
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "launches a real temporary Chrome/Edge browser against an isolated API"]
    fn live_self_hosted_browser_cancellation() {
        fn processes() -> Vec<(u32, u32, String)> {
            let output = Command::new("/bin/ps")
                .args(["-axo", "pid=,ppid=,comm="])
                .output()
                .expect("inspect child process ownership");
            assert!(output.status.success());
            String::from_utf8(output.stdout)
                .unwrap()
                .lines()
                .filter_map(|line| {
                    let mut columns = line.split_whitespace();
                    let pid = columns.next()?.parse().ok()?;
                    let parent = columns.next()?.parse().ok()?;
                    Some((pid, parent, columns.collect::<Vec<_>>().join(" ")))
                })
                .collect()
        }
        fn descendants(processes: &[(u32, u32, String)], parent: u32) -> Vec<u32> {
            let mut owned = vec![parent];
            loop {
                let previous = owned.len();
                for (pid, parent, _) in processes {
                    if owned.contains(parent) && !owned.contains(pid) {
                        owned.push(*pid);
                    }
                }
                if owned.len() == previous {
                    return owned;
                }
            }
        }
        let root =
            PathBuf::from(std::env::var("OPENBOT_LIVE_SELF_HOSTED_ROOT").expect("test root"));
        let bun = PathBuf::from(std::env::var("OPENBOT_LIVE_SELF_HOSTED_BUN").expect("owned Bun"));
        let api = std::env::var("OPENBOT_LIVE_SELF_HOSTED_API_URL").expect("test API");
        let signing = SigningIn::begin(&root, &bun, &api).unwrap();
        let helper = signing.child.lock().unwrap().as_ref().unwrap().id();
        let deadline = Instant::now() + Duration::from_secs(30);
        let observed = loop {
            let snapshot = processes();
            let owned = descendants(&snapshot, helper);
            let browser = snapshot.iter().any(|(pid, _, name)| {
                owned.contains(pid)
                    && (name.ends_with("Google Chrome") || name.ends_with("Microsoft Edge"))
            });
            let renderer = snapshot
                .iter()
                .any(|(pid, _, name)| owned.contains(pid) && name.contains("Renderer"));
            if browser && renderer {
                break owned;
            }
            assert!(
                Instant::now() < deadline,
                "owned browser and renderer did not start"
            );
            std::thread::sleep(Duration::from_millis(100));
        };
        println!("owned browser and renderer started; cancelling native sign-in");
        signing.cancel();
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let remaining = processes().iter().any(|(pid, _, _)| observed.contains(pid));
            if !remaining {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "owned helper or browser descendant survived cancellation"
            );
            std::thread::sleep(Duration::from_millis(100));
        }
        assert!(signing.projects().is_err());
        println!("native cancellation reaped helper and all observed browser descendants");
    }
}
