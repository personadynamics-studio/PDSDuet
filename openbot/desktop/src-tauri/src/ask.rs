#[cfg(test)]
mod tests {
    use super::*;

    /// Captured from a live run, trimmed. The shape is the contract this screen depends on.
    const REAL_STREAM: &str = concat!(
        "data: {\"type\":\"RUN_STARTED\",\"threadId\":\"t1\",\"runId\":\"r1\"}\n\n",
        "data: {\"type\":\"RAW\",\"event\":{\"data\":{\"chunk\":{\"content\":\"391\"}}}}\n\n",
        "data: {\"type\":\"TEXT_MESSAGE_START\",\"messageId\":\"a\",\"role\":\"assistant\"}\n\n",
        "data: {\"type\":\"TEXT_MESSAGE_CONTENT\",\"messageId\":\"a\",\"delta\":\"3\"}\n\n",
        "data: {\"type\":\"TEXT_MESSAGE_CONTENT\",\"messageId\":\"a\",\"delta\":\"91\"}\n\n",
        "data: {\"type\":\"TEXT_MESSAGE_END\",\"messageId\":\"a\"}\n\n",
    );

    #[test]
    fn the_answer_is_the_deltas_joined() {
        assert_eq!(answer_in(REAL_STREAM).as_deref(), Some("391"));
    }

    /// The same answer rides inside `RAW` as well. Counting those would say "391391".
    #[test]
    fn the_framework_trace_is_not_counted_as_the_answer() {
        assert_eq!(answer_in(REAL_STREAM).as_deref(), Some("391"));
        assert!(
            REAL_STREAM.contains("\"type\":\"RAW\""),
            "the fixture must carry the trap"
        );
    }

    /// Measured: a rejected key ends the stream after STEP_STARTED and says nothing at all.
    #[test]
    fn a_stream_that_stops_is_not_an_empty_answer() {
        let stopped = concat!(
            "data: {\"type\":\"RUN_STARTED\",\"threadId\":\"t1\",\"runId\":\"r1\"}\n\n",
            "data: {\"type\":\"STEP_STARTED\",\"stepName\":\"answer\"}\n\n",
        );
        assert_eq!(answer_in(stopped), None);
    }

    #[test]
    fn junk_on_the_wire_does_not_stop_the_answer_being_read() {
        let messy = concat!(
            "data: not json at all\n",
            ": a comment\n",
            "\n",
            "data: {\"type\":\"TEXT_MESSAGE_CONTENT\",\"delta\":\"fine\"}\n",
        );
        assert_eq!(answer_in(messy).as_deref(), Some("fine"));
    }

    /// The sentence names the choice to change, and the log is kept rather than shown as the point.
    #[test]
    fn a_refused_key_is_named_as_a_key_and_not_as_a_stack_trace() {
        let log = "langchain_openai.chat_models.base.OpenAIAuthenticationError: Error code: 401";
        let problem = why_nothing_came_back(log);
        assert!(problem.said.contains("refused"), "{}", problem.said);
        assert!(
            !problem.said.contains("401"),
            "the sentence leaked the trace"
        );
        assert_eq!(problem.detail.as_deref(), Some(log));
    }

    /// Each cause the person can act on gets its own sentence, and no two are the same.
    #[test]
    fn the_causes_worth_telling_apart_are_told_apart() {
        let said = |log: &str| why_nothing_came_back(log).said;
        let quota = said("Error code: 429 - insufficient_quota");
        let model = said("The model `gpt-9` does not exist or you do not have access to it");
        let offline = said("Connection error while reaching the provider");
        let unknown = said("Traceback (most recent call last): RuntimeError: something else");
        let all = [&quota, &model, &offline, &unknown];
        for (i, one) in all.iter().enumerate() {
            for other in all.iter().skip(i + 1) {
                assert_ne!(one, other, "two causes share a sentence");
            }
        }
    }

    /// Every sentence is for the person: no jargon, and always something to do next.
    #[test]
    fn no_sentence_asks_anybody_to_read_a_log() {
        for log in [
            "401 unauthorized",
            "insufficient_quota",
            "rate limit",
            "model_not_found",
            "connection refused",
            "something nobody has seen",
        ] {
            let said = why_nothing_came_back(log).said;
            let lower = said.to_lowercase();
            for forbidden in ["stack trace", "see the logs", "server logs", "traceback"] {
                assert!(!lower.contains(forbidden), "{said}");
            }
            assert!(said.ends_with('.'), "{said}");
        }
    }

