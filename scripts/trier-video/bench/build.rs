//! Optional reference decoder for the scorecard: when TRIER_LAB_LIBMPEG2 names
//! an unpacked libmpeg2 0.5.1 source tree (kept outside the repository; GPL-2.0,
//! measuring only, never part of GenX), it is compiled into the lab tool.
//! x86-64 builds keep libmpeg2's own MMX/SSE2 code (needs a GCC-style
//! compiler such as clang-cl); other targets use its portable C, which is all
//! libmpeg2 has for 64-bit ARM.
use std::path::PathBuf;

fn main() {
    println!("cargo:rerun-if-env-changed=TRIER_LAB_LIBMPEG2");
    println!("cargo:rustc-check-cfg=cfg(libmpeg2)");
    let Ok(source) = std::env::var("TRIER_LAB_LIBMPEG2") else {
        return;
    };
    let source = PathBuf::from(source);
    let out = PathBuf::from(std::env::var("OUT_DIR").unwrap());
    let arch = std::env::var("CARGO_CFG_TARGET_ARCH").unwrap();
    let mut config = String::from(
        "#define HAVE_STDINT_H 1\n#define HAVE_INTTYPES_H 1\n#define HAVE_STRING_H 1\n\
         #define HAVE_STDLIB_H 1\n#define HAVE_MEMORY_H 1\n#define HAVE_TIME_H 1\n#define STDC_HEADERS 1\n",
    );
    let mut files = vec![
        "alloc.c", "cpu_accel.c", "cpu_state.c", "decode.c", "header.c", "idct.c",
        "motion_comp.c", "slice.c",
    ];
    if arch == "x86_64" {
        config.push_str(
            "#define ARCH_X86_64 1\n#define ACCEL_DETECT 1\n#define HAVE_BUILTIN_EXPECT 1\n\
             #define ATTRIBUTE_ALIGNED_MAX 64\n",
        );
        files.extend(["idct_mmx.c", "motion_comp_mmx.c"]);
    } else {
        config.push_str("#define HAVE_BUILTIN_EXPECT 1\n#define ATTRIBUTE_ALIGNED_MAX 64\n");
    }
    std::fs::write(out.join("config.h"), config).unwrap();
    let mut build = cc::Build::new();
    build
        .include(&out)
        .include(source.join("include"))
        .include(source.join("libmpeg2"))
        .define("HAVE_CONFIG_H", None)
        .opt_level(3)
        .warnings(false);
    for f in files {
        build.file(source.join("libmpeg2").join(f));
    }
    build.compile("mpeg2");
    println!("cargo:rustc-cfg=libmpeg2");
}
