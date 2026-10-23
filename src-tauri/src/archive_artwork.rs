//! Bounded static image headers. Image bytes remain untrusted browser input;
//! this validates representation and allocation bounds, not artwork identity.
pub(crate) const MAX_BYTES: usize = 512 * 1024;
const MAX_SIDE: u32 = 2048;
const MAX_PIXELS: u32 = 1024 * 1024;
fn dimensions(width: u32, height: u32) -> Result<(u32, u32), String> {
    if width == 0
        || height == 0
        || width > MAX_SIDE
        || height > MAX_SIDE
        || width
            .checked_mul(height)
            .is_none_or(|pixels| pixels > MAX_PIXELS)
    {
        return Err("archive-artwork-dimensions-refused".into());
    }
    Ok((width, height))
}
pub(crate) fn validate(bytes: &[u8], mime: &str) -> Result<(u32, u32), String> {
    if bytes.is_empty() || bytes.len() > MAX_BYTES {
        return Err("archive-artwork-byte-limit".into());
    }
    match mime {
        "image/png" => png(bytes),
        "image/jpeg" => jpeg(bytes),
        _ => Err("archive-artwork-format-refused".into()),
    }
}
pub(crate) fn response(
    status: u16,
    mime: &str,
    declared: Option<u64>,
    encoding: Option<&[u8]>,
    range: bool,
    expected: usize,
    expected_mime: &str,
) -> Result<(), String> {
    if status != 200
        || mime != expected_mime
        || expected == 0
        || expected > MAX_BYTES
        || declared.is_some_and(|length| length != expected as u64)
        || encoding.is_some_and(|value| value != b"identity")
        || range
    {
        return Err("archive-artwork-response-refused".into());
    }
    Ok(())
}
pub(crate) fn append(bytes: &mut Vec<u8>, chunk: &[u8], expected: usize) -> Result<(), String> {
    if bytes
        .len()
        .checked_add(chunk.len())
        .is_none_or(|length| length > MAX_BYTES || length > expected)
    {
        return Err("archive-artwork-byte-limit".into());
    }
    bytes.extend_from_slice(chunk);
    Ok(())
}
fn png(bytes: &[u8]) -> Result<(u32, u32), String> {
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err("archive-artwork-format-refused".into());
    }
    let mut offset = 8usize;
    let mut size = None;
    let mut pixels = false;
    while offset.checked_add(12).is_some_and(|end| end <= bytes.len()) {
        let length = u32::from_be_bytes(bytes[offset..offset + 4].try_into().unwrap()) as usize;
        let end = offset
            .checked_add(12)
            .and_then(|n| n.checked_add(length))
            .filter(|n| *n <= bytes.len())
            .ok_or("archive-artwork-format-refused")?;
        let kind = &bytes[offset + 4..offset + 8];
        if offset == 8 && (kind != b"IHDR" || length != 13) {
            return Err("archive-artwork-format-refused".into());
        }
        match kind {
            b"IHDR" if size.is_none() && length == 13 => {
                size = Some(dimensions(
                    u32::from_be_bytes(bytes[offset + 8..offset + 12].try_into().unwrap()),
                    u32::from_be_bytes(bytes[offset + 12..offset + 16].try_into().unwrap()),
                )?);
            }
            b"IHDR" | b"acTL" | b"fcTL" | b"fdAT" => {
                return Err("archive-artwork-format-refused".into())
            }
            b"IDAT" => pixels = true,
            b"IEND" if length == 0 && pixels && end == bytes.len() => {
                return size.ok_or_else(|| "archive-artwork-format-refused".into())
            }
            b"IEND" => return Err("archive-artwork-format-refused".into()),
            _ => {}
        }
        offset = end;
    }
    Err("archive-artwork-format-refused".into())
}
fn jpeg(bytes: &[u8]) -> Result<(u32, u32), String> {
    if !bytes.starts_with(&[0xff, 0xd8]) || !bytes.ends_with(&[0xff, 0xd9]) {
        return Err("archive-artwork-format-refused".into());
    }
    let mut offset = 2usize;
    let mut size = None;
    while offset + 4 <= bytes.len() {
        if bytes[offset] != 0xff {
            return Err("archive-artwork-format-refused".into());
        }
        while bytes.get(offset) == Some(&0xff) {
            offset += 1;
        }
        let marker = *bytes.get(offset).ok_or("archive-artwork-format-refused")?;
        offset += 1;
        if marker == 0xda {
            return size.ok_or_else(|| "archive-artwork-format-refused".into());
        }
        if offset + 2 > bytes.len() {
            break;
        }
        let length = u16::from_be_bytes(bytes[offset..offset + 2].try_into().unwrap()) as usize;
        let end = offset
            .checked_add(length)
            .filter(|end| length >= 2 && *end <= bytes.len())
            .ok_or("archive-artwork-format-refused")?;
        if marker == 0xe2 && bytes.get(offset + 2..offset + 6) == Some(b"MPF\0") {
            return Err("archive-artwork-format-refused".into());
        }
        if matches!(marker, 0xc0 | 0xc1 | 0xc2) {
            if size.is_some() || length < 8 {
                return Err("archive-artwork-format-refused".into());
            }
            size = Some(dimensions(
                u16::from_be_bytes(bytes[offset + 5..offset + 7].try_into().unwrap()) as u32,
                u16::from_be_bytes(bytes[offset + 3..offset + 5].try_into().unwrap()) as u32,
            )?);
        }
        offset = end;
    }
    Err("archive-artwork-format-refused".into())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn archive_artwork_headers_refuse_bad_mime_size_dimensions_and_animation() {
        assert!(validate(b"<svg></svg>", "image/svg+xml").is_err());
        assert!(validate(&vec![0; MAX_BYTES + 1], "image/jpeg").is_err());
        for (w, h) in [(0, 10), (10, 0), (2049, 1), (2048, 2048)] {
            assert!(dimensions(w, h).is_err());
        }
        assert_eq!(dimensions(1024, 1024).unwrap(), (1024, 1024));
        let jpeg = [
            0xff, 0xd8, 0xff, 0xc0, 0, 8, 8, 0, 1, 0, 1, 0, 0xff, 0xda, 0, 2, 0xff, 0xd9,
        ];
        assert_eq!(validate(&jpeg, "image/jpeg").unwrap(), (1, 1));
        assert!(validate(&jpeg, "image/png").is_err());
        for end in 0..jpeg.len() {
            assert!(validate(&jpeg[..end], "image/jpeg").is_err());
        }
        let mut huge = jpeg;
        huge[7] = 8;
        assert!(validate(&huge, "image/jpeg").is_err());
        let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
        for (kind, data) in [
            (
                b"IHDR".as_slice(),
                vec![0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0],
            ),
            (b"IDAT".as_slice(), vec![0]),
            (b"IEND".as_slice(), vec![]),
        ] {
            png.extend_from_slice(&(data.len() as u32).to_be_bytes());
            png.extend_from_slice(kind);
            png.extend_from_slice(&data);
            png.extend_from_slice(&[0; 4]);
        }
        assert_eq!(validate(&png, "image/png").unwrap(), (1, 1));
        png[37..41].copy_from_slice(b"acTL");
        assert!(validate(&png, "image/png").is_err());
    }
    #[test]
    fn archive_artwork_observed_jpeg_and_stream_response_bounds_are_actual() {
        let image = include_bytes!("../../tests/fixtures/archive-artwork/gilligan-item-tile.jpg");
        assert_eq!(validate(image, "image/jpeg").unwrap(), (180, 135));
        assert!(validate(image, "image/png").is_err());
        assert!(response(
            200,
            "image/jpeg",
            Some(image.len() as u64),
            None,
            false,
            image.len(),
            "image/jpeg"
        )
        .is_ok());
        for (status, mime, length, encoding, range) in [
            (302, "image/jpeg", Some(1), None, false),
            (200, "text/html", None, None, false),
            (200, "image/jpeg", Some(1), None, false),
            (200, "image/jpeg", None, Some(b"gzip".as_slice()), false),
            (206, "image/jpeg", None, None, true),
        ] {
            assert!(response(
                status,
                mime,
                length,
                encoding,
                range,
                image.len(),
                "image/jpeg"
            )
            .is_err());
        }
        let mut bytes = Vec::new();
        append(&mut bytes, &image[..10], image.len()).unwrap();
        append(&mut bytes, &image[10..], image.len()).unwrap();
        assert_eq!(bytes.as_slice(), image);
        assert!(append(&mut bytes, &[0], image.len()).is_err());
    }
}
