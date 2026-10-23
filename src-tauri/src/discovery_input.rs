//! Finite inert HTML input. No scripts, authentication, subresource loading or crawling.
use crate::network;
use serde::Serialize;

const MAX_BYTES: usize = 2 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryPage {
    pub page_url: String,
    pub response_url: String,
    pub html: String,
}

pub async fn fetch(raw: &str, allow_http: bool) -> Result<DiscoveryPage, String> {
    if raw.len() > 16_384 {
        return Err("discovery-url-too-large".into());
    }
    let mut response = network::response(raw, allow_http, None).await?;
    if !response.status().is_success() {
        return Err(format!("http-{}", response.status().as_u16()));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_BYTES as u64)
    {
        return Err("discovery-page-too-large".into());
    }
    let response_url = response.url().to_string();
    let html_mime = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .is_some_and(|mime| {
            matches!(
                mime.trim().to_ascii_lowercase().as_str(),
                "text/html" | "application/xhtml+xml"
            )
        });
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|error| {
        if error.is_timeout() {
            "timeout".to_string()
        } else {
            "discovery-network-failure".to_string()
        }
    })? {
        if bytes.len() + chunk.len() > MAX_BYTES {
            return Err("discovery-page-too-large".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let html = String::from_utf8(bytes).map_err(|_| "discovery-invalid-utf8".to_string())?;
    let prefix: String = html
        .trim_start_matches('\u{feff}')
        .trim_start()
        .chars()
        .take(512)
        .collect::<String>()
        .to_ascii_lowercase();
    if !(prefix.starts_with("<!doctype html")
        || prefix.starts_with("<html")
        || (html_mime && prefix.starts_with('<')))
    {
        return Err("discovery-not-html".into());
    }
    Ok(DiscoveryPage {
        page_url: raw.into(),
        response_url,
        html,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    async fn fixture(headers: &str, body: &[u8]) -> (String, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let reply = [headers.as_bytes(), body].concat();
        let handle = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096];
            let read = socket.read(&mut request).await.unwrap();
            assert!(read > 0);
            let _ = socket.write_all(&reply).await;
        });
        (format!("http://{address}/page"), handle)
    }

    #[tokio::test]
    async fn admits_inert_html_without_filename_and_preserves_final_url() {
        let body =
            b"<!doctype html><html><a href='/source'>Source</a><script>throw 1</script></html>";
        let (url, handle) = fixture(
            &format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            ),
            body,
        )
        .await;
        let page = fetch(&url, true).await.unwrap();
        assert_eq!(page.html.as_bytes(), body);
        assert_eq!(page.page_url, url);
        assert_eq!(page.response_url, url);
        handle.await.unwrap();
        assert_eq!(
            fetch(&url, false).await.err().unwrap(),
            "url-policy-refused"
        );
    }

    #[tokio::test]
    async fn refuses_header_and_streamed_oversize() {
        let (url, handle) = fixture(
            "HTTP/1.1 200 OK\r\nContent-Length: 2097153\r\nConnection: close\r\n\r\n",
            b"",
        )
        .await;
        assert_eq!(
            fetch(&url, true).await.err().unwrap(),
            "discovery-page-too-large"
        );
        handle.await.unwrap();
        let body = vec![b' '; MAX_BYTES + 1];
        let (url, handle) = fixture("HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n", &body).await;
        assert_eq!(
            fetch(&url, true).await.err().unwrap(),
            "discovery-page-too-large"
        );
        handle.await.unwrap();
    }

    #[tokio::test]
    async fn refuses_non_html_invalid_utf8_and_http_denial() {
        for (status, body, error) in [
            ("200 OK", &b"#EXTM3U\n"[..], "discovery-not-html"),
            ("200 OK", &b"\xff"[..], "discovery-invalid-utf8"),
            ("403 Forbidden", &b"Denied"[..], "http-403"),
        ] {
            let (url, handle) = fixture(
                &format!(
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                ),
                body,
            )
            .await;
            assert_eq!(fetch(&url, true).await.err().unwrap(), error);
            handle.await.unwrap();
        }
    }
}
