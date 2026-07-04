//! Spotify basic-pitch (`nmp.onnx`) audio→note transcription via ONNX Runtime,
//! ported from the reference C++ (sevagh/basicpitch.cpp). Input: 22050 Hz mono
//! audio. Output: note events (start/duration in seconds, MIDI pitch, amplitude).
//! Compiled only with `--features btc`. The HCQT feature extraction lives INSIDE
//! the model graph, so we feed raw audio windows.

use std::path::Path;

use ndarray::Array3;
use ort::session::Session;
use ort::value::Tensor;

const SR: usize = 22050;
const FFT_HOP: usize = 256;
const ANNOT_FPS: usize = SR / FFT_HOP; // 86 (integer — matches the reference)
const WIN_SAMPLES: usize = SR * 2 - FFT_HOP; // 43844 (model input length)
const WIN_FRAMES: usize = ANNOT_FPS * 2; // 172 (model output frames per window)
const N_OVERLAP: usize = 30;
const ONSET_THRESH: f32 = 0.5;
const FRAME_THRESH: f32 = 0.3;
const MIN_NOTE_LEN: i64 = 11;
const ENERGY_TOL: i64 = 11;
const MIDI_OFFSET: i32 = 21;
const N_FREQ: usize = 88;
const MAX_FREQ_IDX: usize = 87;

pub struct Note {
    pub start_sec: f64,
    pub dur_sec: f64,
    pub midi: i32,
    pub amp: f32,
}

/// Frame index → seconds (basic-pitch's exact mapping incl. the window offset).
fn frame_time(i: usize) -> f64 {
    let otf = FFT_HOP as f64 / SR as f64;
    let wf = 1.0 / WIN_FRAMES as f64;
    let win_off = otf * (WIN_FRAMES as f64 - WIN_SAMPLES as f64 / FFT_HOP as f64) + 0.0018;
    let i = i as f64;
    (i * otf - win_off * (i * wf)).max(0.0)
}

