//! Chord-recognition engine selection.
//!
//! Two engines produce per-frame emissions over the 25-class vocabulary:
//!
//! - **chroma** (always available): template matching on a CQT chromagram.
//!   Fully on-device, no model file, decent accuracy.
//! - **BTC** (optional, behind the `btc` Cargo feature): the pretrained
//!   Bi-directional Transformer run via ONNX Runtime (`ort`). Higher accuracy.
//!   Requires `src-tauri/resources/models/btc.onnx` (+ `btc.meta.json`).
//!
//! Decoding (median + Viterbi → segments) is shared and lives in `crate::chords`.

use std::path::Path;

use crate::chords::NUM_CHORDS;
use crate::dsp::Spectrogram;

#[cfg(feature = "btc")]
mod btc;
#[cfg(feature = "btc")]
pub mod basicpitch;
#[cfg(feature = "btc")]
pub mod demucs;
#[cfg(feature = "btc")]
pub mod chordnet;

/// Engine actually used for an analysis (reported to the UI).
#[derive(Clone, Copy)]
#[allow(dead_code)] // `Btc` is only constructed under the `btc` feature
pub enum Engine {
    Chroma,
    Btc,
}

impl Engine {
    pub fn as_str(self) -> &'static str {
        match self {
            Engine::Chroma => "chroma",
            Engine::Btc => "btc",
        }
    }
}

/// Compute per-frame emissions, choosing BTC when available, else chroma.
/// Returns `(emissions, engine)`.
pub fn emissions(
    spec: &Spectrogram,
    model_path: &Path,
) -> Result<(Vec<[f32; NUM_CHORDS]>, Engine), String> {
    #[cfg(feature = "btc")]
    {
        if model_path.exists() {
            return btc::run(spec, model_path).map(|e| (e, Engine::Btc));
        }
    }
    let _ = model_path; // unused without the `btc` feature
    let chroma = chroma_emissions(spec);
    Ok((chroma, Engine::Chroma))
}

/// Chroma-engine emissions: median-smoothed chromagram → template cosine scores.
fn chroma_emissions(spec: &Spectrogram) -> Vec<[f32; NUM_CHORDS]> {
    let mut chroma = crate::dsp::chromagram(spec, crate::dsp::CqtConfig::default().bins_per_octave);
    crate::chords::median_filter_chroma(&mut chroma, 9);
    crate::chords::chroma_emissions(&chroma)
}
