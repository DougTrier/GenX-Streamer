use super::{Endpoint, MediaSelection, ReceiverState};
use quick_xml::{events::Event, Reader};
use reqwest::{redirect::Policy, Url};
use std::time::Duration;

fn client() -> Result<reqwest::Client, &'static str> {
    reqwest::Client::builder()
        .no_proxy()
        .redirect(Policy::none())
        .connect_timeout(Duration::from_secs(2))
        .timeout(Duration::from_secs(4))
        .build()
        .map_err(|_| "dlna-client")
}
async fn bounded_body(mut response: reqwest::Response) -> Result<String, &'static str> {
    if !response.status().is_success() {
        return Err("dlna-http-action-failed");
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "dlna-response")? {
        if body.len() + chunk.len() > 256 * 1024 {
            return Err("dlna-response-limit");
        }
        body.extend_from_slice(&chunk);
    }
    String::from_utf8(body).map_err(|_| "dlna-xml-utf8")
}
fn xml_values(xml: &str) -> Result<Vec<(String, String)>, &'static str> {
    if xml.len() > 256 * 1024 {
        return Err("dlna-xml-limit");
    }
    let mut reader = Reader::from_str(xml);
    let mut stack: Vec<(String, String)> = Vec::new();
    let mut values = Vec::new();
    loop {
        match reader.read_event().map_err(|_| "dlna-xml-invalid")? {
            Event::Start(event) => {
                if stack.len() >= 32 {
                    return Err("dlna-xml-depth");
                }
                stack.push((
                    String::from_utf8_lossy(event.local_name().as_ref()).into_owned(),
                    String::new(),
                ));
            }
            Event::Text(event) => {
                let text = event.decode().map_err(|_| "dlna-xml-invalid")?;
                if let Some((_, value)) = stack.last_mut() {
                    value.push_str(&text);
                }
            }
            Event::CData(event) => {
                let text = event.decode().map_err(|_| "dlna-xml-invalid")?;
                if let Some((_, value)) = stack.last_mut() {
                    value.push_str(&text);
                }
            }
            Event::End(_) => {
                let (tag, value) = stack.pop().ok_or("dlna-xml-invalid")?;
                if !value.trim().is_empty() {
                    values.push((tag, value.trim().into()));
                }
            }
            Event::DocType(_) => return Err("dlna-xml-dtd-refused"),
            Event::GeneralRef(event) => {
                let text = reference(&event)?;
                if let Some((_, value)) = stack.last_mut() {
                    value.push_str(&text);
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    if !stack.is_empty() {
        return Err("dlna-xml-invalid");
    }
    Ok(values)
}
fn reference(event: &quick_xml::events::BytesRef<'_>) -> Result<String, &'static str> {
    if let Some(character) = event.resolve_char_ref().map_err(|_| "dlna-xml-entity")? {
        return Ok(character.to_string());
    }
    match event.decode().map_err(|_| "dlna-xml-entity")?.as_ref() {
        "amp" => Ok("&".into()),
        "lt" => Ok("<".into()),
        "gt" => Ok(">".into()),
        "quot" => Ok("\"".into()),
        "apos" => Ok("'".into()),
        _ => Err("dlna-xml-entity-refused"),
    }
}
pub(super) async fn describe(location: Url) -> Result<Endpoint, &'static str> {
    let xml = bounded_body(
        client()?
            .get(location.clone())
            .send()
            .await
            .map_err(|_| "dlna-description")?,
    )
    .await?;
    parse_description(&xml, &location)
}
fn parse_description(xml: &str, location: &Url) -> Result<Endpoint, &'static str> {
    // An embedded device tree needs service-specific UDN binding; never attribute a nested renderer to its parent's identity.
    let mut shape = Reader::from_str(xml);
    let mut devices = 0;
    loop {
        match shape.read_event().map_err(|_| "dlna-xml-invalid")? {
            Event::Start(e) if e.local_name().as_ref() == b"device" => {
                devices += 1;
                if devices > 1 {
                    return Err("dlna-embedded-device-identity-unsupported");
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    let values = xml_values(xml)?;
    let name = values
        .iter()
        .find(|(tag, _)| tag == "friendlyName")
        .map(|(_, value)| value.clone())
        .filter(|name| !name.is_empty() && name.len() <= 512)
        .ok_or("dlna-device-name")?;
    let metadata = |key: &str, cap: usize| {
        values
            .iter()
            .find(|(tag, _)| tag == key)
            .map(|(_, v)| v.clone())
            .filter(|v| !v.is_empty() && v.len() <= cap && !v.chars().any(char::is_control))
    };
    let protocol_id = metadata("UDN", 512);
    let model = metadata("modelName", 128);
    // Parse service boundaries separately so a controlURL from another service cannot be paired with AVTransport.
    let mut reader = Reader::from_str(xml);
    let mut in_service = false;
    let mut tag = String::new();
    let mut kind = String::new();
    let mut control = String::new();
    loop {
        match reader.read_event().map_err(|_| "dlna-xml-invalid")? {
            Event::Start(event) => {
                tag = String::from_utf8_lossy(event.local_name().as_ref()).into_owned();
                if tag == "service" {
                    in_service = true;
                    kind.clear();
                    control.clear();
                }
            }
            Event::Text(event) if in_service => {
                let value = event.decode().map_err(|_| "dlna-xml-invalid")?;
                let value = quick_xml::escape::unescape(&value).map_err(|_| "dlna-xml-entity")?;
                match tag.as_str() {
                    "serviceType" => kind.push_str(value.trim()),
                    "controlURL" => control.push_str(value.trim()),
                    _ => {}
                }
            }
            Event::GeneralRef(event) if in_service => {
                let value = reference(&event)?;
                match tag.as_str() {
                    "serviceType" => kind.push_str(&value),
                    "controlURL" => control.push_str(&value),
                    _ => {}
                }
            }
            Event::End(event) if event.local_name().as_ref() == b"service" => {
                in_service = false;
                if kind.starts_with("urn:schemas-upnp-org:service:AVTransport:") {
                    let url = location.join(&control).map_err(|_| "dlna-control-url")?;
                    if control.is_empty()
                        || url.host_str() != location.host_str()
                        || url.scheme() != "http"
                        || !url.username().is_empty()
                        || url.password().is_some()
                    {
                        return Err("dlna-control-policy");
                    }
                    return Ok(Endpoint::Dlna {
                        name,
                        control: url,
                        service: kind,
                        description: location.clone(),
                        protocol_id,
                        model,
                    });
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    Err("dlna-avtransport-missing")
}
fn escape(value: &str) -> String {
    quick_xml::escape::escape(value).into_owned()
}
pub struct Session {
    client: reqwest::Client,
    control: Url,
    service: String,
    owned_uri: Option<String>,
}
impl Session {
    pub fn new(control: Url, service: String) -> Result<Self, &'static str> {
        Ok(Self {
            client: client()?,
            control,
            service,
            owned_uri: None,
        })
    }
    async fn action(
        &self,
        name: &str,
        arguments: &str,
    ) -> Result<Vec<(String, String)>, &'static str> {
        let body=format!("<?xml version=\"1.0\"?><s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\"><s:Body><u:{name} xmlns:u=\"{}\"><InstanceID>0</InstanceID>{arguments}</u:{name}></s:Body></s:Envelope>",escape(&self.service));
        let response = self
            .client
            .post(self.control.clone())
            .header("Content-Type", "text/xml; charset=\"utf-8\"")
            .header("SOAPAction", format!("\"{}#{name}\"", self.service))
            .body(body)
            .send()
            .await
            .map_err(|_| "dlna-action-network")?;
        xml_values(&bounded_body(response).await?)
    }
    pub async fn load(&mut self, selection: &MediaSelection) -> Result<(), &'static str> {
        self.action(
            "SetAVTransportURI",
            &format!(
                "<CurrentURI>{}</CurrentURI><CurrentURIMetaData></CurrentURIMetaData>",
                escape(&selection.url)
            ),
        )
        .await?;
        self.owned_uri = Some(selection.url.clone());
        self.action("Play", "<Speed>1</Speed>").await?;
        Ok(())
    }
    async fn owns_uri(&self) -> Result<bool, &'static str> {
        let values = self.action("GetMediaInfo", "").await?;
        Ok(values
            .iter()
            .find(|(tag, _)| tag == "CurrentURI")
            .is_some_and(|(_, value)| Some(value) == self.owned_uri.as_ref()))
    }
    pub async fn status(&self) -> Result<ReceiverState, &'static str> {
        if self.owned_uri.is_none() || !self.owns_uri().await? {
            return Ok(ReceiverState::Ended);
        }
        let values = self.action("GetTransportInfo", "").await?;
        match values
            .iter()
            .find(|(tag, _)| tag == "CurrentTransportState")
            .map(|(_, value)| value.as_str())
        {
            Some("PLAYING") => Ok(ReceiverState::Playing("avtransport:0".into())),
            Some("PAUSED_PLAYBACK") => Ok(ReceiverState::Paused),
            Some("TRANSITIONING") => Ok(ReceiverState::Buffering),
            Some("STOPPED" | "NO_MEDIA_PRESENT") => Ok(ReceiverState::Ended),
            _ => Err("dlna-transport-state-unknown"),
        }
    }
    pub async fn stop(&mut self) -> Result<bool, &'static str> {
        if self.owned_uri.is_none() || !self.owns_uri().await? {
            self.owned_uri = None;
            return Ok(true);
        }
        self.action("Stop", "").await?;
        let stopped = matches!(self.status().await?, ReceiverState::Ended);
        if stopped {
            self.owned_uri = None;
        }
        Ok(stopped)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reported_udn_and_model_are_preserved_and_embedded_identity_is_not_guessed() {
        let xml="<root><device><friendlyName>TV</friendlyName><UDN>uuid:Receiver-A</UDN><modelName>Model</modelName><serviceList><service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><controlURL>/control</controlURL></service></serviceList></device></root>";
        let location = Url::parse("http://192.168.1.4/device.xml").unwrap();
        let Endpoint::Dlna {
            protocol_id,
            model,
            description,
            ..
        } = parse_description(xml, &location).unwrap()
        else {
            panic!("expected DLNA")
        };
        assert_eq!(protocol_id.as_deref(), Some("uuid:Receiver-A"));
        assert_eq!(model.as_deref(), Some("Model"));
        assert_eq!(description, location);
        assert!(matches!(
            parse_description(
                &xml.replace(
                    "</device>",
                    "<device><UDN>uuid:Other</UDN></device></device>"
                ),
                &location
            ),
            Err("dlna-embedded-device-identity-unsupported")
        ));
    }
    #[test]
    fn dtd_and_external_entity_refused() {
        assert!(xml_values("<!DOCTYPE x SYSTEM 'file:///x'><x/>").is_err());
    }
    #[test]
    fn description_never_confuses_service_control_urls() {
        let xml="<root><friendlyName>Room TV</friendlyName><serviceList><service><serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType><controlURL>/wrong</controlURL></service><service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><controlURL>/right</controlURL></service></serviceList></root>";
        match parse_description(xml, &Url::parse("http://192.168.1.4/device.xml").unwrap()).unwrap()
        {
            Endpoint::Dlna { control, .. } => assert_eq!(control.path(), "/right"),
            _ => panic!(),
        }
    }
    #[test]
    fn xml_actions_escape_metadata() {
        assert_eq!(escape("<&\""), "&lt;&amp;&quot;");
    }
    #[test]
    fn xml_depth_is_bounded() {
        assert!(xml_values(&format!("{}{}", "<a>".repeat(33), "</a>".repeat(33))).is_err());
    }
    #[test]
    fn xml_entities_preserve_signed_uri_identity() {
        assert_eq!(
            xml_values("<CurrentURI>https://example.org/x?a=1&amp;b=2</CurrentURI>").unwrap(),
            vec![("CurrentURI".into(), "https://example.org/x?a=1&b=2".into())]
        );
        assert!(xml_values("<x>&unknown;</x>").is_err());
    }
    #[tokio::test]
    async fn actual_soap_load_status_and_owned_stop_fixture() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let worker = std::thread::spawn(move || {
            let mut stopped = false;
            let mut actions = Vec::new();
            for _ in 0..8 {
                let (mut socket, _) = listener.accept().unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut request = Vec::new();
                loop {
                    let mut byte = [0];
                    socket.read_exact(&mut byte).unwrap();
                    request.push(byte[0]);
                    if request.ends_with(b"\r\n\r\n") {
                        break;
                    }
                    assert!(request.len() < 16_384);
                }
                let header = String::from_utf8_lossy(&request);
                let size = header
                    .lines()
                    .find_map(|line| {
                        line.split_once(':')
                            .filter(|(name, _)| name.eq_ignore_ascii_case("content-length"))
                            .map(|(_, value)| value.trim().parse::<usize>().unwrap())
                    })
                    .unwrap();
                let action = header
                    .lines()
                    .find_map(|line| {
                        line.split_once(':')
                            .filter(|(name, _)| name.eq_ignore_ascii_case("soapaction"))
                            .map(|(_, value)| value.trim().to_owned())
                    })
                    .unwrap();
                let mut body = vec![0; size];
                socket.read_exact(&mut body).unwrap();
                let body = String::from_utf8(body).unwrap();
                let response = if action.contains("#SetAVTransportURI") {
                    assert!(body.contains("https://example.org/x?a=1&amp;b=2"));
                    "<ok/>".into()
                } else if action.contains("#GetMediaInfo") {
                    "<CurrentURI>https://example.org/x?a=1&amp;b=2</CurrentURI>".into()
                } else if action.contains("#GetTransportInfo") {
                    format!(
                        "<CurrentTransportState>{}</CurrentTransportState>",
                        if stopped { "STOPPED" } else { "PLAYING" }
                    )
                } else if action.contains("#Stop") {
                    stopped = true;
                    "<ok/>".into()
                } else {
                    "<ok/>".into()
                };
                actions.push(action);
                write!(socket,"HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: text/xml\r\nConnection: close\r\n\r\n{}",response.len(),response).unwrap();
            }
            assert!(stopped);
            actions
        });
        let mut session = Session::new(
            Url::parse(&format!("http://{address}/control")).unwrap(),
            "urn:schemas-upnp-org:service:AVTransport:1".into(),
        )
        .unwrap();
        session
            .load(&MediaSelection {
                id: "channel".into(),
                name: "News".into(),
                url: "https://example.org/x?a=1&b=2".into(),
                content_type: "application/x-mpegURL".into(),
            })
            .await
            .unwrap();
        assert!(matches!(
            session.status().await.unwrap(),
            ReceiverState::Playing(_)
        ));
        assert!(session.stop().await.unwrap());
        let actions = worker.join().unwrap();
        assert_eq!(actions.len(), 8);
    }
    #[tokio::test]
    async fn stop_does_not_touch_a_foreign_transport_uri() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let worker = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut request = Vec::new();
            loop {
                let mut byte = [0];
                socket.read_exact(&mut byte).unwrap();
                request.push(byte[0]);
                if request.ends_with(b"\r\n\r\n") {
                    break;
                }
            }
            let header = String::from_utf8(request).unwrap();
            assert!(header.contains("#GetMediaInfo"));
            assert!(!header.contains("#Stop"));
            let size = header
                .lines()
                .find_map(|line| {
                    line.split_once(':')
                        .filter(|(key, _)| key.eq_ignore_ascii_case("content-length"))
                        .map(|(_, value)| value.trim().parse::<usize>().unwrap())
                })
                .unwrap();
            let mut body = vec![0; size];
            socket.read_exact(&mut body).unwrap();
            let response = "<CurrentURI>https://example.org/another-user</CurrentURI>";
            write!(
                socket,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                response.len(),
                response
            )
            .unwrap();
        });
        let mut session = Session::new(
            Url::parse(&format!("http://{address}/control")).unwrap(),
            "urn:schemas-upnp-org:service:AVTransport:1".into(),
        )
        .unwrap();
        session.owned_uri = Some("https://example.org/our-channel".into());
        assert!(session.stop().await.unwrap());
        assert!(session.owned_uri.is_none());
        worker.join().unwrap();
    }
}
