#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read};
    fn callback_over_tcp(nonblocking: bool, fragmented: bool) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let mut browser = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        browser
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        let (mut stream, _) = loop {
            match listener.accept() {
                Ok(accepted) => break accepted,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    assert!(
                        Instant::now() < deadline,
                        "browser connection was not accepted"
                    );
                    std::thread::yield_now();
                }
                Err(error) => panic!("browser connection failed: {error}"),
            }
        };
        // Unix does not consistently inherit this flag; model the Windows accept behavior.
        if nonblocking {
            stream.set_nonblocking(true).unwrap();
        } else {
            stream.set_nonblocking(false).unwrap();
        }
        let request = b"GET /organization-auth/callback?state=expected&code=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa HTTP/1.1\r\nHost: localhost\r\n\r\n";
        let split = if fragmented { 18 } else { 0 };
        if fragmented {
            browser.write_all(&request[..split]).unwrap();
        }
        let (sender, receiver) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            sender
                .send(receive_callback(&mut stream, "expected"))
                .unwrap();
        });
        let early = receiver.recv_timeout(Duration::from_millis(100));
        if !matches!(early, Err(std::sync::mpsc::RecvTimeoutError::Timeout)) {
            worker.join().unwrap();
            panic!("callback completed before its request line arrived: {early:?}");
        }
        browser.write_all(&request[split..]).unwrap();
        assert_eq!(
            receiver
                .recv_timeout(Duration::from_secs(3))
                .unwrap()
                .unwrap(),
            "a".repeat(32)
        );
        let mut response = String::new();
        browser.read_to_string(&mut response).unwrap();
        assert!(response.starts_with("HTTP/1.1 200 OK\r\n"));
        worker.join().unwrap();
    }

    #[test]
    fn callback_waits_for_delayed_get_on_nonblocking_stream() {
        callback_over_tcp(true, false);
    }

    #[test]
    fn callback_waits_for_fragmented_request_line() {
        callback_over_tcp(false, true);
    }

    #[test]
    fn cancellation_retires_a_finish_already_waiting_for_the_browser() {
        let root = PathBuf::from("organization-cancellation-fixture");
        begin(&root, "https://company.example", "google").unwrap();
        let worker_root = root.clone();
        let worker = std::thread::spawn(move || finish(&worker_root));
        let deadline = Instant::now() + Duration::from_secs(2);
        while pending()
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|run| run.receiver.is_some())
        {
            assert!(Instant::now() < deadline, "finish did not start waiting");
            std::thread::yield_now();
        }
        cancel(&root);
        assert!(worker.join().unwrap().is_err());
        assert!(pending().lock().unwrap().is_none());
    }
    #[test]
    fn only_rejected_sessions_request_organization_refresh() {
        for (status, expected) in [
            ("401 Unauthorized", Some(Connection::Organization)),
            ("503 Service Unavailable", None),
        ] {
            let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
            let address = listener.local_addr().unwrap();
            let worker = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                assert!(reader.read_line(&mut line).unwrap() > 0);
                assert_eq!(line, "GET /api/me HTTP/1.1\r\n");
                loop {
                    line.clear();
                    assert!(reader.read_line(&mut line).unwrap() > 0);
                    if line == "\r\n" {
                        break;
                    }
                }
                write!(
                    stream,
                    "HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                )
                .unwrap();
            });
            let result = verify(
                &client().unwrap(),
                &SavedSession {
                    authority: format!("http://{address}"),
                    cookie: "better-auth.session_token=fixture".into(),
                },
            );
            assert_eq!(result.unwrap_err().connection, expected);
            worker.join().unwrap();
        }
    }
    #[test]
    fn authority_is_explicit_and_cannot_smuggle_credentials_or_destinations() {
        assert_eq!(
            authority("https://company.example").unwrap(),
            "https://company.example"
        );
        for bad in [
            "http://company.example",
            "https://person:password@company.example",
            "https://company.example/path",
            "https://company.example?next=elsewhere",
        ] {
            assert!(authority(bad).is_err());
        }
    }
    #[test]
    fn callback_requires_the_exact_single_state_and_code() {
        let code = "a".repeat(32);
        assert_eq!(
            callback_code(
                &format!("GET {CALLBACK}?code={code}&state=expected HTTP/1.1\r\n"),
                "expected"
            )
            .unwrap(),
            code
        );
        for query in [
            format!("code={code}&state=wrong"),
            format!("code={code}&state=expected&state=expected"),
            "code=short&state=expected".into(),
        ] {
            assert!(
                callback_code(&format!("GET {CALLBACK}?{query} HTTP/1.1\r\n"), "expected").is_err()
            );
        }
    }
}
