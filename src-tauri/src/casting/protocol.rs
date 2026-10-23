use serde_json::Value;
pub const MAX_FRAME: usize = 64 * 1024;
pub const CONNECTION: &str = "urn:x-cast:com.google.cast.tp.connection";
pub const HEARTBEAT: &str = "urn:x-cast:com.google.cast.tp.heartbeat";
pub const RECEIVER: &str = "urn:x-cast:com.google.cast.receiver";
pub const MEDIA: &str = "urn:x-cast:com.google.cast.media";
#[derive(Debug)]
pub struct Message {
    pub source: String,
    pub destination: String,
    pub namespace: String,
    pub payload: Value,
}
fn varint(mut value: usize, output: &mut Vec<u8>) {
    while value >= 128 {
        output.push((value as u8 & 127) | 128);
        value >>= 7;
    }
    output.push(value as u8);
}
fn field(tag: usize, value: &[u8], output: &mut Vec<u8>) {
    varint(tag * 8 + 2, output);
    varint(value.len(), output);
    output.extend_from_slice(value);
}
pub fn encode(
    source: &str,
    destination: &str,
    namespace: &str,
    payload: &Value,
) -> Result<Vec<u8>, &'static str> {
    let mut body = vec![8, 0];
    field(2, source.as_bytes(), &mut body);
    field(3, destination.as_bytes(), &mut body);
    field(4, namespace.as_bytes(), &mut body);
    body.extend_from_slice(&[40, 0]);
    field(
        6,
        serde_json::to_string(payload)
            .map_err(|_| "cast-json")?
            .as_bytes(),
        &mut body,
    );
    if body.len() > MAX_FRAME {
        return Err("cast-frame-limit");
    }
    let mut frame = (body.len() as u32).to_be_bytes().to_vec();
    frame.extend(body);
    Ok(frame)
}
fn integer(body: &[u8], offset: &mut usize) -> Result<usize, &'static str> {
    let mut value = 0usize;
    for shift in (0..usize::BITS as usize).step_by(7) {
        let byte = *body.get(*offset).ok_or("cast-protobuf")?;
        *offset += 1;
        let chunk = (byte & 127) as usize;
        if chunk > usize::MAX >> shift {
            return Err("cast-protobuf");
        }
        value |= chunk << shift;
        if byte & 128 == 0 {
            return Ok(value);
        }
    }
    Err("cast-protobuf")
}
pub fn decode(body: &[u8]) -> Result<Message, &'static str> {
    if body.len() > MAX_FRAME {
        return Err("cast-frame-limit");
    }
    let mut fields = std::collections::HashMap::new();
    let mut numbers = std::collections::HashMap::new();
    let mut offset = 0;
    while offset < body.len() {
        let key = integer(body, &mut offset)?;
        let tag = key >> 3;
        match key & 7 {
            0 => {
                let number = integer(body, &mut offset)?;
                if numbers.insert(tag, number).is_some() {
                    return Err("cast-duplicate-field");
                }
            }
            2 => {
                let size = integer(body, &mut offset)?;
                let end = offset.checked_add(size).ok_or("cast-protobuf")?;
                let bytes = body.get(offset..end).ok_or("cast-protobuf")?;
                if fields.insert(tag, bytes).is_some() {
                    return Err("cast-duplicate-field");
                }
                offset = end;
            }
            _ => return Err("cast-protobuf-wire-type"),
        }
    }
    if numbers.get(&1) != Some(&0) || numbers.get(&5) != Some(&0) {
        return Err("cast-protocol-version-or-payload-type");
    }
    let string = |tag| {
        std::str::from_utf8(fields.get(&tag).ok_or("cast-missing-field")?)
            .map(str::to_owned)
            .map_err(|_| "cast-utf8")
    };
    Ok(Message {
        source: string(2)?,
        destination: string(3)?,
        namespace: string(4)?,
        payload: serde_json::from_str(&string(6)?).map_err(|_| "cast-json")?,
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cast_frame_round_trip() {
        let encoded = encode(
            "sender",
            "receiver",
            MEDIA,
            &serde_json::json!({"type":"GET_STATUS","requestId":1}),
        )
        .unwrap();
        let decoded = decode(&encoded[4..]).unwrap();
        assert_eq!(decoded.source, "sender");
        assert_eq!(decoded.destination, "receiver");
        assert_eq!(decoded.namespace, MEDIA);
        assert_eq!(decoded.payload["requestId"], 1);
    }
    #[test]
    fn malformed_frames_are_rejected() {
        assert!(decode(&[18, 255, 255]).is_err());
        assert!(decode(&[7]).is_err());
        assert!(decode(&vec![0; MAX_FRAME + 1]).is_err());
        assert!(decode(&[40, 1]).is_err());
    }
}
