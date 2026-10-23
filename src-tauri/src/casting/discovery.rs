use super::{private_address, Endpoint};
use reqwest::Url;
use socket2::{Domain, Protocol, Socket, Type};
use std::{
    collections::{HashMap, HashSet},
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    time::{Duration, Instant},
};
use tokio::net::UdpSocket;
const SERVICE: &str = "_googlecast._tcp.local";

fn name(packet: &[u8], cursor: &mut usize) -> Result<String, &'static str> {
    let mut at = *cursor;
    let mut labels = Vec::new();
    let mut jumped = false;
    let mut visited = HashSet::new();
    for _ in 0..64 {
        if !visited.insert(at) {
            return Err("dns-pointer-loop");
        }
        let size = *packet.get(at).ok_or("dns-truncated")? as usize;
        at += 1;
        if size & 0xc0 == 0xc0 {
            let low = *packet.get(at).ok_or("dns-truncated")? as usize;
            if !jumped {
                *cursor = at + 1;
                jumped = true;
            }
            at = ((size & 63) << 8) | low;
            continue;
        }
        if size == 0 {
            if !jumped {
                *cursor = at;
            }
            let result = labels.join(".");
            if result.len() > 255 {
                return Err("dns-name-limit");
            }
            return Ok(result);
        }
        if size > 63 {
            return Err("dns-label-limit");
        }
        labels.push(
            std::str::from_utf8(packet.get(at..at + size).ok_or("dns-truncated")?)
                .map_err(|_| "dns-utf8")?
                .to_ascii_lowercase(),
        );
        at += size;
    }
    Err("dns-name-limit")
}
#[derive(Default)]
struct DnsCache {
    hosts: HashMap<String, IpAddr>,
    services: HashMap<String, (String, u16)>,
    names: HashMap<String, String>,
    ids: HashMap<String, String>,
    models: HashMap<String, String>,
    instances: HashSet<String>,
}
impl DnsCache {
    fn ingest(&mut self, packet: &[u8]) -> Result<(), &'static str> {
        if packet.len() < 12 || packet.len() > 9000 {
            return Err("dns-packet-limit");
        }
        let u16_at = |at| u16::from_be_bytes([packet[at], packet[at + 1]]) as usize;
        let questions = u16_at(4);
        let records = u16_at(6) + u16_at(8) + u16_at(10);
        if questions + records > 256 {
            return Err("dns-record-limit");
        }
        let mut at = 12;
        for _ in 0..questions {
            name(packet, &mut at)?;
            at = at.checked_add(4).ok_or("dns-truncated")?;
            if at > packet.len() {
                return Err("dns-truncated");
            }
        }
        for _ in 0..records {
            let owner = name(packet, &mut at)?;
            let header = packet.get(at..at + 10).ok_or("dns-truncated")?;
            let kind = u16::from_be_bytes([header[0], header[1]]);
            let size = u16::from_be_bytes([header[8], header[9]]) as usize;
            at += 10;
            let body = packet.get(at..at + size).ok_or("dns-truncated")?;
            match kind {
                12 if owner == SERVICE => {
                    let mut target = at;
                    let instance = name(packet, &mut target)?;
                    if target > at + size {
                        return Err("dns-rdata-truncated");
                    }
                    if instance.ends_with(&format!(".{SERVICE}")) && self.instances.len() < 100 {
                        self.instances.insert(instance);
                    }
                }
                1 if size == 4 => {
                    let ip = IpAddr::V4(Ipv4Addr::new(body[0], body[1], body[2], body[3]));
                    if private_address(ip)
                        && (self.hosts.len() < 200 || self.hosts.contains_key(&owner))
                    {
                        self.hosts.insert(owner, ip);
                    }
                }
                28 if size == 16 => {
                    let ip = IpAddr::V6(Ipv6Addr::from(
                        <[u8; 16]>::try_from(body).map_err(|_| "dns-truncated")?,
                    ));
                    if private_address(ip)
                        && (self.hosts.len() < 200 || self.hosts.contains_key(&owner))
                    {
                        // Prefer IPv4 when both families are available. ULA IPv6
                        // addresses are usable without a link-local scope index.
                        self.hosts.entry(owner).or_insert(ip);
                    }
                }
                33 if size >= 7 && owner.ends_with(&format!(".{SERVICE}")) => {
                    let port = u16::from_be_bytes([body[4], body[5]]);
                    let mut target = at + 6;
                    let host = name(packet, &mut target)?;
                    if target > at + size {
                        return Err("dns-rdata-truncated");
                    }
                    if port > 0 && (self.services.len() < 100 || self.services.contains_key(&owner))
                    {
                        self.services.insert(owner, (host, port));
                    }
                }
                16 if owner.ends_with(&format!(".{SERVICE}")) => {
                    let mut offset = 0;
                    while offset < body.len() {
                        let length = body[offset] as usize;
                        offset += 1;
                        let txt = body.get(offset..offset + length).ok_or("dns-txt")?;
                        offset += length;
                        if let Ok(value) = std::str::from_utf8(txt) {
                            for (prefix, map, cap) in
                                [("id=", &mut self.ids, 512), ("md=", &mut self.models, 128)]
                            {
                                if let Some(v) = value.strip_prefix(prefix) {
                                    if !v.is_empty()
                                        && v.len() <= cap
                                        && !v.chars().any(char::is_control)
                                        && (map.len() < 100 || map.contains_key(&owner))
                                    {
                                        map.insert(owner.clone(), v.into());
                                    }
                                }
                            }
                            if let Some(friendly) = value.strip_prefix("fn=") {
                                if friendly.len() <= 512
                                    && (self.names.len() < 100 || self.names.contains_key(&owner))
                                {
                                    self.names.insert(owner.clone(), friendly.to_owned());
                                }
                            }
                        }
                    }
                }
                _ => {}
            }
            at += size;
        }
        Ok(())
    }
    fn questions(&self) -> Vec<(String, u16)> {
        let mut questions = vec![(SERVICE.to_owned(), 12)];
        for instance in &self.instances {
            if !self.services.contains_key(instance) {
                questions.push((instance.clone(), 33));
            }
            if !self.names.contains_key(instance) {
                questions.push((instance.clone(), 16));
            }
        }
        for (host, _) in self.services.values() {
            if !self.hosts.contains_key(host) {
                questions.push((host.clone(), 1));
                questions.push((host.clone(), 28));
            }
        }
        questions.sort();
        questions.dedup();
        questions
    }
    fn endpoints(&self) -> Vec<Endpoint> {
        let mut services: Vec<_> = self.services.iter().collect();
        services.sort_by_key(|(service, _)| *service);
        services
            .into_iter()
            .filter_map(|(service, (host, port))| {
                self.hosts.get(host).map(|ip| Endpoint::Chromecast {
                    name: self
                        .names
                        .get(service)
                        .cloned()
                        .unwrap_or_else(|| "Cast receiver".into()),
                    address: std::net::SocketAddr::new(*ip, *port),
                    protocol_id: self.ids.get(service).cloned(),
                    model: self.models.get(service).cloned(),
                    instance: Some(service.clone()),
                })
            })
            .take(100)
            .collect()
    }
}
pub struct DiscoveryReport {
    pub endpoints: Vec<Endpoint>,
    pub errors: Vec<&'static str>,
}
fn query(questions: &[(String, u16)], unicast: bool) -> Vec<u8> {
    let mut packet = vec![0; 12];
    packet[4..6].copy_from_slice(&(questions.len() as u16).to_be_bytes());
    for (value, kind) in questions {
        for label in value.split('.') {
            packet.push(label.len() as u8);
            packet.extend_from_slice(label.as_bytes());
        }
        packet.push(0);
        packet.extend_from_slice(&kind.to_be_bytes());
        packet.extend_from_slice(&(if unicast { 0x8001u16 } else { 1u16 }).to_be_bytes());
    }
    packet
}
fn interfaces() -> Result<Vec<Ipv4Addr>, &'static str> {
    let mut addresses: Vec<_> = if_addrs::get_if_addrs()
        .map_err(|_| "cast-discovery-interfaces")?
        .into_iter()
        .filter_map(|interface| match interface.ip() {
            IpAddr::V4(ip) if private_address(IpAddr::V4(ip)) => Some(ip),
            _ => None,
        })
        .collect();
    addresses.sort();
    addresses.dedup();
    // Bound sockets and outgoing work even on hosts with many virtual adapters.
    if addresses.len() > 16 {
        return Err("cast-discovery-interface-limit");
    }
    if addresses.is_empty() {
        return Err("cast-discovery-no-lan-interface");
    }
    Ok(addresses)
}
fn udp(bind: SocketAddr, reuse: bool) -> std::io::Result<std::net::UdpSocket> {
    let socket = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))?;
    socket.set_reuse_address(reuse)?;
    socket.bind(&bind.into())?;
    socket.set_nonblocking(true)?;
    socket.set_multicast_ttl_v4(255)?;
    Ok(socket.into())
}
fn push_error(errors: &mut Vec<&'static str>, error: &'static str) {
    if !errors.contains(&error) {
        errors.push(error);
    }
}
/// Explicit bounded scan. All sockets are stack-owned; cancellation drops them
/// immediately, with no detached receive task or permanent multicast browser.
pub async fn chromecast_report() -> DiscoveryReport {
    let deadline = Instant::now() + Duration::from_secs(8);
    let mut errors = Vec::new();
    let addresses = match interfaces() {
        Ok(addresses) => addresses,
        Err(error) => {
            return DiscoveryReport {
                endpoints: Vec::new(),
                errors: vec![error],
            }
        }
    };
    let group = Ipv4Addr::new(224, 0, 0, 251);
    let destination = SocketAddr::from((group, 5353));
    let mut listeners = Vec::new();
    // Receive announcements and multicast replies as well as legacy unicast.
    match udp(SocketAddr::from((Ipv4Addr::UNSPECIFIED, 5353)), true) {
        Ok(socket) => {
            let mut joined = false;
            for address in &addresses {
                if socket.join_multicast_v4(&group, address).is_ok() {
                    joined = true;
                } else {
                    push_error(&mut errors, "cast-discovery-membership");
                }
            }
            if joined {
                listeners.push(socket);
            }
        }
        Err(_) => push_error(&mut errors, "cast-discovery-multicast-bind"),
    }
    let mut senders = Vec::new();
    for address in addresses {
        match udp(SocketAddr::from((address, 0)), false) {
            Ok(socket) => {
                if socket2::SockRef::from(&socket)
                    .set_multicast_if_v4(&address)
                    .is_err()
                {
                    push_error(&mut errors, "cast-discovery-interface-send");
                } else {
                    senders.push(socket);
                }
            }
            Err(_) => push_error(&mut errors, "cast-discovery-interface-bind"),
        }
    }
    if senders.is_empty() {
        return DiscoveryReport {
            endpoints: Vec::new(),
            errors,
        };
    }
    let mut buffer = [0; 9000];
    let mut cache = DnsCache::default();
    let mut packets = 0usize;
    let mut next_query = Instant::now();
    let mut rounds = 0usize;
    while Instant::now() < deadline && packets < 2048 {
        if Instant::now() >= next_query && rounds < 8 {
            for questions in cache.questions().chunks(16) {
                let packet = query(questions, true);
                for socket in &senders {
                    if socket.send_to(&packet, destination).is_err() {
                        push_error(&mut errors, "cast-discovery-send");
                    }
                }
            }
            rounds += 1;
            next_query = Instant::now() + Duration::from_secs(1);
        }
        for socket in listeners.iter().chain(senders.iter()) {
            for _ in 0..32 {
                if packets >= 2048 {
                    break;
                }
                match socket.recv_from(&mut buffer) {
                    Ok((size, peer)) => {
                        packets += 1;
                        if private_address(peer.ip()) {
                            let _ = cache.ingest(&buffer[..size]);
                        }
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => break,
                    Err(_) => {
                        push_error(&mut errors, "cast-discovery-receive");
                        break;
                    }
                }
            }
        }
        tokio::time::sleep(
            Duration::from_millis(25).min(deadline.saturating_duration_since(Instant::now())),
        )
        .await;
    }
    if packets >= 2048 {
        push_error(&mut errors, "cast-discovery-packet-limit");
    }
    DiscoveryReport {
        endpoints: cache.endpoints(),
        errors,
    }
}
fn ssdp_location(packet: &[u8], peer: IpAddr) -> Option<Url> {
    if packet.len() > 8192 || !private_address(peer) {
        return None;
    }
    let text = std::str::from_utf8(packet).ok()?;
    if !text.lines().next()?.starts_with("HTTP/1.1 200") {
        return None;
    }
    let mut locations = text.lines().filter_map(|line| {
        let (key, value) = line.split_once(':')?;
        key.eq_ignore_ascii_case("location").then_some(value.trim())
    });
    let raw = locations.next()?;
    if locations.next().is_some() {
        return None;
    }
    let url = Url::parse(raw).ok()?;
    let host = url.host_str()?.parse::<IpAddr>().ok()?;
    (host == peer
        && url.scheme() == "http"
        && url.username().is_empty()
        && url.password().is_none())
    .then_some(url)
}
pub async fn dlna() -> Result<Vec<Endpoint>, &'static str> {
    let socket = UdpSocket::bind("0.0.0.0:0")
        .await
        .map_err(|_| "dlna-discovery-bind")?;
    socket.send_to(b"M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\nMX: 2\r\nST: urn:schemas-upnp-org:device:MediaRenderer:1\r\n\r\n","239.255.255.250:1900").await.map_err(|_|"dlna-discovery-send")?;
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut buffer = [0; 8192];
    let mut locations = HashSet::new();
    let mut packets = 0;
    while Instant::now() < deadline && packets < 512 {
        match tokio::time::timeout(
            deadline.saturating_duration_since(Instant::now()),
            socket.recv_from(&mut buffer),
        )
        .await
        {
            Ok(Ok((size, peer))) => {
                packets += 1;
                if let Some(url) = ssdp_location(&buffer[..size], peer.ip()) {
                    if locations.len() < 100 {
                        locations.insert(url);
                    }
                }
            }
            _ => break,
        }
    }
    let mut endpoints = Vec::new();
    for location in locations {
        if let Ok(endpoint) = super::dlna::describe(location).await {
            endpoints.push(endpoint);
        }
    }
    Ok(endpoints)
}
// Selected-target query only: it never launches a receiver application.
pub(super) async fn recheck_receiver(
    address: std::net::SocketAddr,
    instance: Option<&str>,
    id: Option<&str>,
    model: Option<&str>,
) -> Result<&'static str, &'static str> {
    let (Some(instance), Some(id)) = (instance, id) else {
        return Ok("unavailable");
    };
    recheck_target(
        std::net::SocketAddr::new(address.ip(), 5353),
        instance,
        id,
        model,
        Duration::from_secs(3),
    )
    .await
}
async fn recheck_target(
    target: std::net::SocketAddr,
    instance: &str,
    id: &str,
    model: Option<&str>,
    budget: Duration,
) -> Result<&'static str, &'static str> {
    let bind = if target.is_ipv4() {
        "0.0.0.0:0"
    } else {
        "[::]:0"
    };
    let Ok(socket) = tokio::net::UdpSocket::bind(bind).await else {
        return Ok("unavailable");
    };
    let packet = query(&[(instance.into(), 16)], true);
    if socket.send_to(&packet, target).await.is_err() {
        return Ok("unavailable");
    }
    // Some Android TVs (Google TV Streamer, Realtek sets) ignore a question sent
    // straight to them and answer only the same question asked of the mDNS
    // group. Their reply still comes from the TV to this socket, and only the
    // selected TV's answer is read below (October 19, 2026 measurement).
    if let std::net::SocketAddr::V4(v4) = target {
        if v4.port() == 5353 {
            let route = std::net::UdpSocket::bind("0.0.0.0:0").and_then(|route| {
                route.connect(target)?;
                route.local_addr()
            });
            if let Ok(std::net::SocketAddr::V4(local)) = route {
                let _ = socket2::SockRef::from(&socket).set_multicast_if_v4(local.ip());
            }
            let _ = socket
                .send_to(&packet, (std::net::Ipv4Addr::new(224, 0, 0, 251), 5353))
                .await;
        }
    }
    let observe = async {
        let mut bytes = [0u8; 9000];
        for _ in 0..32 {
            let (size, peer) = socket
                .recv_from(&mut bytes)
                .await
                .map_err(|_| "cast-identity-probe")?;
            if peer != target {
                continue;
            }
            let mut cache = DnsCache::default();
            if cache.ingest(&bytes[..size]).is_err() {
                continue;
            }
            if let Some(actual) = cache.ids.get(instance) {
                if actual != id
                    || model.is_some_and(|expected| {
                        cache
                            .models
                            .get(instance)
                            .is_some_and(|actual| actual != expected)
                    })
                {
                    return Err("cast-receiver-identity-changed");
                }
                if model.is_some() && !cache.models.contains_key(instance) {
                    return Ok("unavailable");
                }
                return Ok("matched");
            }
        }
        Ok("unavailable")
    };
    match tokio::time::timeout(budget, observe).await {
        Ok(result) => result,
        Err(_) => Ok("unavailable"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn encoded_name(value: &str) -> Vec<u8> {
        let mut result = Vec::new();
        for label in value.split('.') {
            result.push(label.len() as u8);
            result.extend_from_slice(label.as_bytes());
        }
        result.push(0);
        result
    }
    fn answer(owner: &str, kind: u16, body: Vec<u8>) -> Vec<u8> {
        let mut packet = vec![0; 12];
        packet[2] = 128;
        packet[7] = 1;
        packet.extend(encoded_name(owner));
        packet.extend(kind.to_be_bytes());
        packet.extend(1u16.to_be_bytes());
        packet.extend(120u32.to_be_bytes());
        packet.extend((body.len() as u16).to_be_bytes());
        packet.extend(body);
        packet
    }
    #[tokio::test]
    async fn selected_target_txt_rechecks_exact_identity_without_launching_or_loading() {
        for (fields, expected) in [
            (vec!["id=receiver-A", "md=Model"], Ok("matched")),
            (
                vec!["id=receiver-B", "md=Model"],
                Err("cast-receiver-identity-changed"),
            ),
            (
                vec!["id=receiver-A", "md=Other"],
                Err("cast-receiver-identity-changed"),
            ),
            (vec!["fn=Same friendly name"], Ok("unavailable")),
        ] {
            let socket = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
            let target = socket.local_addr().unwrap();
            let instance = "room._googlecast._tcp.local";
            let response = answer(
                instance,
                16,
                fields
                    .iter()
                    .flat_map(|s| {
                        std::iter::once(s.len() as u8).chain(s.as_bytes().iter().copied())
                    })
                    .collect(),
            );
            let task = tokio::spawn(async move {
                let mut request = [0; 9000];
                let (size, peer) = socket.recv_from(&mut request).await.unwrap();
                assert_eq!(request[2], 0);
                assert!(!String::from_utf8_lossy(&request[..size]).contains("LOAD"));
                socket.send_to(&response, peer).await.unwrap();
            });
            assert_eq!(
                recheck_target(
                    target,
                    instance,
                    "receiver-A",
                    Some("Model"),
                    Duration::from_millis(50)
                )
                .await,
                expected
            );
            task.await.unwrap();
        }
    }
    #[tokio::test]
    async fn manual_receivers_remain_unverified_without_guessing_from_ip_or_name() {
        assert_eq!(
            recheck_receiver("192.168.1.9:8009".parse().unwrap(), None, None, None).await,
            Ok("unavailable")
        );
    }
    #[test]
    fn split_ptr_srv_and_late_address_require_followups_before_emitting_receiver() {
        let instance = "room._googlecast._tcp.local";
        let mut cache = DnsCache::default();
        cache
            .ingest(&answer(SERVICE, 12, encoded_name(instance)))
            .unwrap();
        assert!(cache.endpoints().is_empty());
        assert!(cache.questions().contains(&(instance.to_owned(), 33)));
        assert!(cache.questions().contains(&(instance.to_owned(), 16)));
        let mut srv = vec![0, 0, 0, 0];
        srv.extend(8009u16.to_be_bytes());
        srv.extend(encoded_name("receiver.local"));
        cache.ingest(&answer(instance, 33, srv)).unwrap();
        assert!(cache.endpoints().is_empty());
        assert!(cache
            .questions()
            .contains(&("receiver.local".to_owned(), 1)));
        assert!(cache
            .questions()
            .contains(&("receiver.local".to_owned(), 28)));
        cache
            .ingest(&answer("receiver.local", 1, vec![192, 168, 1, 5]))
            .unwrap();
        assert_eq!(cache.endpoints().len(), 1);
        assert!(!cache
            .questions()
            .contains(&("receiver.local".to_owned(), 1)));
    }
    #[test]
    fn resolves_ula_aaaa_and_prefers_ipv4_without_admitting_public_or_link_local_hosts() {
        let instance = "room._googlecast._tcp.local";
        let mut cache = DnsCache::default();
        let mut srv = vec![0, 0, 0, 0];
        srv.extend(8009u16.to_be_bytes());
        srv.extend(encoded_name("receiver.local"));
        cache.ingest(&answer(instance, 33, srv)).unwrap();
        for ip in ["2001:db8::1", "fe80::1"] {
            cache
                .ingest(&answer(
                    "receiver.local",
                    28,
                    ip.parse::<Ipv6Addr>().unwrap().octets().to_vec(),
                ))
                .unwrap();
        }
        assert!(cache.endpoints().is_empty());
        cache
            .ingest(&answer(
                "receiver.local",
                28,
                "fd00::5".parse::<Ipv6Addr>().unwrap().octets().to_vec(),
            ))
            .unwrap();
        assert!(
            matches!(&cache.endpoints()[0], Endpoint::Chromecast {address, ..} if address.is_ipv6())
        );
        cache
            .ingest(&answer("receiver.local", 1, vec![192, 168, 1, 5]))
            .unwrap();
        assert!(
            matches!(&cache.endpoints()[0], Endpoint::Chromecast {address, ..} if address.is_ipv4())
        );
    }
    #[test]
    fn malformed_rdata_cannot_take_a_name_from_the_next_record() {
        let mut packet = answer(SERVICE, 12, vec![3, b'a', b'b', b'c']);
        packet.push(0); // Outside declared PTR RDLENGTH.
        assert!(DnsCache::default().ingest(&packet).is_err());
    }
    #[test]
    fn query_retains_multicast_service_and_encodes_unicast_followups_deterministically() {
        let questions = vec![(SERVICE.to_owned(), 12), ("receiver.local".to_owned(), 28)];
        let packet = query(&questions, true);
        assert_eq!(u16::from_be_bytes([packet[4], packet[5]]), 2);
        let mut cursor = 12;
        assert_eq!(name(&packet, &mut cursor).unwrap(), SERVICE);
        assert_eq!(&packet[cursor..cursor + 4], &[0, 12, 128, 1]);
        cursor += 4;
        assert_eq!(name(&packet, &mut cursor).unwrap(), "receiver.local");
        assert_eq!(&packet[cursor..cursor + 4], &[0, 28, 128, 1]);
        assert_eq!(packet, query(&questions, true));
    }
    #[test]
    fn followups_are_bounded_and_do_not_truncate_later_receivers() {
        let mut cache = DnsCache::default();
        for index in 0..105 {
            cache
                .ingest(&answer(
                    SERVICE,
                    12,
                    encoded_name(&format!("receiver-{index:03}.{SERVICE}")),
                ))
                .unwrap();
        }
        assert_eq!(cache.instances.len(), 100);
        assert_eq!(cache.questions().len(), 201);
        assert!(cache
            .questions()
            .contains(&(format!("receiver-099.{SERVICE}"), 33)));
        assert!(cache
            .questions()
            .chunks(16)
            .all(|chunk| query(chunk, true).len() < 9000));
    }
    #[tokio::test]
    async fn canceled_owner_releases_actual_udp_bind_without_detached_receivers() {
        let (send, receive) = tokio::sync::oneshot::channel();
        let owner = tokio::spawn(async move {
            let socket = udp(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)), false).unwrap();
            send.send(socket.local_addr().unwrap()).unwrap();
            std::future::pending::<()>().await;
            drop(socket);
        });
        let address = receive.await.unwrap();
        assert!(udp(address, false).is_err());
        owner.abort();
        assert!(owner.await.unwrap_err().is_cancelled());
        assert!(udp(address, false).is_ok());
    }
    #[test]
    fn dns_pointer_cycles_and_truncation_refused() {
        assert!(name(&[192, 0], &mut 0).is_err());
        assert!(name(&[5, b'a'], &mut 0).is_err());
    }
    #[test]
    fn ssdp_is_bound_to_sender_address() {
        let reply = b"HTTP/1.1 200 OK\r\nLOCATION: http://192.168.1.5:80/device.xml\r\n\r\n";
        assert!(ssdp_location(reply, "192.168.1.5".parse().unwrap()).is_some());
        assert!(ssdp_location(reply, "192.168.1.6".parse().unwrap()).is_none());
        assert!(ssdp_location(reply, "127.0.0.1".parse().unwrap()).is_none());
    }
    #[test]
    fn actual_mdns_records_resolve_private_cast_endpoint() {
        fn wire_name(value: &str) -> Vec<u8> {
            let mut result = Vec::new();
            for label in value.split('.') {
                result.push(label.len() as u8);
                result.extend_from_slice(label.as_bytes());
            }
            result.push(0);
            result
        }
        fn record(packet: &mut Vec<u8>, owner: &str, kind: u16, body: Vec<u8>) {
            packet.extend(wire_name(owner));
            packet.extend(kind.to_be_bytes());
            packet.extend(1u16.to_be_bytes());
            packet.extend(120u32.to_be_bytes());
            packet.extend((body.len() as u16).to_be_bytes());
            packet.extend(body);
        }
        let mut packet = vec![0; 12];
        packet[2] = 128;
        packet[7] = 3;
        let mut srv = vec![0, 0, 0, 0];
        srv.extend(8009u16.to_be_bytes());
        srv.extend(wire_name("tv.local"));
        record(&mut packet, "room._googlecast._tcp.local", 33, srv);
        record(&mut packet, "tv.local", 1, vec![192, 168, 1, 5]);
        let mut txt = vec![10];
        txt.extend_from_slice(b"fn=Room TV");
        record(&mut packet, "room._googlecast._tcp.local", 16, txt);
        let mut cache = DnsCache::default();
        cache.ingest(&packet).unwrap();
        match &cache.endpoints()[0] {
            Endpoint::Chromecast { name, address, .. } => {
                assert_eq!(name, "Room TV");
                assert_eq!(address.to_string(), "192.168.1.5:8009");
            }
            _ => panic!(),
        }
    }
}
