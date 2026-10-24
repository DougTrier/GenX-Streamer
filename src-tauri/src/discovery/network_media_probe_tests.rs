// Copyright 2026 Doug Trier
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

use super::*;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

struct Fixture {
    base: Url,
    task: tokio::task::JoinHandle<()>,
    count: std::sync::Arc<std::sync::atomic::AtomicUsize>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.task.abort();
    }
}
async fn fixture(routes: HashMap<String, (u16, Vec<u8>, Option<String>)>) -> Fixture {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
    let count = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let observed = count.clone();
    let task = tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let mut bytes = vec![0; 8192];
            let n = socket.read(&mut bytes).await.unwrap_or(0);
            let raw = String::from_utf8_lossy(&bytes[..n]);
            let path = raw
                .lines()
                .next()
                .and_then(|l| l.split_whitespace().nth(1))
                .unwrap_or("");
            observed.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let (status, body, range) =
                routes.get(path).cloned().unwrap_or((404, Vec::new(), None));
            let mut header = format!(
                "HTTP/1.1 {status} response\r\nContent-Length: {}\r\nConnection: close\r\n",
                body.len()
            );
            if let Some(range) = range {
                header.push_str(&format!("Content-Range: {range}\r\n"));
            }
            header.push_str("\r\n");
            let _ = socket.write_all(header.as_bytes()).await;
            let _ = socket.write_all(&body).await;
        }
    });
    Fixture { base, task, count }
}
fn ts() -> Vec<u8> {
    let mut b = vec![0; 564];
    for i in [0, 188, 376] {
        b[i] = 0x47;
    }
    b
}
fn media(uri: &str) -> Vec<u8> {
    format!("#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\n{uri}\n").into_bytes()
}

// This module's parts, by area, are in network_media_probe/tests/.
#[path = "network_media_probe/tests/connections.rs"]
mod connections;
#[path = "network_media_probe/tests/resources.rs"]
mod resources;
#[path = "network_media_probe/tests/retries.rs"]
mod retries;
