//! Bit reader and table-driven variable-length decoding.

/// Reads bits most-significant first. Reads past the end yield zero bits, and
/// `overrun` reports it, so damaged data ends a slice instead of panicking.
pub(crate) struct Bits<'a> {
    data: &'a [u8],
    pos: usize,
}
impl<'a> Bits<'a> {
    pub fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }
    #[inline]
    pub fn peek(&self, n: u32) -> u32 {
        debug_assert!(n <= 32);
        if n == 0 {
            return 0;
        }
        let byte = self.pos >> 3;
        // One 8-byte load wherever 8 bytes remain (almost always); the bytes
        // one at a time near the end, where reads past it give zeros.
        if let Some(bytes) = self.data.get(byte..byte + 8) {
            let word = u64::from_be_bytes(bytes.try_into().expect("8 bytes"));
            let shift = 64 - (self.pos & 7) as u32 - n;
            return ((word >> shift) & ((1u64 << n) - 1)) as u32;
        }
        let mut word = 0u64;
        for i in 0..5 {
            word = (word << 8) | *self.data.get(byte + i).unwrap_or(&0) as u64;
        }
        let shift = 40 - (self.pos & 7) as u32 - n;
        ((word >> shift) & ((1u64 << n) - 1)) as u32
    }
    #[inline]
    pub fn skip(&mut self, n: u32) {
        self.pos += n as usize;
    }
    #[inline]
    pub fn read(&mut self, n: u32) -> u32 {
        let v = self.peek(n);
        self.pos += n as usize;
        v
    }
    #[inline]
    pub fn flag(&mut self) -> bool {
        self.read(1) == 1
    }
    pub fn overrun(&self) -> bool {
        self.pos > self.data.len() * 8
    }
    pub fn bits_left(&self) -> isize {
        self.data.len() as isize * 8 - self.pos as isize
    }
    /// True when the next 23 bits are zero: the start of a start code (or padding).
    pub fn at_start_code_prefix(&self) -> bool {
        self.peek(23) == 0
    }
}

