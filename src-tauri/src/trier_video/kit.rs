//! Interchangeable implementations of the costly stages (the adaptive engine,
//! docs/trier-adaptive-engine.md): one trait per stage, and kits that combine
//! one implementation of each. A kit is compiled whole into the slice decoder
//! (`Slicer<K>`), so choosing one costs a match per picture and nothing per
//! block. The registry is closed: only the kits listed in `KitId` exist, each
//! qualified by the tests in `tests.rs` before it can be listed.

use super::{idct, macroblock, mc};

/// CPU features an implementation needs (bit set).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Features(pub u32);
impl Features {
    pub const NONE: Self = Self(0);
    /// Advanced SIMD (always present on AArch64, optional on 32-bit ARM).
    pub const NEON: Self = Self(1);
    /// SSE2 (always present on x86-64).
    pub const SSE2: Self = Self(1 << 1);
    /// AVX2 (x86-64, detected at run time; no kit needs it yet).
    pub const AVX2: Self = Self(1 << 2);
    /// AArch64 dot product (detected at run time; no kit needs it yet).
    pub const DOTPROD: Self = Self(1 << 3);
    /// What this CPU offers, detected once.
    pub fn detected() -> Self {
        static F: std::sync::OnceLock<Features> = std::sync::OnceLock::new();
        *F.get_or_init(|| {
            #[allow(unused_mut)]
            let mut f = Self::NONE;
            #[cfg(target_arch = "aarch64")]
            {
                f = f.with(Self::NEON);
                if std::arch::is_aarch64_feature_detected!("dotprod") {
                    f = f.with(Self::DOTPROD);
                }
            }
            #[cfg(target_arch = "x86_64")]
            {
                f = f.with(Self::SSE2);
                if std::is_x86_feature_detected!("avx2") {
                    f = f.with(Self::AVX2);
                }
            }
            // 32-bit ARM: NEON is optional (the Streamer's MT8696 has it).
            #[cfg(target_arch = "arm")]
            if std::fs::read_to_string("/proc/cpuinfo").is_ok_and(|c| {
                c.lines()
                    .any(|l| l.starts_with("Features") && l.split_whitespace().any(|w| w == "neon"))
            }) {
                f = f.with(Self::NEON);
            }
            f
        })
    }
    /// The features' names, for reports.
    pub fn names(self) -> Vec<&'static str> {
        [
            (Self::NEON, "neon"),
            (Self::SSE2, "sse2"),
            (Self::AVX2, "avx2"),
            (Self::DOTPROD, "dotprod"),
        ]
        .into_iter()
        .filter(|(f, _)| self.covers(*f))
        .map(|(_, n)| n)
        .collect()
    }
    pub const fn with(self, other: Self) -> Self {
        Self(self.0 | other.0)
    }
    pub const fn covers(self, needed: Self) -> bool {
        self.0 & needed.0 == needed.0
    }
}

/// The numerical contract of an implementation against the portable one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Contract {
    /// The same output for every input (tested).
    BitExact,
    /// Inverse DCTs only: a different rounding within IEEE 1180 (MV02). Never
    /// substituted for a bit-exact implementation silently (INV-AUTOTUNE-002).
    Ieee1180,
}

/// Coefficient decoding (7.2.2, 7.4): one shared loop in `Slicer::block`,
/// configured by these switches, so variants never duplicate the decoder.
pub(crate) trait CoefDecoder {
    const ID: &'static str;
    /// Negative-offset position counter with a scan-ordered position/weight table.
    const NEGATIVE_OFFSET: bool;
    /// Branchless sign and reconstruction.
    const BRANCHLESS: bool;
    /// Two codes per table read, with a window of `PAIR_BITS` bits (10 to 12).
    const PAIRS: bool;
    const PAIR_BITS: u32;
}
/// The inverse DCT of one block, given how far its coded coefficients reach.
pub(crate) trait InverseDct {
    const ID: &'static str;
    const REQUIRES: Features;
    const CONTRACT: Contract;
    fn inverse_within(block: &mut [i32; 64], reach: usize);
}
/// `h` rows of a W-wide prediction lying wholly inside the reference (see
/// `mc::predict`): the half-sample position and averaging fixed at compile time.
pub(crate) trait MotionRows {
    const ID: &'static str;
    const REQUIRES: Features;
    fn rows<const W: usize, const HX: bool, const HY: bool, const AVG: bool>(
        dst: &mut [u8],
        ds: usize,
        h: usize,
        src: &[u8],
        base: usize,
        ss: usize,
    );
}
/// One row of 7.6.8: prediction plus residual, saturated to 0..255.
pub(crate) trait BlockAdd {
    const ID: &'static str;
    const REQUIRES: Features;
    fn add_row(line: &mut [u8; 8], residual: &[i32; 8], intra: bool);
}

