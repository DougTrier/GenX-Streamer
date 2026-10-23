//! Bounded guide input admission. Extensions and MIME do not select decompression.
use flate2::read::MultiGzDecoder;
use std::{
    io::Read,
    sync::atomic::{AtomicBool, Ordering},
};

pub const INPUT_LIMIT: usize = 20 * 1024 * 1024;
pub const EXPANDED_LIMIT: usize = 64 * 1024 * 1024;

fn check_cancel(canceled: &AtomicBool) -> Result<(), String> {
    if canceled.load(Ordering::SeqCst) {
        Err("canceled".into())
    } else {
        Ok(())
    }
}

pub async fn fetch(url: &str, allow_http: bool, canceled: &AtomicBool) -> Result<Vec<u8>, String> {
    check_cancel(canceled)?;
    let response = crate::network::response(url, allow_http, None).await?;
    read_body(response, canceled).await
}
pub enum ConditionalFetch {
    Body(Vec<u8>, super::conditional::Validators),
    NotModified(super::conditional::Validators),
}
pub async fn fetch_conditional(
    url: &str,
    allow_http: bool,
    cached: Option<&super::conditional::CachedValidators>,
    canceled: &AtomicBool,
) -> Result<ConditionalFetch, String> {
    check_cancel(canceled)?;
    let validators = cached.map(|c| &c.validators);
    let response = crate::network::response_conditional(
        url,
        allow_http,
        validators.and_then(|v| v.etag.as_deref()),
        validators.and_then(|v| v.last_modified.as_deref()),
    )
    .await?;
    check_cancel(canceled)?;
    // Redirected bodies remain supported but cannot establish validators for
    // the original URI; later conditional redirects are refused at transport.
    let received = if reqwest::Url::parse(url).ok().as_ref() == Some(response.url()) {
        super::conditional::Validators::from_headers(response.headers())
    } else {
        super::conditional::Validators::default()
    };
    if response.status() == reqwest::StatusCode::NOT_MODIFIED {
        if cached.is_none() {
            return Err("guide-not-modified-without-cache".into());
        }
        return Ok(ConditionalFetch::NotModified(received));
    }
    Ok(ConditionalFetch::Body(
        read_body(response, canceled).await?,
        received,
    ))
}
async fn read_body(
    mut response: reqwest::Response,
    canceled: &AtomicBool,
) -> Result<Vec<u8>, String> {
    if !response.status().is_success() {
        return Err(format!("http-{}", response.status().as_u16()));
    }
    if response
        .content_length()
        .is_some_and(|n| n > INPUT_LIMIT as u64)
    {
        return Err("guide-input-too-large".into());
    }
    if response
        .headers()
        .get(reqwest::header::CONTENT_ENCODING)
        .is_some_and(|encoding| {
            !encoding.to_str().is_ok_and(|value| {
                let codings: Vec<_> = value
                    .split(',')
                    .map(|v| v.trim().to_ascii_lowercase())
                    .collect();
                codings.len() <= 2
                    && codings
                        .iter()
                        .all(|coding| matches!(coding.as_str(), "identity" | "gzip" | "x-gzip"))
            })
        })
    {
        return Err("guide-content-encoding-unsupported".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "guide-read-failed".to_string())?
    {
        check_cancel(canceled)?;
        if chunk.len() > INPUT_LIMIT.saturating_sub(bytes.len()) {
            return Err("guide-input-too-large".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    check_cancel(canceled)?;
    Ok(bytes)
}

/// Call on a blocking worker, with the same cancellation flag as the parse/publication owner.
pub fn expand(bytes: Vec<u8>, canceled: &AtomicBool) -> Result<Vec<u8>, String> {
    expand_with_limit(bytes, canceled, INPUT_LIMIT, EXPANDED_LIMIT)
}

fn expand_with_limit(
    mut bytes: Vec<u8>,
    canceled: &AtomicBool,
    input_limit: usize,
    expanded_limit: usize,
) -> Result<Vec<u8>, String> {
    check_cancel(canceled)?;
    if bytes.len() > input_limit {
        return Err("guide-input-too-large".into());
    }
    for _ in 0..2 {
        check_cancel(canceled)?;
        if !bytes.starts_with(&[0x1f, 0x8b]) {
            if bytes.len() > expanded_limit {
                return Err("guide-expanded-too-large".into());
            }
            return Ok(bytes);
        }
        let mut decoder = MultiGzDecoder::new(bytes.as_slice());
        let mut expanded = Vec::new();
        let mut chunk = [0u8; 64 * 1024];
        loop {
            check_cancel(canceled)?;
            let read = decoder
                .read(&mut chunk)
                .map_err(|_| "guide-gzip-invalid".to_string())?;
            if read == 0 {
                break;
            }
            if read > expanded_limit.saturating_sub(expanded.len()) {
                return Err("guide-expanded-too-large".into());
            }
            expanded.extend_from_slice(&chunk[..read]);
        }
        bytes = expanded;
    }
    check_cancel(canceled)?;
    if bytes.starts_with(&[0x1f, 0x8b]) {
        return Err("guide-gzip-layers-unsupported".into());
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::{write::GzEncoder, Compression};
    use std::io::Write;
    fn gzip(bytes: &[u8]) -> Vec<u8> {
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(bytes).unwrap();
        encoder.finish().unwrap()
    }
    #[test]
    fn magic_admits_plain_and_gzip_without_filename_or_mime() {
        let canceled = AtomicBool::new(false);
        let plain = b"<tv></tv>";
        assert_eq!(expand(plain.to_vec(), &canceled).unwrap(), plain);
        assert_eq!(expand(gzip(plain), &canceled).unwrap(), plain);
        assert_eq!(expand(gzip(&gzip(plain)), &canceled).unwrap(), plain);
        assert_eq!(
            expand(gzip(&gzip(&gzip(plain))), &canceled).unwrap_err(),
            "guide-gzip-layers-unsupported"
        );
        let mut members = gzip(b"<tv>");
        members.extend(gzip(b"</tv>"));
        assert_eq!(expand(members, &canceled).unwrap(), plain);
    }
    #[test]
    fn expansion_limits_and_damaged_gzip_fail_without_partial_success() {
        let canceled = AtomicBool::new(false);
        assert_eq!(
            expand_with_limit(vec![0; 9], &canceled, 8, 32).unwrap_err(),
            "guide-input-too-large"
        );
        assert_eq!(
            expand_with_limit(gzip(&[b'x'; 1024]), &canceled, 100, 128).unwrap_err(),
            "guide-expanded-too-large"
        );
        let mut damaged = gzip(b"<tv></tv>");
        damaged.pop();
        assert_eq!(
            expand(damaged, &canceled).unwrap_err(),
            "guide-gzip-invalid"
        );
        let mut trailing = gzip(b"<tv></tv>");
        let mut damaged_inner = gzip(b"<tv></tv>");
        damaged_inner.pop();
        assert_eq!(
            expand(gzip(&damaged_inner), &canceled).unwrap_err(),
            "guide-gzip-invalid"
        );
        assert_eq!(
            expand_with_limit(gzip(&gzip(&[b'x'; 1024])), &canceled, 200, 128).unwrap_err(),
            "guide-expanded-too-large"
        );
        assert_eq!(
            expand_with_limit(gzip(&gzip(b"<tv/>")), &canceled, 200, 8).unwrap_err(),
            "guide-expanded-too-large"
        );
        trailing.extend(b"untrusted trailer");
        assert_eq!(
            expand(trailing, &canceled).unwrap_err(),
            "guide-gzip-invalid"
        );
    }
    #[test]
    fn pre_cancellation_refuses_all_input() {
        let canceled = AtomicBool::new(true);
        assert_eq!(
            expand(b"<tv/>".to_vec(), &canceled).unwrap_err(),
            "canceled"
        );
        assert_eq!(expand(gzip(b"<tv/>"), &canceled).unwrap_err(), "canceled");
        assert_eq!(
            expand(gzip(&gzip(b"<tv/>")), &canceled).unwrap_err(),
            "canceled"
        );
    }
    fn serve_once(body: Vec<u8>, headers: String) -> (String, std::thread::JoinHandle<()>) {
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                .unwrap();
            let mut request = [0u8; 4096];
            let _ = stream.read(&mut request).unwrap();
            stream
                .write_all(
                    format!("HTTP/1.1 200 OK\r\n{headers}Connection: close\r\n\r\n").as_bytes(),
                )
                .unwrap();
            stream.write_all(&body).unwrap();
        });
        (format!("http://{address}/guide-without-extension"), server)
    }
    #[tokio::test]
    async fn actual_http_gzip_admission_preserves_bytes_and_size_refusal() {
        let raw = gzip(b"<tv></tv>");
        let (url, server) = serve_once(
            raw.clone(),
            format!(
                "Content-Length: {}\r\nContent-Encoding: gzip\r\n",
                raw.len()
            ),
        );
        let canceled = AtomicBool::new(false);
        let fetched = fetch(&url, true, &canceled).await.unwrap();
        server.join().unwrap();
        assert_eq!(fetched, raw);
        assert_eq!(expand(fetched, &canceled).unwrap(), b"<tv></tv>");
        let double = gzip(&gzip(b"<tv></tv>"));
        let (url, server) = serve_once(
            double.clone(),
            format!(
                "Content-Length: {}\r\nContent-Encoding: gzip\r\n",
                double.len()
            ),
        );
        assert_eq!(
            expand(fetch(&url, true, &canceled).await.unwrap(), &canceled).unwrap(),
            b"<tv></tv>"
        );
        server.join().unwrap();
        let (url, server) = serve_once(
            Vec::new(),
            format!("Content-Length: {}\r\n", INPUT_LIMIT + 1),
        );
        assert_eq!(
            fetch(&url, true, &canceled).await.unwrap_err(),
            "guide-input-too-large"
        );
        server.join().unwrap();
        let (url, server) = serve_once(
            Vec::new(),
            "Content-Length: 0\r\nContent-Encoding: br\r\n".into(),
        );
        assert_eq!(
            fetch(&url, true, &canceled).await.unwrap_err(),
            "guide-content-encoding-unsupported"
        );
        server.join().unwrap();
    }
}