/// A two-level lookup table built from (bit string, value) rows. Codes up to
/// PRIMARY bits are found in one small first-level table (it stays in the
/// fastest cache); the rare longer codes go through a short second-level table
/// under their first PRIMARY bits. A single table over the longest code (16
/// bits, 65,536 padded slots for the DCT tables) spread even common short codes
/// over many cache lines.
pub(crate) struct Vlc<T: Copy> {
    /// The longest code; one read of this many bits decodes any code.
    bits: u32,
    primary_bits: u32,
    /// Leaf: code length (bits 0..8) and value index (bits 8..24); length 0
    /// means no code starts with these bits. With LONG set: the second-level
    /// table's first entry.
    primary: Vec<u32>,
    secondary: Vec<u32>,
    values: Vec<T>,
}
const PRIMARY: u32 = 10;
const LONG: u32 = 1 << 31;
impl<T: Copy> Vlc<T> {
    pub fn new(rows: &[(&str, T)]) -> Self {
        Self::build(rows, |index, _| index as u32)
    }
    /// A table whose entries carry `pack(value)` (at most 23 bits) instead of
    /// an index into the values, read with `decode_packed_with_next`: one dependent
    /// load fewer per code (the DCT coefficient tables).
    pub fn packed(rows: &[(&str, T)], pack: impl Fn(&T) -> u32) -> Self {
        Self::build(rows, |_, value| {
            let payload = pack(value);
            assert!(payload < 1 << 23, "payload fits");
            payload
        })
    }
    fn build(rows: &[(&str, T)], payload: impl Fn(usize, &T) -> u32) -> Self {
        let bits = rows.iter().map(|(c, _)| c.len() as u32).max().unwrap_or(1);
        let primary_bits = bits.min(PRIMARY);
        let rest = bits - primary_bits;
        let mut primary = vec![0u32; 1 << primary_bits];
        let mut secondary: Vec<u32> = Vec::new();
        let mut values = Vec::with_capacity(rows.len());
        for (code, value) in rows {
            let len = code.len() as u32;
            let full = u32::from_str_radix(code, 2).expect("binary code") << (bits - len);
            let leaf = len | payload(values.len(), value) << 8;
            values.push(*value);
            if len <= primary_bits {
                let first = (full >> rest) as usize;
                for slot in &mut primary[first..first + (1 << (primary_bits - len))] {
                    assert!(*slot == 0, "codes must be prefix-free: {code}");
                    *slot = leaf;
                }
            } else {
                let head = (full >> rest) as usize;
                if primary[head] == 0 {
                    primary[head] = LONG | secondary.len() as u32;
                    secondary.resize(secondary.len() + (1 << rest), 0);
                }
                assert!(
                    primary[head] & LONG != 0,
                    "codes must be prefix-free: {code}"
                );
                let base = (primary[head] & !LONG) as usize;
                let first = base + (full & ((1 << rest) - 1)) as usize;
                for slot in &mut secondary[first..first + (1 << (bits - len))] {
                    assert!(*slot == 0, "codes must be prefix-free: {code}");
                    *slot = leaf;
                }
            }
        }
        Self {
            bits,
            primary_bits,
            primary,
            secondary,
            values,
        }
    }
    /// Decodes one code, or None (consuming nothing) when no code matches.
    #[inline(always)]
    pub fn decode(&self, b: &mut Bits) -> Option<T> {
        let word = b.peek(self.bits);
        let rest = self.bits - self.primary_bits;
        let mut entry = self.primary[(word >> rest) as usize];
        if entry & LONG != 0 {
            entry = self.secondary[(entry & !LONG) as usize + (word & ((1 << rest) - 1)) as usize];
        }
        let len = entry & 0xFF;
        if len == 0 {
            return None;
        }
        b.skip(len);
        Some(self.values[(entry >> 8) as usize])
    }
    /// Decodes one code of a `packed` table and returns its payload with the
    /// bit after the code, from the same read (the sign after a DCT coefficient
    /// code; that bit is not consumed), or None (consuming nothing).
    #[inline(always)]
    pub fn decode_packed_with_next(&self, b: &mut Bits) -> Option<(u32, bool)> {
        let word = b.peek(self.bits + 1);
        let code = word >> 1;
        let rest = self.bits - self.primary_bits;
        let mut entry = self.primary[(code >> rest) as usize];
        if entry & LONG != 0 {
            entry = self.secondary[(entry & !LONG) as usize + (code & ((1 << rest) - 1)) as usize];
        }
        let len = entry & 0xFF;
        if len == 0 {
            return None;
        }
        b.skip(len);
        Some((entry >> 8, (word >> (self.bits - len)) & 1 == 1))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reads_across_bytes_and_past_the_end() {
        let data = [0b1010_1100, 0b0101_0011];
        let mut b = Bits::new(&data);
        assert_eq!(b.read(3), 0b101);
        assert_eq!(b.read(7), 0b0110001);
        assert_eq!(b.read(6), 0b010011);
        assert!(!b.overrun());
        assert_eq!(b.read(8), 0);
        assert!(b.overrun());
    }
    #[test]
    fn decodes_prefix_codes() {
        let vlc = Vlc::new(&[("1", 1), ("01", 2), ("001", 3)]);
        let data = [0b0010_1100];
        let mut b = Bits::new(&data);
        assert_eq!(vlc.decode(&mut b), Some(3));
        assert_eq!(vlc.decode(&mut b), Some(2));
        assert_eq!(vlc.decode(&mut b), Some(1));
        // Only "00" and zero padding remain: no code matches, nothing is consumed.
        assert_eq!(vlc.decode(&mut b), None);
        assert_eq!(b.bits_left(), 2);
    }
    /// Codes longer than the first level go through the second level.
    #[test]
    fn decodes_long_codes_through_the_second_level() {
        let vlc = Vlc::new(&[
            ("1", 1),
            ("01", 2),
            ("0000000000001", 3),
            ("0000000000011", 4),
        ]);
        // 0000000000001 0000000000011 01 1, padded.
        let data = [0x00, 0x08, 0x00, 0xD8, 0x00];
        let mut b = Bits::new(&data);
        assert_eq!(vlc.decode(&mut b), Some(3));
        assert_eq!(vlc.decode(&mut b), Some(4));
        assert_eq!(vlc.decode(&mut b), Some(2));
        assert_eq!(vlc.decode(&mut b), Some(1));
        // "0000000000010" is a hole in the second level.
        let hole = [0x00, 0x10];
        let mut h = Bits::new(&hole);
        assert_eq!(vlc.decode(&mut h), None);
        assert_eq!(h.bits_left(), 16);
    }
}
