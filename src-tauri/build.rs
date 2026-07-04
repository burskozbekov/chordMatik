fn main() {
    // The macOS system-audio capture path links a Swift bridge (ScreenCaptureKit
    // crate), which references @rpath/libswift_*.dylib. Add the OS Swift runtime
    // dir (resolved from the dyld shared cache) to the binary's rpath so it loads.
    #[cfg(target_os = "macos")]
    println!("cargo:rustc-link-arg-bins=-Wl,-rpath,/usr/lib/swift");

    tauri_build::build()
}
