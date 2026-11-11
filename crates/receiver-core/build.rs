fn main() {
    if std::env::var_os("CARGO_FEATURE_SOAPY").is_some() {
        println!("cargo:rerun-if-env-changed=SOAPY_SDR_ROOT");
        if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
            let root = std::path::PathBuf::from(std::env::var_os("SOAPY_SDR_ROOT").expect(
                "Set SOAPY_SDR_ROOT to a SoapySDR 0.8 or 0.9 MSVC SDK (include/, lib/, bin/)",
            ));
            let header = root.join("include/SoapySDR/Version.h");
            let version = std::fs::read_to_string(&header).expect("Cannot read SoapySDR Version.h");
            // The C API used by source.rs is identical in ABI 0.8 and 0.9.
            assert!(
                version.lines().any(|line| {
                    matches!(
                        line.split_whitespace().collect::<Vec<_>>()[..],
                        ["#define", "SOAPY_SDR_ABI_VERSION", "\"0.8\"" | "\"0.9\""]
                    )
                }),
                "SoapySDR ABI 0.8 or 0.9 is required"
            );
            let library = root.join("lib/SoapySDR.lib");
            assert!(
                library.is_file(),
                "Missing MSVC import library: {}",
                library.display()
            );
            println!("cargo:rerun-if-changed={}", header.display());
            println!("cargo:rerun-if-changed={}", library.display());
            println!(
                "cargo:rustc-link-search=native={}",
                root.join("lib").display()
            );
            println!("cargo:rustc-link-lib=dylib=SoapySDR");
        } else {
            // Ubuntu 24.04 ships 0.8; Homebrew moved to 0.9. The C API used by
            // source.rs is identical in both, so accept either ABI.
            pkg_config::Config::new()
                .range_version("0.8".."0.10")
                .probe("SoapySDR")
                .expect("SoapySDR 0.8 or 0.9 SDK is required; set PKG_CONFIG_PATH or build offline tools with --no-default-features");
        }
    }
}
