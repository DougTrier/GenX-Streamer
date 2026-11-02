// Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0
//! A native player's bounded connection pool, pinned to freshly checked DNS.
use crate::sharing_policy::public_upstream;
use reqwest::{header::RANGE, redirect::Policy, Url};
use std::{net::SocketAddr, sync::Mutex, time::Duration};
type Key = (String, String, u16, Vec<SocketAddr>);
pub(crate) struct Clients {
    entries: Mutex<Option<Vec<(Key, reqwest::Client)>>>,
}
impl Default for Clients {
    fn default() -> Self {
        Self::new()
    }
}
impl Clients {
    pub(crate) fn new() -> Self {
        Self {
            entries: Mutex::new(Some(Vec::new())),
        }
    }
    fn client(&self, url: &Url, addresses: &[SocketAddr]) -> Result<reqwest::Client, &'static str> {
        let host = url.host_str().ok_or("upstream-host-refused")?;
        let port = url.port_or_known_default().ok_or("upstream-port-refused")?;
        let mut pins = addresses.to_vec();
        pins.sort();
        pins.dedup();
        let key = (url.scheme().to_owned(), host.to_owned(), port, pins.clone());
        let mut guard = self.entries.lock().map_err(|_| "upstream-client-lock")?;
        let entries = guard.as_mut().ok_or("upstream-session-closed")?;
        if let Some(index) = entries.iter().position(|(k, _)| k == &key) {
            let entry = entries.remove(index);
            let client = entry.1.clone();
            entries.push(entry);
            return Ok(client);
        }
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(Policy::none())
            .resolve_to_addrs(host, &pins)
            .connect_timeout(Duration::from_secs(5))
            .read_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(20))
            .pool_idle_timeout(Duration::from_secs(30))
            .pool_max_idle_per_host(2)
            .build()
            .map_err(|_| "upstream-client-failed")?;
        if entries.len() == 8 {
            entries.remove(0);
        }
        entries.push((key, client.clone()));
        Ok(client)
    }
    pub(crate) fn close(&self) {
        if let Ok(mut entries) = self.entries.lock() {
            *entries = None;
        }
    }
    pub(crate) async fn request(
        &self,
        url: Url,
        range: Option<String>,
        deadline: tokio::time::Instant,
    ) -> Result<reqwest::Response, &'static str> {
        let host = url.host_str().ok_or("upstream-host-refused")?;
        let port = url.port_or_known_default().ok_or("upstream-port-refused")?;
        // Resolve every request/redirect, before considering an idle connection.
        let addresses: Vec<SocketAddr> = tokio::net::lookup_host((host, port))
            .await
            .map_err(|_| "upstream-dns-failed")?
            .collect();
        if addresses.is_empty()
            || addresses.len() > 128
            || addresses.iter().any(|a| !public_upstream(a.ip()))
        {
            return Err("upstream-address-refused");
        }
        if tokio::time::Instant::now() >= deadline {
            return Err("upstream-timeout");
        }
        let client = self.client(&url, &addresses)?;
        let mut request = client.get(url);
        if let Some(range) = range {
            request = request.header(RANGE, range)
        }
        request.send().await.map_err(|error| {
            if error.is_timeout() {
                "upstream-timeout"
            } else if error.is_connect() {
                "upstream-connect-failed"
            } else {
                "upstream-network-failed"
            }
        })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    #[tokio::test]
    async fn two_bodies_reuse_one_tcp_connection_and_close_releases_idle_connection() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            for _ in 0..2 {
                let mut header = Vec::new();
                while !header.ends_with(b"\r\n\r\n") {
                    let mut byte = [0];
                    socket.read_exact(&mut byte).await.unwrap();
                    header.push(byte[0]);
                    assert!(header.len() < 8192);
                }
                socket
                    .write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: keep-alive\r\n\r\nok",
                    )
                    .await
                    .unwrap();
            }
            let mut byte = [0];
            assert_eq!(
                tokio::time::timeout(Duration::from_secs(2), socket.read(&mut byte))
                    .await
                    .unwrap()
                    .unwrap(),
                0
            );
            assert!(
                tokio::time::timeout(Duration::from_millis(100), listener.accept())
                    .await
                    .is_err()
            );
        });
        let pool = Clients::new();
        let url = Url::parse(&format!(
            "http://fixture.invalid:{}/segment",
            address.port()
        ))
        .unwrap();
        // Private test injection into the client factory; production calls it
        // only after public-address validation in request().
        for _ in 0..2 {
            let client = pool.client(&url, &[address]).unwrap();
            assert_eq!(
                client
                    .get(url.clone())
                    .send()
                    .await
                    .unwrap()
                    .bytes()
                    .await
                    .unwrap()
                    .as_ref(),
                b"ok"
            );
        }
        pool.close();
        server.await.unwrap();
        assert!(pool.client(&url, &[address]).is_err());
    }
    #[test]
    fn pin_sets_and_origins_are_distinct_bounded_and_revocable() {
        let pool = Clients::new();
        let url = Url::parse("https://fixture.invalid/media").unwrap();
        pool.client(&url, &["8.8.8.8:443".parse().unwrap()])
            .unwrap();
        pool.client(&url, &["1.1.1.1:443".parse().unwrap()])
            .unwrap();
        assert_eq!(pool.entries.lock().unwrap().as_ref().unwrap().len(), 2);
        for index in 0..20 {
            let url = Url::parse(&format!("https://host{index}.invalid/media")).unwrap();
            pool.client(&url, &["8.8.8.8:443".parse().unwrap()])
                .unwrap();
        }
        assert_eq!(pool.entries.lock().unwrap().as_ref().unwrap().len(), 8);
        pool.close();
        assert!(pool.entries.lock().unwrap().is_none());
    }
    #[tokio::test]
    async fn production_request_still_refuses_private_destinations() {
        let pool = Clients::new();
        let result = pool
            .request(
                Url::parse("http://127.0.0.1:9/media").unwrap(),
                None,
                tokio::time::Instant::now() + Duration::from_secs(1),
            )
            .await;
        assert_eq!(result.err(), Some("upstream-address-refused"));
    }
}
