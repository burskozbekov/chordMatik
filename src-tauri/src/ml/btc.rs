//! BTC (Bi-directional Transformer for Chord recognition) inference via ONNX
//! Runtime. Compiled only with `--features btc`.
//!
//! Pipeline matches the reference implementation (jayg996/BTC-ISMIR19):
//!   features = log(|CQT| + 1e-6); normalize by scalar (mean, std) from the
//!   checkpoint; reshape to [n_seq, timestep=108, 144]; run the network to get
//!   per-frame logits over 25 classes; softmax → emissions for our decoder.
//!
//! NOTE: targets `ort` 2.0-rc. If a newer `ort` changes the run/extract API,
//! the two marked lines below are the only ones likely to need adjustment.

use std::path::Path;

use ndarray::Array3;
use ort::session::Session;
use ort::value::Tensor;

use crate::chords::NUM_CHORDS;
use crate::dsp::Spectrogram;

#[derive(serde::Deserialize)]
struct BtcMeta {
    #[serde(default = "one")]
    std: f32,
    #[serde(default)]
    mean: f32,
    #[serde(default = "default_timestep")]
    timestep: usize,
}
fn one() -> f32 {
    1.0
}
fn default_timestep() -> usize {
    108
}

fn load_meta(model_path: &Path) -> BtcMeta {
    let meta_path = model_path.with_extension("meta.json");
    std::fs::read_to_string(&meta_path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(BtcMeta {
            std: 1.0,
            mean: 0.0,
            timestep: 108,
        })
}

pub fn run(spec: &Spectrogram, model_path: &Path) -> Result<Vec<[f32; NUM_CHORDS]>, String> {
    let frames = spec.frames;
    let n_bins = spec.n_bins;
    if frames == 0 {
        return Ok(Vec::new());
    }
    let meta = load_meta(model_path);
    let ts = meta.timestep.max(1);

    // log-magnitude features, scalar-normalized as in the reference.
    let mut feat = vec![0f32; frames * n_bins];
    for i in 0..frames * n_bins {
        feat[i] = ((spec.data[i] + 1e-6).ln() - meta.mean) / meta.std;
    }

    let n_seq = frames.div_ceil(ts);
    let mut input = Array3::<f32>::zeros((n_seq, ts, n_bins));
    for f in 0..frames {
        let (s, r) = (f / ts, f % ts);
        for b in 0..n_bins {
            input[[s, r, b]] = feat[f * n_bins + b];
        }
    }

    let mut session = Session::builder()
        .map_err(|e| format!("ort session builder failed: {e}"))?
        .commit_from_file(model_path)
        .map_err(|e| format!("failed to load model: {e}"))?;

    let tensor = Tensor::from_array(input).map_err(|e| format!("input tensor failed: {e}"))?;

    // --- API-sensitive line #1: running the session ---
    let outputs = session
        .run(ort::inputs![tensor])
        .map_err(|e| format!("inference failed: {e}"))?;

    // --- API-sensitive line #2: extracting the output tensor (ort rc.10) ---
    let (shape, data) = outputs[0]
        .try_extract_tensor::<f32>()
        .map_err(|e| format!("failed to read logits: {e}"))?;

    let last = *shape.last().ok_or("empty output shape")? as usize;
    // Fail loudly on a class-count mismatch instead of silently truncating /
    // zero-padding to NUM_CHORDS (which corrupts every label).
    if last != NUM_CHORDS {
        return Err(format!(
            "BTC output has {last} classes, expected {NUM_CHORDS} — incompatible btc.onnx"
        ));
    }
    let mut emissions: Vec<[f32; NUM_CHORDS]> = Vec::with_capacity(frames);
    'outer: for s in 0..n_seq {
        for r in 0..ts {
            if emissions.len() >= frames {
                break 'outer;
            }
            let base = (s * ts + r) * last;
            let row = &data[base..base + last];
            // softmax over the chord dimension
            let mx = row.iter().copied().fold(f32::NEG_INFINITY, f32::max);
            let mut probs = [0f32; NUM_CHORDS];
            let mut sum = 0f32;
            for c in 0..NUM_CHORDS.min(last) {
                let e = (row[c] - mx).exp();
                probs[c] = e;
                sum += e;
            }
            if sum > 0.0 {
                for p in &mut probs {
                    *p /= sum;
                }
            }
            emissions.push(probs);
        }
    }
    Ok(emissions)
}
