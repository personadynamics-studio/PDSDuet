#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;

    #[test]
    fn runtime_connection_poll_accepts_only_authenticated_typed_provider_failures() {
        for (status, body, expected) in [
            (200, "null", Ok(None)),
            (
                200,
                r#"{"connection":"model","code":"provider_authentication_failed"}"#,
                Ok(Some(Connection::Model)),
            ),
            (
                200,
                r#"{"connection":"intelligence","code":"intelligence_authentication_failed"}"#,
                Ok(Some(Connection::Intelligence)),
            ),
            (
                200,
                r#"{"connection":"organization","code":"organization_authentication_failed"}"#,
                Ok(Some(Connection::Organization)),
            ),
            (404, "", Ok(None)),
            (401, "provider auth failed", Err(())),
            (403, "provider auth failed", Err(())),
            (500, "provider auth failed", Err(())),
            (
                200,
                r#"{"connection":"model","code":"rate_limit"}"#,
                Err(()),
            ),
            (
                200,
                r#"{"connection":"model","code":"provider_authentication_failed","secret":"unexpected"}"#,
                Err(()),
            ),
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            let server = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut headers = String::new();
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    if line == "\r\n" || line.is_empty() {
                        break;
                    }
                    headers.push_str(&line);
                }
                assert!(headers.starts_with("GET /api/desktop/connection-failure "));
                assert!(headers
                    .to_lowercase()
                    .contains("x-openbot-desktop-host-token: synthetic-run-token\r\n"));
                write!(stream, "HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            });
            let result = poll(&client().unwrap(), port, "synthetic-run-token");
            server.join().unwrap();
            assert_eq!(result.map_err(|_| ()), expected);
        }
    }
}