/// One implementation of each stage.
pub(crate) trait Kit: 'static {
    type Coef: CoefDecoder;
    type Idct: InverseDct;
    type Mc: MotionRows;
    type Add: BlockAdd;
}

/// The coefficient loop as first written: one code per table read, the sign
/// branch and `dequant`. The portable reference.
pub(crate) struct CoefPlain;
impl CoefDecoder for CoefPlain {
    const ID: &'static str = "coef.single";
    const NEGATIVE_OFFSET: bool = false;
    const BRANCHLESS: bool = false;
    const PAIRS: bool = false;
    const PAIR_BITS: u32 = 11;
}
/// Two codes per read with a 10-bit window (8 KB tables): fewer cache misses,
/// more fallbacks than 11 bits. Equal within noise on the S25.
pub(crate) struct CoefPairs10;
impl CoefDecoder for CoefPairs10 {
    const ID: &'static str = "coef.pairs10.negoffset.branchless";
    const NEGATIVE_OFFSET: bool = true;
    const BRANCHLESS: bool = true;
    const PAIRS: bool = true;
    const PAIR_BITS: u32 = 10;
}
/// Two codes per read with a 12-bit window (32 KB tables): fewer fallbacks,
/// more cache misses than 11 bits. Equal within noise on the S25.
pub(crate) struct CoefPairs12;
impl CoefDecoder for CoefPairs12 {
    const ID: &'static str = "coef.pairs12.negoffset.branchless";
    const NEGATIVE_OFFSET: bool = true;
    const BRANCHLESS: bool = true;
    const PAIRS: bool = true;
    const PAIR_BITS: u32 = 12;
}
/// The coefficient loop measured best on the S25 (docs/trier-discovery-2026-10-21-coefficients.md).
pub(crate) struct CoefPairs11;
impl CoefDecoder for CoefPairs11 {
    const ID: &'static str = "coef.pairs11.negoffset.branchless";
    const NEGATIVE_OFFSET: bool = true;
    const BRANCHLESS: bool = true;
    const PAIRS: bool = true;
    const PAIR_BITS: u32 = 11;
}

/// Today's kit: the fastest verified form of each stage for the target
/// architecture, as chosen at build time before the engine existed.
pub(crate) struct Default;
impl Kit for Default {
    type Coef = CoefPairs11;
    type Idct = idct::Best;
    type Mc = mc::Best;
    type Add = macroblock::AddBest;
}

/// Plain Rust in every stage: available everywhere, the fallback when
/// nothing else qualifies (INV-AUTOTUNE-007), and the reference every other
/// kit is tested against.
pub(crate) struct Portable;
impl Kit for Portable {
    type Coef = CoefPlain;
    type Idct = idct::IdctPlain;
    type Mc = mc::McPortable;
    type Add = macroblock::AddPortable;
}
/// Today's kit with the 10-bit pair window.
pub(crate) struct Pairs10;
impl Kit for Pairs10 {
    type Coef = CoefPairs10;
    type Idct = idct::Best;
    type Mc = mc::Best;
    type Add = macroblock::AddBest;
}
/// Today's kit with the 12-bit pair window.
pub(crate) struct Pairs12;
impl Kit for Pairs12 {
    type Coef = CoefPairs12;
    type Idct = idct::Best;
    type Mc = mc::Best;
    type Add = macroblock::AddBest;
}
/// Today's kernels with the one-code coefficient loop: no pair tables at all
/// (the smallest data footprint), for cores with small caches.
pub(crate) struct Compact;
impl Kit for Compact {
    type Coef = CoefPlain;
    type Idct = idct::Best;
    type Mc = mc::Best;
    type Add = macroblock::AddBest;
}

