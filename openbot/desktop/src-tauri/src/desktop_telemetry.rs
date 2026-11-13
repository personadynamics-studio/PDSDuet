#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::temp_root;
    use tauri::Manager;

    fn context() -> telemetry::Context {
        telemetry::Context {
            distribution: telemetry::Distribution::Desktop,
            app_version: telemetry::NumericVersion::parse("1.2.3").unwrap(),
            platform: telemetry::Platform::Macos,
            arch: telemetry::Architecture::Aarch64,
            os_version: None,
            engine: telemetry::Engine::None,
            runtime_env: telemetry::RuntimeEnv::Test,
        }
    }

    struct Fixture {
        app: tauri::App<tauri::test::MockRuntime>,
        window: tauri::WebviewWindow<tauri::test::MockRuntime>,
    }

    impl Fixture {
        fn new() -> Self {
            let data_dir = temp_root("desktop-telemetry-ipc");
            let emitter = telemetry::Telemetry::open_with_env(
                data_dir,
                context(),
                telemetry::Config {
                    enabled: true,
                    endpoint: None,
                    max_queue: 256,
                },
                telemetry::EnvOverride::Enabled,
            )
            .unwrap();
            let app = tauri::test::mock_builder()
                .manage(DesktopTelemetry {
                    emitter,
                    runtime_env: Mutex::new(BTreeMap::new()),
                })
                .invoke_handler(tauri::generate_handler![crate::record_setup_event])
                .build(tauri::test::mock_context(tauri::test::noop_assets()))
                .unwrap();
            let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
                .build()
                .unwrap();
            Self { app, window }
        }

        fn invoke(&self, event: serde_json::Value) {
            let _ = tauri::test::get_ipc_response(
                &self.window,
                tauri::webview::InvokeRequest {
                    cmd: "record_setup_event".into(),
                    callback: tauri::ipc::CallbackFn(0),
                    error: tauri::ipc::CallbackFn(1),
                    url: if cfg!(any(windows, target_os = "android")) {
                        "http://tauri.localhost"
                    } else {
                        "tauri://localhost"
                    }
                    .parse()
                    .unwrap(),
                    body: tauri::ipc::InvokeBody::Json(serde_json::json!({ "event": event })),
                    headers: Default::default(),
                    invoke_key: tauri::test::INVOKE_KEY.into(),
                },
            );
        }

        fn queued(&self) -> Vec<telemetry::EventData> {
            self.app
                .state::<DesktopTelemetry>()
                .emitter
                .snapshot()
                .unwrap()
                .queue
                .into_iter()
                .map(|event| event.data)
                .collect()
        }
    }

    #[test]
    fn setup_telemetry_ipc_accepts_only_frontend_setup_events() {
        let fixture = Fixture::new();

        fixture.invoke(serde_json::json!({
            "kind": "step_viewed",
            "step": "harness"
        }));
        fixture.invoke(serde_json::json!({
            "kind": "harness_chosen",
            "harness": "byo_url"
        }));
        assert_eq!(fixture.queued().len(), 2);

        fixture.invoke(serde_json::json!({
            "kind": "harness_chosen",
            "harness": "byo_url",
            "url": "https://example.invalid"
        }));
        fixture.invoke(serde_json::json!({
            "kind": "step_viewed",
            "step": "credentials"
        }));
        fixture.invoke(serde_json::json!({
            "kind": "activated"
        }));

        let queued = fixture.queued();
        assert_eq!(queued.len(), 2);
        assert!(matches!(
            queued[0],
            telemetry::EventData::StepViewed {
                step: telemetry::Step::Harness
            }
        ));
        assert!(matches!(
            queued[1],
            telemetry::EventData::HarnessChosen {
                harness: telemetry::Harness::ByoUrl
            }
        ));
    }
}
