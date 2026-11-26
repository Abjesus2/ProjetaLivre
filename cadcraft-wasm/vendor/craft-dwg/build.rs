//! Sets `no_dwg_bridge` only where acadrust can't be built (FreeBSD aarch64). Upstream also sets it
//! for WebAssembly; this copy keeps the DWG reader in the web build (see Cargo.toml).

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo::rustc-check-cfg=cfg(no_dwg_bridge)");
    let arch = std::env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default();
    let os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    if os == "freebsd" && arch == "aarch64" {
        println!("cargo::rustc-cfg=no_dwg_bridge");
    }
}