/// The closed registry of kits.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Default)]
pub enum KitId {
    #[default]
    Default,
    Portable,
    Pairs10,
    Pairs12,
    Compact,
}
impl KitId {
    pub fn name(self) -> &'static str {
        info_of(self).name
    }
    pub fn from_name(name: &str) -> Option<Self> {
        KITS.iter().find(|k| k.name == name).map(|k| k.id)
    }
}

/// Why a kit cannot be chosen.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KitError {
    /// This CPU lacks features the kit needs.
    Unsupported(Features),
    /// The kit has another numerical contract; such a change waits for a
    /// sequence or I picture (INV-AUTOTUNE-002), not built until a kit needs it.
    ContractChange,
}

/// What the registry knows about a kit without compiling it into a call.
#[derive(Clone, Copy, Debug)]
pub struct KitInfo {
    pub id: KitId,
    pub name: &'static str,
    /// Why it is registered: where it may win.
    pub why: &'static str,
    /// Stage implementation IDs: coefficients, inverse DCT, motion compensation, add.
    pub parts: [&'static str; 4],
    pub requires: Features,
    pub contract: Contract,
}
const fn info<K: Kit>(id: KitId, name: &'static str, why: &'static str) -> KitInfo {
    KitInfo {
        id,
        name,
        why,
        parts: [
            <K::Coef as CoefDecoder>::ID,
            <K::Idct as InverseDct>::ID,
            <K::Mc as MotionRows>::ID,
            <K::Add as BlockAdd>::ID,
        ],
        requires: <K::Idct as InverseDct>::REQUIRES
            .with(<K::Mc as MotionRows>::REQUIRES)
            .with(<K::Add as BlockAdd>::REQUIRES),
        contract: <K::Idct as InverseDct>::CONTRACT,
    }
}
/// Every registered kit, the default first.
pub const KITS: &[KitInfo] = &[
    info::<Default>(
        KitId::Default,
        "default",
        "fastest measured on the S25; the build-time choice before the engine",
    ),
    info::<Portable>(
        KitId::Portable,
        "portable",
        "plain Rust: the fallback everywhere and the test reference",
    ),
    info::<Pairs10>(
        KitId::Pairs10,
        "pairs10",
        "8 KB pair tables: for smaller data caches",
    ),
    info::<Pairs12>(
        KitId::Pairs12,
        "pairs12",
        "32 KB pair tables: for larger data caches",
    ),
    info::<Compact>(
        KitId::Compact,
        "compact",
        "no pair tables: for the smallest caches",
    ),
];
/// The registry entry of `id`.
pub fn info_of(id: KitId) -> &'static KitInfo {
    KITS.iter()
        .find(|k| k.id == id)
        .expect("every KitId is registered")
}
/// The kits this CPU can run, the default first.
pub fn available() -> impl Iterator<Item = &'static KitInfo> {
    let have = Features::detected();
    KITS.iter().filter(move |k| have.covers(k.requires))
}

/// Runs `$body` with `$k` naming the kit type registered as `$id`.
macro_rules! with_kit {
    ($id:expr, $k:ident => $body:expr) => {
        match $id {
            $crate::trier_video::kit::KitId::Default => {
                type $k = $crate::trier_video::kit::Default;
                $body
            }
            $crate::trier_video::kit::KitId::Portable => {
                type $k = $crate::trier_video::kit::Portable;
                $body
            }
            $crate::trier_video::kit::KitId::Pairs10 => {
                type $k = $crate::trier_video::kit::Pairs10;
                $body
            }
            $crate::trier_video::kit::KitId::Pairs12 => {
                type $k = $crate::trier_video::kit::Pairs12;
                $body
            }
            $crate::trier_video::kit::KitId::Compact => {
                type $k = $crate::trier_video::kit::Compact;
                $body
            }
        }
    };
}
pub(crate) use with_kit;