    /**
    The whole path against a running harness, which is the only thing that proves the wire format.

    Ignored, because it needs a harness and a real model credential and neither belongs in CI. Run
    it against one by hand:

    ```text
    OPENBOT_ASK_ENDPOINT=http://127.0.0.1:4288/ OPENBOT_ASK_TOKEN=... \
      cargo test --lib live_harness -- --ignored --nocapture
    ```

    Kept rather than deleted after it passed: the fixtures above are transcriptions, and a vendor
    who changes the events they emit breaks this and nothing else.
    */
    #[test]
    #[ignore = "needs a running harness and a real model credential"]
    fn live_harness_answers_the_suggested_question() {
        let endpoint = std::env::var("OPENBOT_ASK_ENDPOINT").expect("OPENBOT_ASK_ENDPOINT");
        let token = std::env::var("OPENBOT_ASK_TOKEN").expect("OPENBOT_ASK_TOKEN");
        let answer = ask(&endpoint, &token, SUGGESTED).expect("the harness did not answer");
        println!("the Bot said: {answer}");
        assert!(
            answer.contains("391"),
            "answered {answer:?}, which is not 17 x 23"
        );
    }

    /// The same path with a credential the provider refuses, which is the failure this screen owns.
    #[test]
    #[ignore = "needs a running harness holding a deliberately invalid credential"]
    fn live_harness_that_cannot_answer_produces_a_sentence_not_a_silence() {
        let endpoint = std::env::var("OPENBOT_ASK_BAD_ENDPOINT").expect("OPENBOT_ASK_BAD_ENDPOINT");
        let token = std::env::var("OPENBOT_ASK_TOKEN").expect("OPENBOT_ASK_TOKEN");
        let problem = ask(&endpoint, &token, SUGGESTED).expect_err("it answered on a bad key");
        // An empty sentence is this module saying the reason is in the log, not in the stream.
        assert!(problem.said.is_empty(), "got {problem:?}");
    }

    /// The default question has one right answer, which is the only reason it proves anything.
    #[test]
    fn the_suggested_question_is_checkable() {
        assert!(SUGGESTED.contains("17") && SUGGESTED.contains("23"));
    }

    #[test]
    fn mastra_harness_uses_native_agent_stream() {
        let server = TestServer::new(
            "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n\
             data: {\"type\":\"text-delta\",\"payload\":{\"text\":\"thirty \"}}\n\n\
             data: {\"type\":\"text-delta\",\"payload\":{\"text\":\"nine\"}}\n\n\
             data: {\"type\":\"finish\",\"payload\":{\"stepResult\":{\"reason\":\"stop\"}}}\n\n",
        );

        let answer = ask_harness(
            &server.url,
            "managed-token",
            "What is 20 plus 19?",
            Some("remote-mastra"),
            Some("openbot"),
        )
        .expect("native Mastra answer");

        let request = server.request();
        assert_eq!(request.path, "/api/agents/openbot/stream");
        assert!(
            request
                .headers
                .iter()
                .any(|line| line == "x-openbot-agent-token: managed-token"),
            "{:?}",
            request.headers
        );
        let body: serde_json::Value = serde_json::from_str(&request.body).expect("json body");
        assert_eq!(
            body.pointer("/messages/0/content").and_then(|v| v.as_str()),
            Some("What is 20 plus 19?")
        );
        assert_eq!(answer, "thirty nine");
    }

    #[test]
    fn ag_ui_harness_still_uses_the_ag_ui_request() {
        let server = TestServer::new(
            "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n\
             data: {\"type\":\"TEXT_MESSAGE_CONTENT\",\"delta\":\"ag-ui ok\"}\n\n",
        );

        let answer = ask_harness(
            &server.url,
            "managed-token",
            "hello",
            Some("remote-ag-ui"),
            Some("openbot"),
        )
        .expect("AG-UI answer");

        let request = server.request();
        assert_eq!(request.path, "/");
        let body: serde_json::Value = serde_json::from_str(&request.body).expect("json body");
        assert!(
            body.get("threadId").is_some(),
            "AG-UI request body was not sent: {body}"
        );
        assert_eq!(answer, "ag-ui ok");
    }

