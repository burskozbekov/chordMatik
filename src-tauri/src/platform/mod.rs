//! OS-specific helpers, deliberately isolated so the future Windows port is a
//! build-target change rather than a rewrite. Keep this module tiny — core
//! audio/DSP/ML logic must stay platform-agnostic.

/// Short human label for the host OS (diagnostics + UI footer).
pub fn os_label() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        "macOS"
    }
    #[cfg(target_os = "windows")]
    {
        "Windows"
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        "Unix"
    }
}
