#[cfg(test)]
mod tests {
    const LEARNING_CONTAINER: &str =
        r#"{"container":{"id":"openbot","projectId":42,"name":"OpenBot"}}"#;
    const NO_LEARNING_CONTAINER: &str = r#"{"container":null}"#;

    #[test]
    fn learning_reuses_the_project_container_without_writing() {
        let (url, requests) = response_server(vec![("200 OK", LEARNING_CONTAINER)]);
        assert_eq!(
            super::ensure_learning_container_at(&url, "product-session", "42").unwrap(),
            "openbot"
        );
        let requests = requests.join().unwrap();
        assert_eq!(requests.len(), 1);
        assert!(requests[0]
            .0
            .starts_with("GET /api/learning/projects/42/containers/openbot HTTP/1.1\r\n"));
        assert!(requests[0]
            .0
            .to_lowercase()
            .contains("authorization: bearer product-session\r\n"));
    }

    #[test]
    fn learning_creates_only_after_an_explicit_missing_container() {
        let (url, requests) = response_server(vec![
            ("200 OK", NO_LEARNING_CONTAINER),
            ("201 Created", LEARNING_CONTAINER),
        ]);
        assert_eq!(
            super::ensure_learning_container_at(&url, "product-session", "42").unwrap(),
            "openbot"
        );
        let requests = requests.join().unwrap();
        assert_eq!(requests.len(), 2);
        assert!(requests[1]
            .0
            .starts_with("POST /api/learning/projects/42/containers HTTP/1.1\r\n"));
        assert!(requests[1]
            .0
            .to_lowercase()
            .contains("authorization: bearer product-session\r\n"));
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&requests[1].1).unwrap(),
            serde_json::json!({"id":"openbot","name":"OpenBot"})
        );
    }

    #[test]
    fn learning_reads_the_winner_of_an_exact_already_exists_race() {
        let (url, requests) = response_server(vec![
            ("200 OK", NO_LEARNING_CONTAINER),
            (
                "409 Conflict",
                r#"{"error":{"code":"LEARNING_CONTAINER_ALREADY_EXISTS"}}"#,
            ),
            ("200 OK", LEARNING_CONTAINER),
        ]);
        assert_eq!(
            super::ensure_learning_container_at(&url, "product-session", "42").unwrap(),
            "openbot"
        );
        let requests = requests.join().unwrap();
        assert_eq!(requests.len(), 3);
        assert!(requests[2]
            .0
            .starts_with("GET /api/learning/projects/42/containers/openbot HTTP/1.1\r\n"));
    }

    #[test]
    fn learning_errors_and_malformed_reads_never_create_a_container() {
        for (status, body) in [
            ("403 Forbidden", r#"{"error":{"code":"FORBIDDEN"}}"#),
            ("404 Not Found", r#"{"error":{"code":"NOT_FOUND"}}"#),
            (
                "500 Internal Server Error",
                r#"{"error":{"code":"INTERNAL_ERROR"}}"#,
            ),
            ("200 OK", r#"{}"#),
            ("200 OK", r#"{"container":{"id":"other","projectId":42}}"#),
            ("200 OK", r#"{"container":{"id":"openbot","projectId":43}}"#),
            ("200 OK", "not json"),
        ] {
            let (url, requests) = response_server(vec![(status, body)]);
            let error = super::provision_connection_at(&url, "product-session", "42")
                .err()
                .expect("a failed Learning lookup must not mint a runtime key");
            if !status.starts_with("200") {
                assert!(error
                    .detail
                    .unwrap()
                    .contains(&format!("HTTP {}", &status[..3])));
            }
            assert_eq!(requests.join().unwrap().len(), 1);
        }
    }

    #[test]
    fn learning_create_failures_and_mismatched_responses_are_not_accepted() {
        for (status, body) in [
            ("409 Conflict", r#"{"error":{"code":"OTHER_CONFLICT"}}"#),
            ("403 Forbidden", r#"{"error":{"code":"FORBIDDEN"}}"#),
            ("201 Created", NO_LEARNING_CONTAINER),
            (
                "201 Created",
                r#"{"container":{"id":"openbot","projectId":43}}"#,
            ),
        ] {
            let (url, requests) =
                response_server(vec![("200 OK", NO_LEARNING_CONTAINER), (status, body)]);
            let error =
                super::ensure_learning_container_at(&url, "product-session", "42").unwrap_err();
            if !status.starts_with("201") {
                assert!(error
                    .detail
                    .unwrap()
                    .contains(&format!("HTTP {}", &status[..3])));
            }
            assert_eq!(requests.join().unwrap().len(), 2);
        }
    }

    #[test]
    fn learning_race_still_requires_a_verified_container() {
        for (status, body) in [
            ("200 OK", NO_LEARNING_CONTAINER),
            (
                "500 Internal Server Error",
                r#"{"error":{"code":"INTERNAL_ERROR"}}"#,
            ),
        ] {
            let (url, requests) = response_server(vec![
                ("200 OK", NO_LEARNING_CONTAINER),
                (
                    "409 Conflict",
                    r#"{"error":{"code":"LEARNING_CONTAINER_ALREADY_EXISTS"}}"#,
                ),
                (status, body),
            ]);
            assert!(super::ensure_learning_container_at(&url, "product-session", "42").is_err());
            assert_eq!(requests.join().unwrap().len(), 3);
        }
    }

    #[test]
    fn learning_transport_failure_is_reported() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        drop(listener);
        let error = super::ensure_learning_container_at(&url, "product-session", "42").unwrap_err();
        assert!(error.said.contains("could not be prepared"));
        assert!(!error.detail.unwrap().contains("product-session"));
    }

    #[test]
    fn learning_provisioning_returns_proof_bound_to_the_minted_runtime_key_and_api() {
        let (url, requests) = response_server(vec![
            ("200 OK", LEARNING_CONTAINER),
            ("201 Created", r#"{"key":"runtime-key"}"#),
        ]);
        let proof = super::provision_connection_at(&url, "product-session", "42").unwrap();
        assert_eq!(proof.api_key, "runtime-key");
        assert_eq!(proof.api_url, url);
        assert_eq!(proof.learning_container_id, "openbot");
        let requests = requests.join().unwrap();
        assert!(requests[1].0.starts_with("POST /api/keys HTTP/1.1\r\n"));
        assert!(requests.iter().all(|(headers, _)| headers
            .to_lowercase()
            .contains("authorization: bearer product-session\r\n")));
    }

    #[test]
    #[ignore = "requires an authorized isolated Intelligence project and product credential"]
    fn live_learning_container_create_and_reuse() {
        let product = std::env::var("OPENBOT_LIVE_INTELLIGENCE_PRODUCT_CREDENTIAL")
            .expect("provide a product credential through the environment");
        let project = std::env::var("OPENBOT_LIVE_INTELLIGENCE_PROJECT_ID")
            .expect("provide an isolated test project ID");
        let first =
            super::ensure_learning_container_at(super::PRODUCT_API, &product, &project).unwrap();
        let second =
            super::ensure_learning_container_at(super::PRODUCT_API, &product, &project).unwrap();
        assert_eq!(first, "openbot");
        assert_eq!(first, second);
        println!("verified Learning container openbot in the isolated project; repeated provisioning reused it");
    }

    #[test]
    fn project_creation_trims_names_and_rejects_empty_or_overlong_names() {
        assert_eq!(
            super::project_creation_body("  Desktop test  ").unwrap(),
            serde_json::json!({"name":"Desktop test"})
        );
        assert!(super::project_creation_body(" \n ").is_err());
        assert!(super::project_creation_body(&"x".repeat(256)).is_err());
        assert!(super::project_creation_body(&"x".repeat(255)).is_ok());
    }

    #[test]
    fn creates_project_using_the_signed_in_credential_and_parses_numeric_id() {
        let (url, request) = response_server(vec![(
            "201 Created",
            r#"{"id":42,"name":"Desktop validation"}"#,
        )]);
        let project =
            super::create_project_at(&url, "synthetic-product-session", " Desktop validation ")
                .unwrap();
        assert_eq!(
            project,
            super::Project {
                id: "42".into(),
                name: "Desktop validation".into()
            }
        );
        let (headers, body) = request.join().unwrap().pop().unwrap();
        assert!(headers.starts_with("POST /api/projects HTTP/1.1\r\n"));
        assert!(headers
            .to_lowercase()
            .contains("authorization: bearer synthetic-product-session\r\n"));
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&body).unwrap(),
            serde_json::json!({"name":"Desktop validation"})
        );
    }

    #[test]
    fn project_creation_preserves_api_failure_and_rejects_missing_id() {
        for (status, body) in [
            ("403 Forbidden", r#"{"error":"not allowed"}"#),
            ("201 Created", r#"{"name":"No ID"}"#),
        ] {
            let (url, request) = response_server(vec![(status, body)]);
            let error =
                super::create_project_at(&url, "synthetic-product-session", "Desktop validation")
                    .unwrap_err();
            if status.starts_with("403") {
                assert!(error.detail.unwrap().contains("HTTP 403"));
            } else {
                assert!(error.said.contains("did not return its ID"));
            }
            request.join().unwrap();
        }
    }

    type CapturedRequests = Vec<(String, Vec<u8>)>;

    fn response_server(
        responses: Vec<(&'static str, &'static str)>,
    ) -> (String, std::thread::JoinHandle<CapturedRequests>) {
        use std::io::{BufRead, Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let request = std::thread::spawn(move || {
            let mut requests = Vec::new();
            for (status, body) in responses {
                let (stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                    .unwrap();
                let mut reader = std::io::BufReader::new(stream);
                let mut headers = String::new();
                loop {
                    let mut line = String::new();
                    assert!(reader.read_line(&mut line).unwrap() > 0);
                    headers.push_str(&line);
                    if line == "\r\n" {
                        break;
                    }
                }
                let length: usize = headers
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse().unwrap())
                    })
                    .unwrap_or(0);
                let mut request_body = vec![0; length];
                reader.read_exact(&mut request_body).unwrap();
                write!(reader.get_mut(), "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
                requests.push((headers, request_body));
            }
            requests
        });
        (url, request)
    }
    /// The field name that broke a whole sign-in, read off the real response.
    #[test]
    fn the_session_is_read_from_the_name_the_endpoint_uses() {
        // Verbatim shape from the ops API, with the value replaced.
        let body = r#"{"cliToken":"abc","organization":{"organizationName":"CopilotKit"}}"#;
        let session: super::Session = serde_json::from_str(body).expect("cliToken was not read");
        assert_eq!(session.cli_token, "abc");
        // The older name still works, because being strict here is what cost the setup.
        let older: super::Session = serde_json::from_str(r#"{"token":"xyz"}"#).unwrap();
        assert_eq!(older.cli_token, "xyz");
    }

    /// A body shown to a person keeps its shape and loses its credentials.
    #[test]
    fn the_shown_body_has_no_credentials_left_in_it() {
        let body = r#"{"cliToken":"live-secret","user":{"email":"a@b.c"},"apiKey":"another"}"#;
        let shown = super::without_credentials(body);
        assert!(!shown.contains("live-secret"), "{shown}");
        assert!(!shown.contains("another"), "{shown}");
        // The shape is the whole point of showing it at all.
        assert!(shown.contains("cliToken") && shown.contains("email") && shown.contains("a@b.c"));
    }

    /// The keys endpoint takes a number, and sending a string failed the whole sign-in.
    #[test]
    fn the_project_id_is_sent_as_the_number_the_endpoint_requires() {
        assert_eq!(super::as_number("7"), serde_json::json!(7));
        assert_eq!(super::as_number(" 11 "), serde_json::json!(11));
        // A self-hosted deployment could use a real string id; that is not ours to mangle.
        assert_eq!(super::as_number("p_abc"), serde_json::json!("p_abc"));
    }

    /// A numeric id is still an id, and requiring a string hid every project this account had.
    #[test]
    fn projects_are_read_whether_the_id_is_a_number_or_a_string() {
        // Verbatim shape from the product API, trimmed.
        let real: serde_json::Value = serde_json::from_str(
            r#"{"projects":[{"createdAt":"2026-06-17T21:52:32.994Z","id":7,"name":"my-app","slug":"my-app"},{"id":11,"name":"Test Project"}]}"#,
        )
        .unwrap();
        let found = super::projects_in(&real);
        assert_eq!(found.len(), 2, "a numeric id dropped the project");
        assert_eq!(found[0].id, "7");
        assert_eq!(found[0].name, "my-app");

        // A string id keeps working, because some endpoints do use one.
        let text: serde_json::Value =
            serde_json::from_str(r#"[{"id":"p_1","name":"One"}]"#).unwrap();
        assert_eq!(super::projects_in(&text)[0].id, "p_1");
    }

    /// An empty answer and an unreadable one are told apart, because one of them is a lie.
    #[test]
    fn a_payload_we_cannot_read_is_not_reported_as_no_projects() {
        let empty: serde_json::Value = serde_json::from_str(r#"{"projects":[]}"#).unwrap();
        assert!(super::looks_genuinely_empty(&empty));
        assert!(super::looks_genuinely_empty(&serde_json::json!([])));

        // A shape nobody recognises is not an empty list, and saying so is the bug.
        let odd: serde_json::Value =
            serde_json::from_str(r#"{"items":[{"id":"p1","name":"One"}]}"#).unwrap();
        assert!(!super::looks_genuinely_empty(&odd));
        assert!(super::projects_in(&odd).is_empty());
    }

    /// Something that is not JSON is still worth showing, unchanged.
    #[test]
    fn a_body_that_is_not_json_is_shown_as_it_arrived() {
        assert_eq!(
            super::without_credentials("<html>502</html>"),
            "<html>502</html>"
        );
    }

    use super::*;

    #[test]
    fn the_callback_gives_up_its_state_and_token() {
        let line = "GET /callback?state=abc123&clerkToken=tok_xyz HTTP/1.1";
        assert_eq!(
            callback_values(line),
            Some(("abc123".into(), "tok_xyz".into()))
        );
    }

    /// Percent-encoded values come back decoded, since a token may carry them.
    #[test]
    fn an_encoded_value_is_decoded() {
        let line = "GET /callback?state=a%2Db&clerkToken=x%20y HTTP/1.1";
        assert_eq!(callback_values(line), Some(("a-b".into(), "x y".into())));
    }

    /// Anything that is not the callback is ignored rather than treated as a sign-in.
    #[test]
    fn a_request_that_is_not_the_callback_yields_nothing() {
        assert_eq!(callback_values("GET /favicon.ico HTTP/1.1"), None);
        assert_eq!(callback_values("GET /callback HTTP/1.1"), None);
        assert_eq!(callback_values(""), None);
    }

    /// Both shapes that endpoint has answered with, because a wrapper changing should not empty
    /// the screen.
    #[test]
    fn projects_are_read_from_either_shape() {
        let wrapped = serde_json::json!({"projects": [{"id": "p1", "name": "Ledgerline"}]});
        let bare = serde_json::json!([{"id": "p1", "name": "Ledgerline"}]);
        let expected = vec![Project {
            id: "p1".into(),
            name: "Ledgerline".into(),
        }];
        assert_eq!(projects_in(&wrapped), expected);
        assert_eq!(projects_in(&bare), expected);
    }

    /// A project with no name is listed under its id rather than dropped.
    #[test]
    fn a_nameless_project_is_still_offered() {
        let raw = serde_json::json!([{"id": "p2"}]);
        assert_eq!(
            projects_in(&raw),
            vec![Project {
                id: "p2".into(),
                name: "p2".into()
            }]
        );
    }

    /// The key, wherever that response decided to put it.
    #[test]
    fn the_key_is_found_in_the_shapes_that_endpoint_uses() {
        for raw in [
            serde_json::json!({"key": "cpk-abc"}),
            serde_json::json!({"apiKey": "cpk-abc"}),
            serde_json::json!({"key": {"value": "cpk-abc"}}),
            serde_json::json!({"data": {"key": "cpk-abc"}}),
        ] {
            assert_eq!(key_in(&raw).as_deref(), Some("cpk-abc"), "{raw}");
        }
    }

    /// A response with no key is a failure to report, not an empty string to write into `.env`.
    #[test]
    fn a_response_without_a_key_yields_nothing() {
        assert_eq!(key_in(&serde_json::json!({"key": ""})), None);
        assert_eq!(key_in(&serde_json::json!({"unexpected": true})), None);
    }

    #[test]
    fn nothing_readable_is_an_empty_list_rather_than_a_crash() {
        assert!(projects_in(&serde_json::json!({"unexpected": true})).is_empty());
    }

    /// The callback is opened on a loopback address, never a name.
    #[test]
    fn the_callback_is_loopback_and_the_url_carries_it() {
        let (signing, url) = SigningInToIntelligence::begin().expect("it did not start");
        assert!(url.starts_with(OPS_FRONTEND), "{url}");
        assert!(url.contains("127.0.0.1"), "{url}");
        assert!(!url.contains("localhost"), "{url}");
        assert!(signing.port() > 0);
    }
}

#[cfg(test)]
mod wire {
    /// What the window actually receives, which is the only thing that decides what it can render.
    #[test]
    fn a_project_reaches_the_window_with_both_fields() {
        let project = super::Project {
            id: "7".into(),
            name: "my-app".into(),
        };
        let json = serde_json::to_string(&project).unwrap();
        assert_eq!(
            json, r#"{"id":"7","name":"my-app"}"#,
            "the wire shape changed"
        );
    }
}