    #[test]
    fn ag_ui_body_read_errors_keep_the_endpoint_status_and_kind() {
        let body = "data: {\"type\":\"TEXT_MESSAGE_CONTENT\",\"delta\":\"part";
        let response = format!(
            "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
            body.len() + 64
        );
        let server = TestServer::new(response);

        let problem = ask_harness(
            &server.url,
            "managed-token",
            "hello",
            Some("remote-ag-ui"),
            Some("openbot"),
        )
        .expect_err("a truncated AG-UI response must not become an empty answer");

        assert!(
            problem
                .said
                .contains("The Bot started answering and then stopped"),
            "{}",
            problem.said
        );
        let detail = problem.detail.as_deref().expect("body read detail");
        assert!(detail.contains("kind remote-ag-ui"), "{detail}");
        assert!(detail.contains(&server.url), "{detail}");
        assert!(detail.contains("HTTP 200 OK"), "{detail}");
        assert!(
            detail.contains("body") || detail.contains("error"),
            "{detail}"
        );
        let _ = server.request();
    }

    #[test]
    fn mastra_body_read_errors_keep_the_endpoint_status_and_kind() {
        let body = "data: {\"type\":\"text-delta\",\"payload\":{\"text\":\"part";
        let response = format!(
            "HTTP/1.1 502 Bad Gateway\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
            body.len() + 64
        );
        let server = TestServer::new(response);

        let problem = ask_harness(
            &server.url,
            "managed-token",
            "hello",
            Some("remote-mastra"),
            Some("openbot"),
        )
        .expect_err("a truncated Mastra response must keep the transport error");

        assert!(
            problem.said.contains("The Bot could not answer"),
            "{}",
            problem.said
        );
        let detail = problem.detail.as_deref().expect("body read detail");
        assert!(detail.contains("kind remote-mastra"), "{detail}");
        assert!(detail.contains("/api/agents/openbot/stream"), "{detail}");
        assert!(detail.contains("HTTP 502 Bad Gateway"), "{detail}");
        assert!(
            detail.contains("body") || detail.contains("error"),
            "{detail}"
        );
        let _ = server.request();
    }

    struct TestRequest {
        path: String,
        headers: Vec<String>,
        body: String,
    }

    struct TestServer {
        url: String,
        received: std::sync::mpsc::Receiver<TestRequest>,
        done: Option<std::thread::JoinHandle<()>>,
    }

    impl TestServer {
        fn new(response: impl Into<String>) -> Self {
            let response = response.into();
            let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
            let url = format!("http://{}", listener.local_addr().expect("addr"));
            let (sender, received) = std::sync::mpsc::channel();
            let done = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().expect("accept");
                use std::io::{Read, Write};
                let mut request = Vec::new();
                let mut buffer = [0; 1024];
                loop {
                    let read = stream.read(&mut buffer).expect("read");
                    request.extend_from_slice(&buffer[..read]);
                    if request.windows(4).any(|window| window == b"\r\n\r\n") {
                        break;
                    }
                }
                let header_end = request
                    .windows(4)
                    .position(|window| window == b"\r\n\r\n")
                    .expect("headers")
                    + 4;
                let headers = String::from_utf8_lossy(&request[..header_end]).to_string();
                let content_length = headers
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().expect("content length"))
                    })
                    .unwrap_or(0);
                while request.len() < header_end + content_length {
                    let read = stream.read(&mut buffer).expect("read body");
                    request.extend_from_slice(&buffer[..read]);
                }
                let mut lines = headers.lines();
                let path = lines
                    .next()
                    .and_then(|line| line.split_whitespace().nth(1))
                    .expect("path")
                    .to_string();
                let headers = lines
                    .filter(|line| !line.trim().is_empty())
                    .map(|line| line.to_ascii_lowercase())
                    .collect();
                let body =
                    String::from_utf8_lossy(&request[header_end..header_end + content_length])
                        .to_string();
                sender
                    .send(TestRequest {
                        path,
                        headers,
                        body,
                    })
                    .expect("send request");
                stream
                    .write_all(response.as_bytes())
                    .expect("write response");
            });
            Self {
                url,
                received,
                done: Some(done),
            }
        }

        fn request(mut self) -> TestRequest {
            let request = self.received.recv().expect("request");
            self.done.take().expect("thread").join().expect("join");
            request
        }
    }
}