/// Run `nmp.onnx` on 22050 Hz mono audio and extract polyphonic note events.
pub fn transcribe(audio: &[f32], model_path: &Path) -> Result<Vec<Note>, String> {
    if audio.len() < SR {
        return Ok(Vec::new());
    }
    let overlap_len = N_OVERLAP * FFT_HOP; // 7680
    let hop = WIN_SAMPLES - overlap_len; // 36164
    let pad = overlap_len / 2; // 3840
    let padded_len = pad + audio.len();
    let n_chunks = padded_len.div_ceil(hop);

    // Build the [n_chunks, 43844, 1] input (start-padded, zero-padded tail).
    let mut input = Array3::<f32>::zeros((n_chunks, WIN_SAMPLES, 1));
    for c in 0..n_chunks {
        let start = c * hop;
        for j in 0..WIN_SAMPLES {
            let p = start + j;
            let s = if p >= pad {
                audio.get(p - pad).copied().unwrap_or(0.0)
            } else {
                0.0
            };
            input[[c, j, 0]] = s;
        }
    }

    let mut session = Session::builder()
        .map_err(|e| format!("ort builder: {e}"))?
        .commit_from_file(model_path)
        .map_err(|e| format!("load nmp: {e}"))?;
    let tensor = Tensor::from_array(input).map_err(|e| format!("input tensor: {e}"))?;
    let outputs = session
        .run(ort::inputs![tensor])
        .map_err(|e| format!("nmp run: {e}"))?;
    // Verified output order: [0]=onset (:2), [1]=note (:1), [2]=contour (:0).
    let (osh, odata) = outputs[0]
        .try_extract_tensor::<f32>()
        .map_err(|e| format!("onset out: {e}"))?;
    let (_nsh, ndata) = outputs[1]
        .try_extract_tensor::<f32>()
        .map_err(|e| format!("note out: {e}"))?;
    let freqs = (*osh.last().unwrap_or(&(N_FREQ as i64))) as usize;

    // Unwrap: trim 15 frames/side per chunk → 142, concat, trim to song length.
    let n_olap = N_OVERLAP / 2; // 15
    let kept = WIN_FRAMES - 2 * n_olap; // 142
    let n_output = ((audio.len() as f64) * (ANNOT_FPS as f64) / (SR as f64)).floor() as usize;
    let total = (n_chunks * kept).min(n_output).max(1);
    let mut onset = vec![0f32; total * N_FREQ];
    let mut note = vec![0f32; total * N_FREQ];
    'unwrap: for c in 0..n_chunks {
        for t in n_olap..(WIN_FRAMES - n_olap) {
            let g = c * kept + (t - n_olap);
            if g >= total {
                break 'unwrap;
            }
            for f in 0..freqs.min(N_FREQ) {
                let src = c * WIN_FRAMES * freqs + t * freqs + f;
                onset[g * N_FREQ + f] = odata.get(src).copied().unwrap_or(0.0);
                note[g * N_FREQ + f] = ndata.get(src).copied().unwrap_or(0.0);
            }
        }
    }
    let n_times = total;

    // 1) Onset peaks (local max in time above threshold), t-ascending then reverse.
    let mut peaks: Vec<(usize, usize)> = Vec::new();
    for t in 1..n_times.saturating_sub(1) {
        for f in 0..N_FREQ {
            let v = onset[t * N_FREQ + f];
            if v > ONSET_THRESH && v > onset[(t - 1) * N_FREQ + f] && v > onset[(t + 1) * N_FREQ + f]
            {
                peaks.push((t, f));
            }
        }
    }
    peaks.reverse();

    let mut energy = note.clone();
    let mut events: Vec<(usize, usize, i32, f32)> = Vec::new();

    // 2) Trace each onset forward through the note posterior (energy-decay).
    for &(start, f) in &peaks {
        let mut i = start + 1;
        let mut k: i64 = 0;
        while i < n_times.saturating_sub(1) && k < ENERGY_TOL {
            if energy[i * N_FREQ + f] < FRAME_THRESH {
                k += 1;
            } else {
                k = 0;
            }
            i += 1;
        }
        let end = (i as i64 - k).max(0) as usize;
        if (end as i64 - start as i64) <= MIN_NOTE_LEN {
            continue;
        }
        let mut amp = 0f32;
        for t in start..end {
            energy[t * N_FREQ + f] = 0.0;
            if f > 0 {
                energy[t * N_FREQ + f - 1] = 0.0;
            }
            if f < MAX_FREQ_IDX {
                energy[t * N_FREQ + f + 1] = 0.0;
            }
            amp += note[t * N_FREQ + f];
        }
        amp /= (end - start) as f32;
        events.push((start, end, f as i32 + MIDI_OFFSET, amp));
    }

    // 3) Melodia trick: mop up remaining sustained energy into extra notes.
    loop {
        let mut mx = FRAME_THRESH;
        let mut mi = 0usize;
        let mut mf = 0usize;
        let mut found = false;
        for t in 0..n_times {
            for f in 0..N_FREQ {
                let v = energy[t * N_FREQ + f];
                if v > mx {
                    mx = v;
                    mi = t;
                    mf = f;
                    found = true;
                }
            }
        }
        if !found {
            break;
        }
        energy[mi * N_FREQ + mf] = 0.0;
        // forward
        let mut i = mi + 1;
        let mut k: i64 = 0;
        while i < n_times.saturating_sub(1) && k < ENERGY_TOL {
            if energy[i * N_FREQ + mf] < FRAME_THRESH {
                k += 1;
            } else {
                k = 0;
            }
            energy[i * N_FREQ + mf] = 0.0;
            if mf < MAX_FREQ_IDX {
                energy[i * N_FREQ + mf + 1] = 0.0;
            }
            if mf > 0 {
                energy[i * N_FREQ + mf - 1] = 0.0;
            }
            i += 1;
        }
        let end = (i as i64 - 1 - k).max(0) as usize;
        // backward
        let mut i2 = mi as i64 - 1;
        let mut k2: i64 = 0;
        while i2 > 0 && k2 < ENERGY_TOL {
            let ii = i2 as usize;
            if energy[ii * N_FREQ + mf] < FRAME_THRESH {
                k2 += 1;
            } else {
                k2 = 0;
            }
            energy[ii * N_FREQ + mf] = 0.0;
            if mf < MAX_FREQ_IDX {
                energy[ii * N_FREQ + mf + 1] = 0.0;
            }
            if mf > 0 {
                energy[ii * N_FREQ + mf - 1] = 0.0;
            }
            i2 -= 1;
        }
        let start = (i2 + 1 + k2).max(0) as usize;
        if (end as i64 - start as i64) <= MIN_NOTE_LEN {
            continue;
        }
        let mut amp = 0f32;
        for t in start..end {
            amp += note[t * N_FREQ + mf];
        }
        amp /= (end.saturating_sub(start)).max(1) as f32;
        events.push((start, end, mf as i32 + MIDI_OFFSET, amp));
    }

    let mut notes: Vec<Note> = events
        .into_iter()
        .map(|(s, e, midi, amp)| Note {
            start_sec: frame_time(s),
            dur_sec: (frame_time(e) - frame_time(s)).max(0.0),
            midi,
            amp,
        })
        .collect();
    notes.sort_by(|a, b| {
        a.start_sec
            .partial_cmp(&b.start_sec)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    Ok(notes)
}
