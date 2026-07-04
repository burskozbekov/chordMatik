//! HT-Demucs FT bass-specialist source separation via ONNX Runtime, ported from
//! the StemSplitio numpy reference (`infer.py`). The STFT/iSTFT live INSIDE the
//! exported graph, so we feed raw 44.1 kHz stereo and get a raw bass waveform
//! back — no spectral transform to reimplement here. Chunked 7.8 s segments with
//! 25% overlap, trapezoidal cross-fade, overlap-add. Returns the MONO bass stem
//! at 44.1 kHz (downmix of the stereo bass). Compiled only with `--features btc`.

use std::path::Path;

use ndarray::Array3;
use ort::session::Session;
use ort::value::Tensor;

const SR: usize = 44_100;
const SEG: usize = 343_980; // int(7.8 * 44100) — the model's bound segment length
const N_SOURCES: usize = 4; // SOURCES = [drums, bass, other, vocals]
const BASS_SRC: usize = 1; // index of "bass"

/// Trapezoidal cross-fade window: a linear fade in/out over `overlap_frac` of the
/// segment (matches numpy `np.linspace(0,1,transition)` on each edge, 1.0 inside).
fn transition_window(seg: usize, overlap_frac: f32) -> Vec<f32> {
    let trans = (seg as f32 * overlap_frac) as usize;
    let mut w = vec![1.0f32; seg];
    let denom = (trans.max(2) - 1) as f32;
    for i in 0..trans {
        let v = i as f32 / denom; // 0 → 1
        w[i] = v;
        w[seg - 1 - i] = v;
    }
    w
}

/// Separate the bass stem from a 44.1 kHz stereo mix and return it downmixed to
/// mono at 44.1 kHz. `left`/`right` must already be 44.1 kHz.
pub fn separate_bass_mono(
    left: &[f32],
    right: &[f32],
    model_path: &Path,
) -> Result<Vec<f32>, String> {
    let total = left.len().min(right.len());
    if total == 0 {
        return Ok(Vec::new());
    }
    let _ = SR;
    let overlap = SEG / 4;
    let stride = SEG - overlap;
    let n_chunks = total.div_ceil(stride).max(1);
    let window = transition_window(SEG, 0.25);

    let mut session = Session::builder()
        .map_err(|e| format!("ort builder: {e}"))?
        .commit_from_file(model_path)
        .map_err(|e| format!("load demucs: {e}"))?;

    let mut out = vec![0f32; total];
    let mut weight = vec![0f32; total];

    for c in 0..n_chunks {
        let start = c * stride;
        if start >= total {
            break;
        }
        let end = (start + SEG).min(total);
        let chunk_len = end - start;

        // [1, 2, SEG] raw stereo, zero-padded tail.
        let mut input = Array3::<f32>::zeros((1, 2, SEG));
        for j in 0..chunk_len {
            input[[0, 0, j]] = left[start + j];
            input[[0, 1, j]] = right[start + j];
        }
        let tensor = Tensor::from_array(input).map_err(|e| format!("demucs input: {e}"))?;
        let outputs = session
            .run(ort::inputs![tensor])
            .map_err(|e| format!("demucs run: {e}"))?;
        // "stems": [1, 4, 2, SEG]. flat[(src*2 + ch)*seg_out + s]; bass = src 1.
        let (shape, data) = outputs[0]
            .try_extract_tensor::<f32>()
            .map_err(|e| format!("demucs out: {e}"))?;
        let seg_out = *shape.last().unwrap_or(&(SEG as i64)) as usize;
        if seg_out == 0 {
            continue;
        }
        let l_base = (BASS_SRC * 2) * seg_out;
        let r_base = (BASS_SRC * 2 + 1) * seg_out;
        for s in 0..chunk_len.min(seg_out) {
            let bl = data.get(l_base + s).copied().unwrap_or(0.0);
            let br = data.get(r_base + s).copied().unwrap_or(0.0);
            let w = window[s];
            out[start + s] += 0.5 * (bl + br) * w;
            weight[start + s] += w;
        }
    }
    let _ = N_SOURCES;
    for s in 0..total {
        out[s] /= weight[s].max(1e-8);
    }
    Ok(out)
}
