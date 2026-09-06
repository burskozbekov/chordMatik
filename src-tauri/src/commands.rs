//! Tauri commands exposed to the frontend. Heavy work runs on the blocking
//! pool so the UI/IPC thread stays responsive. Analyses are cached on disk by
//! file-content hash, making re-opens instant and backing the local library.

use serde::{Deserialize, Serialize};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use tauri::{Emitter, Manager};

use crate::audio::capture::{self, CaptureSession, LiveCapture};
use crate::{audio, cache, chords, dsp, ml, ug};

/// Basic app/runtime info for the UI footer + diagnostics.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub name: String,
    pub version: String,
    pub os: String,
}

#[tauri::command]
pub fn app_info(app: tauri::AppHandle) -> AppInfo {
    AppInfo {
        name: "chordMatik".to_string(),
        // From tauri.conf.json — the SAME source the updater compares against, so
        // the footer version can never drift from the shipped version again
        // (env!(CARGO_PKG_VERSION) read Cargo.toml, which release bumps missed).
        version: app.package_info().version.to_string(),
        os: crate::platform::os_label().to_string(),
    }
}

/// Metadata + waveform overview for a decoded file.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioInfo {
    pub path: String,
    pub duration_sec: f64,
    pub sample_rate: u32,
    pub channels: u16,
    pub peaks: Vec<f32>,
}

/// Decode (or load from cache) a file's metadata + waveform overview.
#[tauri::command]
pub async fn load_audio(
    app: tauri::AppHandle,
    path: String,
    waveform_buckets: Option<usize>,
) -> Result<AudioInfo, String> {
    let buckets = waveform_buckets.unwrap_or(1600).clamp(64, 8192);
    tauri::async_runtime::spawn_blocking(move || {
        // Cache hit → no decode needed.
        if let Ok(hash) = cache::hash_file(Path::new(&path)) {
            if let Some(entry) = cache::load(&app, &hash) {
                return Ok(AudioInfo {
                    path: entry.path,
                    duration_sec: entry.duration_sec,
                    sample_rate: entry.sample_rate,
                    channels: entry.channels,
                    peaks: entry.peaks,
                });
            }
        }
        let decoded = audio::decode_file(Path::new(&path))?;
        let peaks = audio::compute_peaks(&decoded.samples_mono, buckets);
        Ok(AudioInfo {
            path,
            duration_sec: decoded.duration_sec,
            sample_rate: decoded.sample_rate,
            channels: decoded.channels,
            peaks,
        })
    })
    .await
    .map_err(|e| format!("load task failed: {e}"))?
}

/// Full chord analysis: timeline of chord segments + which engine ran.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChordAnalysis {
    pub engine: String,
    pub frame_hop_sec: f64,
    pub duration_sec: f64,
    pub segments: Vec<chords::ChordSegment>,
    /// Measured felt-tactus tempo (BPM) from the recording, 0 if unknown.
    pub bpm: f32,
}

/// Cache-free analysis core (also used by tests). Returns the analysis plus the
/// extra fields needed to persist a cache entry.
struct AnalysisResult {
    analysis: ChordAnalysis,
    peaks: Vec<f32>,
    sample_rate: u32,
    channels: u16,
}

fn analyze_core(path: &str, model_path: &Path, buckets: usize) -> Result<AnalysisResult, String> {
    let decoded = audio::decode_file(Path::new(path))?;
    let peaks = audio::compute_peaks(&decoded.samples_mono, buckets);
    let signal = audio::resample_mono(
        &decoded.samples_mono,
        decoded.sample_rate,
        audio::ANALYSIS_SAMPLE_RATE,
    )?;

    // Measured felt-tactus tempo (BPM) from a BASS-weighted spectral-flux onset
    // envelope: the low register tracks the BEAT (kick/bass), not the 8th-note
    // subdivision, so autocorrelation locks onto the felt octave (e.g. Careless
    // Whisper 76, not 152). Computed once from the analysis CQT, reused by both
    // engines + cached, so the metronome/count-in get the right tempo on load.
    let cfg = dsp::CqtConfig::default();
    let cqt = dsp::Cqt::new(cfg);
    let mut spec = cqt.process(&signal);
    dsp::tuning::correct_tuning(&mut spec, cfg.bins_per_octave);
    let hop_sec = cqt.hop_seconds();
    let bpm = dsp::tempo::estimate_tempo(&dsp::tempo::bass_onset_envelope(&spec), hop_sec);

    // Real beat times (fine ~11.6 ms envelope) — chord changes live on beats, so
    // decoded segment boundaries get snapped to them (fixes the ~93 ms CQT-frame
    // quantization that made the chord timeline look "smeared" around changes).
    let beats = {
        let (fenv, fhop) = dsp::tempo::fine_onset_envelope(&signal, audio::ANALYSIS_SAMPLE_RATE);
        dsp::tempo::track_beats(&fenv, fhop, bpm)
    };

    // Step 3 — the structured ChordNet engine (7ths/sus/dim + inversions/slash
    // chords) when its model is bundled alongside btc.onnx. It uses its own 288-bin
    // CQT + decode, so it bypasses the shared emissions path (but reuses the tempo).
    #[cfg(feature = "btc")]
    {
        let chordnet_path = model_path.with_file_name("chordnet.onnx");
        if chordnet_path.exists() {
            let (mut segments, cn_hop) = ml::chordnet::analyze(&signal, &chordnet_path)?;
            chords::snap_segments_to_beats(&mut segments, &beats);
            return Ok(AnalysisResult {
                analysis: ChordAnalysis {
                    engine: "chordnet".to_string(),
                    frame_hop_sec: cn_hop,
                    duration_sec: decoded.duration_sec,
                    segments,
                    bpm,
                },
                peaks,
                sample_rate: decoded.sample_rate,
                channels: decoded.channels,
            });
        }
    }

    let (emissions, engine) = ml::emissions(&spec, model_path)?;
    let mut segments = chords::decode(&emissions, hop_sec, decoded.duration_sec);
    chords::snap_segments_to_beats(&mut segments, &beats);

    Ok(AnalysisResult {
        analysis: ChordAnalysis {
            engine: engine.as_str().to_string(),
            frame_hop_sec: hop_sec,
            duration_sec: decoded.duration_sec,
            segments,
            bpm,
        },
        peaks,
        sample_rate: decoded.sample_rate,
        channels: decoded.channels,
    })
}

/// Locate `btc.onnx`: bundled resource dir first, then the in-repo dev path
/// (`tauri dev` runs with cwd = src-tauri). Falls back to the resource path.
fn btc_model_path(app: &tauri::AppHandle) -> PathBuf {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        candidates.push(dir.join("models").join("btc.onnx"));
    }
    candidates.push(PathBuf::from("resources/models/btc.onnx"));

    candidates
        .iter()
        .find(|p| p.exists())
        .cloned()
        .unwrap_or_else(|| candidates.into_iter().next().unwrap())
}

fn base_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(path)
        .to_string()
}

// --- Downloadable AI models (too large to bundle in the app) ---

/// (name, filename, url) for models fetched on first use into the app cache dir.
const DL_MODELS: &[(&str, &str, &str)] = &[
    (
        "basic-pitch",
        "nmp.onnx",
        "https://raw.githubusercontent.com/spotify/basic-pitch/main/basic_pitch/saved_models/icassp_2022/nmp.onnx",
    ),
    (
        "demucs-bass",
        "htdemucs_ft_bass.onnx",
        "https://huggingface.co/StemSplitio/htdemucs-ft-bass-onnx/resolve/main/htdemucs_ft_bass.onnx",
    ),
];

fn dl_model_entry(name: &str) -> Option<(&'static str, &'static str)> {
    DL_MODELS.iter().find(|m| m.0 == name).map(|m| (m.1, m.2))
}

fn models_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("no cache dir: {e}"))?
        .join("models");
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir models: {e}"))?;
    Ok(dir)
}

/// Absolute path to a downloaded model if it is already on disk, else None.
pub fn downloaded_model_path(app: &tauri::AppHandle, name: &str) -> Option<PathBuf> {
    let (filename, _) = dl_model_entry(name)?;
    let p = models_dir(app).ok()?.join(filename);
    p.exists().then_some(p)
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ModelProgress {
    name: String,
    received: u64,
    total: u64,
    done: bool,
}

/// Whether a downloadable model is already present locally.
#[tauri::command]
pub fn model_present(app: tauri::AppHandle, name: String) -> bool {
    downloaded_model_path(&app, &name).is_some()
}

/// Stream-download a large model on first use into the app cache dir, emitting
/// "model-download" progress events. Idempotent; writes to a .part then renames.
#[tauri::command]
pub async fn download_model(app: tauri::AppHandle, name: String) -> Result<(), String> {
    let (filename, url) = dl_model_entry(&name).ok_or_else(|| format!("unknown model: {name}"))?;
    let dir = models_dir(&app)?;
    let dest = dir.join(filename);
    if dest.exists() {
        let _ = app.emit(
            "model-download",
            ModelProgress { name, received: 0, total: 0, done: true },
        );
        return Ok(());
    }
    let tmp = dir.join(format!("{filename}.part"));
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(3600))
        .build()
        .map_err(|e| e.to_string())?;
    let mut resp = client
        .get(url)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("download failed: {e}"))?;
    let total = resp.content_length().unwrap_or(0);
    let mut file = std::fs::File::create(&tmp).map_err(|e| format!("create: {e}"))?;
    let mut received = 0u64;
    let mut last = 0u64;
    use std::io::Write;
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("stream: {e}"))? {
        file.write_all(&chunk).map_err(|e| format!("write: {e}"))?;
        received += chunk.len() as u64;
        if received - last >= 2_000_000 {
            last = received;
            let _ = app.emit(
                "model-download",
                ModelProgress { name: name.clone(), received, total, done: false },
            );
        }
    }
    file.flush().map_err(|e| e.to_string())?;
    drop(file);
    std::fs::rename(&tmp, &dest).map_err(|e| format!("finalize: {e}"))?;
    let _ = app.emit(
        "model-download",
        ModelProgress { name, received, total, done: true },
    );
    Ok(())
}

/// A transcribed bass note (real audio → notes via basic-pitch).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BassNote {
    start_sec: f64,
    dur_sec: f64,
    midi: i32,
}

#[cfg(feature = "btc")]
fn transcribe_bass_inner(
    wav_path: &str,
    model: &Path,
    demucs_model: Option<&Path>,
) -> Result<Vec<BassNote>, String> {
    // HQ path: isolate the bass with Demucs first (removes low guitar/kick bleed),
    // so basic-pitch transcribes a clean bass. Falls back to the raw mix otherwise.
    let audio22 = if let Some(dm) = demucs_model {
        let st = audio::decode_file_stereo(Path::new(wav_path))?;
        let l44 = audio::resample_mono(&st.left, st.sample_rate, 44_100)?;
        let r44 = audio::resample_mono(&st.right, st.sample_rate, 44_100)?;
        let bass44 = ml::demucs::separate_bass_mono(&l44, &r44, dm)?;
        audio::resample_mono(&bass44, 44_100, 22_050)?
    } else {
        let decoded = audio::decode_file(Path::new(wav_path))?;
        audio::resample_mono(&decoded.samples_mono, decoded.sample_rate, 22_050)?
    };
    let notes = ml::basicpitch::transcribe(&audio22, model)?;
    // Keep the bass register, drop blips.
    let mut bass: Vec<_> = notes
        .into_iter()
        .filter(|n| n.midi >= 28 && n.midi <= 55 && n.dur_sec >= 0.08)
        .collect();
    bass.sort_by(|a, b| {
        a.start_sec
            .partial_cmp(&b.start_sec)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    // Monophonic reduction: at any moment the bass is the LOWEST sounding note.
    let mut out: Vec<BassNote> = Vec::new();
    for n in bass {
        let overlap = out
            .last()
            .map(|l| n.start_sec < l.start_sec + l.dur_sec)
            .unwrap_or(false);
        if overlap {
            let (last_midi, last_start) = {
                let l = out.last().unwrap();
                (l.midi, l.start_sec)
            };
            if n.midi < last_midi {
                out.last_mut().unwrap().dur_sec = (n.start_sec - last_start).max(0.0);
                out.push(BassNote { start_sec: n.start_sec, dur_sec: n.dur_sec, midi: n.midi });
            }
            // else: a higher overlapping note — the lower one keeps sounding
        } else {
            out.push(BassNote { start_sec: n.start_sec, dur_sec: n.dur_sec, midi: n.midi });
        }
    }
    out.retain(|n| n.dur_sec >= 0.05);
    Ok(out)
}

/// Transcribe the song's bass line from the recording (basic-pitch). Requires the
/// basic-pitch model to be downloaded first. Returns a monophonic note sequence.
#[tauri::command]
pub async fn transcribe_bass(app: tauri::AppHandle, wav_path: String) -> Result<Vec<BassNote>, String> {
    #[cfg(feature = "btc")]
    {
        let model = downloaded_model_path(&app, "basic-pitch")
            .ok_or_else(|| "basic-pitch model not downloaded".to_string())?;
        // Use the Demucs bass model if it has been downloaded (HQ separation).
        let demucs = downloaded_model_path(&app, "demucs-bass");
        return tauri::async_runtime::spawn_blocking(move || {
            transcribe_bass_inner(&wav_path, &model, demucs.as_deref())
        })
        .await
        .map_err(|e| format!("transcribe task failed: {e}"))?;
    }
    #[cfg(not(feature = "btc"))]
    {
        let _ = (app, wav_path);
        Err("transcription requires the btc build".to_string())
    }
}

fn analyze_with_cache(
    app: &tauri::AppHandle,
    path: &str,
    model_path: &Path,
    ephemeral: bool,
    force: bool,
) -> Result<ChordAnalysis, String> {
    let hash = cache::hash_file(Path::new(path)).ok();

    // Cache hit → instant. `force` (the Re-analyze button) skips this so the
    // engine really runs again instead of handing back the same cached result.
    if !force {
        if let Some(h) = &hash {
            if let Some(entry) = cache::load(app, h) {
                return Ok(ChordAnalysis {
                    engine: entry.engine,
                    frame_hop_sec: entry.frame_hop_sec,
                    duration_sec: entry.duration_sec,
                    segments: entry.segments,
                    bpm: entry.bpm,
                });
            }
        }
    }

    let result = analyze_core(path, model_path, 1600)?;

    // Persist for instant re-open + library.
    if let Some(h) = &hash {
        let mut entry = cache::CacheEntry {
            path: path.to_string(),
            name: base_name(path),
            duration_sec: result.analysis.duration_sec,
            sample_rate: result.sample_rate,
            channels: result.channels,
            peaks: result.peaks,
            engine: result.analysis.engine.clone(),
            frame_hop_sec: result.analysis.frame_hop_sec,
            segments: result.analysis.segments.clone(),
            saved_at: 0,
            cache_version: 0, // set by cache::store
            ephemeral,
            bpm: result.analysis.bpm,
        };
        let _ = cache::store(app, h, &mut entry);
    }

    Ok(result.analysis)
}

/// Analyze a file and return its chord timeline.
///
/// `ephemeral` = a downloaded/captured temp file. The analysis IS cached (so
/// re-opening / switching tabs is instant — no re-decode/CQT/infer), but the
/// entry is flagged so it stays OUT of the persistent library list (privacy).
/// The audio file itself is swept when the app quits, not per-song.
#[tauri::command]
pub async fn analyze_chords(
    app: tauri::AppHandle,
    path: String,
    ephemeral: Option<bool>,
    force: Option<bool>,
) -> Result<ChordAnalysis, String> {
    let model_path = btc_model_path(&app);
    let ephemeral = ephemeral.unwrap_or(false);
    let force = force.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        analyze_with_cache(&app, &path, &model_path, ephemeral, force)
    })
    .await
    .map_err(|e| format!("analysis task failed: {e}"))?
}

/// List previously analyzed songs (local library), newest first.
#[tauri::command]
pub fn library_list(app: tauri::AppHandle) -> Vec<cache::LibraryItem> {
    cache::list(&app)
}

/// Remove a song from the local library cache.
#[tauri::command]
pub fn library_remove(app: tauri::AppHandle, hash: String) -> Result<(), String> {
    cache::remove(&app, &hash)
}

/// A local audio file matched to a YouTube title, with a 0–1 confidence score.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioMatch {
    pub path: String,
    pub name: String,
    pub score: f32,
}

/// Supported audio extensions for the music-folder scan.
const MATCH_EXTS: &[&str] = &["mp3", "m4a", "aac", "wav", "flac", "ogg", "oga", "opus"];
/// YouTube-title noise stripped before matching.
const TITLE_NOISE: &[&str] = &[
    "official", "video", "audio", "lyric", "lyrics", "hd", "4k", "mv", "feat", "ft",
    "remaster", "remastered", "explicit", "visualizer", "vevo", "hq", "live",
];

/// Lowercase → split on non-alphanumerics → drop 1-char and YouTube-noise tokens.
fn normalize_tokens(s: &str) -> Vec<String> {
    s.to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .filter(|t| t.len() > 1 && !TITLE_NOISE.contains(t))
        .map(|t| t.to_string())
        .collect()
}

/// Similarity of a query (video title) to a candidate filename, in [0, 1].
fn match_score(query: &[String], file: &[String]) -> (f32, usize) {
    use std::collections::HashSet;
    if query.is_empty() || file.is_empty() {
        return (0.0, 0);
    }
    let qset: HashSet<&str> = query.iter().map(String::as_str).collect();
    let fset: HashSet<&str> = file.iter().map(String::as_str).collect();
    let inter = qset.iter().filter(|t| fset.contains(*t)).count();
    let coverage = inter as f32 / qset.len() as f32; // how much of the title is present
    let union = qset.union(&fset).count().max(1);
    let jaccard = inter as f32 / union as f32; // penalizes very long filenames
    (0.7 * coverage + 0.3 * jaccard, inter)
}

/// Recursively collect audio files under `dir` (bounded, depth-limited).
fn collect_audio_files(dir: &Path, out: &mut Vec<PathBuf>, depth: u32) {
    if depth > 8 || out.len() >= 20_000 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_audio_files(&path, out, depth + 1);
        } else if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
            if MATCH_EXTS.contains(&ext.to_lowercase().as_str()) {
                out.push(path);
            }
        }
    }
}

/// Find the local audio file in `folder` that best matches a YouTube `query`
/// (the video title). Returns the best match above a confidence threshold, or
/// null — so the UI can fall back to manual open / capture.
#[tauri::command]
pub async fn find_matching_audio(
    folder: String,
    query: String,
) -> Result<Option<AudioMatch>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let qtokens = normalize_tokens(&query);
        if qtokens.is_empty() {
            return Ok(None);
        }
        let mut files = Vec::new();
        collect_audio_files(Path::new(&folder), &mut files, 0);

        let mut best: Option<AudioMatch> = None;
        for path in files {
            let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
            let ftokens = normalize_tokens(stem);
            let (score, inter) = match_score(&qtokens, &ftokens);
            // Need a real overlap, and most of the title present.
            if inter == 0 || score < 0.5 {
                continue;
            }
            if best.as_ref().map(|b| score > b.score).unwrap_or(true) {
                best = Some(AudioMatch {
                    path: path.to_string_lossy().into_owned(),
                    name: base_name(&path.to_string_lossy()),
                    score,
                });
            }
        }
        Ok(best)
    })
    .await
    .map_err(|e| format!("match task failed: {e}"))?
}

/// Delete leftover temp audio (downloaded/captured WAVs) from the cache dir.
fn sweep_temp_audio(dir: &Path) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            let p = e.path();
            let is_temp = p
                .file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.starts_with("ytdl-") || (n.starts_with("capture-") && n.ends_with(".wav")))
                .unwrap_or(false);
            if is_temp {
                let _ = std::fs::remove_file(p);
            }
        }
    }
}

/// yt-dlp `--print` template for the fields `compose_video_title` needs.
const TITLE_PRINT_TEMPLATE: &str = "%(title)s\t%(artist)s\t%(uploader)s";

/// Parse the first non-empty `TITLE_PRINT_TEMPLATE` line yt-dlp printed into a
/// composed "Artist - Title" (None when nothing usable was printed).
fn parse_title_line(stdout: &str) -> Option<String> {
    let line = stdout.lines().map(str::trim).find(|l| !l.is_empty())?;
    let mut parts = line.split('\t');
    let raw = parts.next().unwrap_or("").trim();
    let artist = parts.next().unwrap_or("").trim();
    let uploader = parts.next().unwrap_or("").trim();
    let composed = compose_video_title(raw, artist, uploader);
    (!composed.is_empty()).then_some(composed)
}

/// Compose a search-friendly "Artist - Title" from YouTube metadata when the
/// video title lacks an artist. `artist` is yt-dlp's %(artist)s ("NA" when
/// absent); `uploader` is the channel name (cleaned of OFFICIAL/VEVO/Topic
/// cruft). A title that already carries an artist (has " - " or contains the
/// artist's name) is returned untouched.
fn compose_video_title(raw_title: &str, artist: &str, uploader: &str) -> String {
    let title = raw_title.trim();
    if title.is_empty() {
        return String::new();
    }
    if title.contains(" - ") || title.contains(" – ") {
        return title.to_string(); // already "Artist - Title"-shaped
    }
    // Candidate artist: first credited artist, else the cleaned channel name.
    let first_artist = artist.split(',').next().unwrap_or("").trim();
    let cand = if !first_artist.is_empty() && !first_artist.eq_ignore_ascii_case("na") {
        first_artist.to_string()
    } else {
        let mut u = uploader.to_string();
        for noise in ["- Topic", "OFFICIAL", "Official", "official", "VEVO", "Vevo", "vevo"] {
            u = u.replace(noise, " ");
        }
        u.split_whitespace().collect::<Vec<_>>().join(" ")
    };
    if cand.is_empty() || title.to_lowercase().contains(&cand.to_lowercase()) {
        return title.to_string();
    }
    format!("{cand} - {title}")
}

/// Delete ALL downloaded/captured temp audio + the tab caches (Songsterr/UG) —
/// the "Clear all" action, and the ONLY thing that deletes song data. Closing a
/// tab never deletes anything, so a song loaded once always reopens instantly.
#[tauri::command]
pub fn cleanup_temp_audio(app: tauri::AppHandle) -> Result<(), String> {
    if let Ok(dir) = app.path().app_cache_dir() {
        sweep_temp_audio(&dir);
        let _ = std::fs::remove_dir_all(dir.join("tabs"));
    }
    Ok(())
}

/// True if `p` is a regular file with an execute bit (so we don't return a
/// directory or a non-executable file that happens to share the tool's name).
fn is_executable_file(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    match std::fs::metadata(p) {
        Ok(m) => m.is_file() && (m.permissions().mode() & 0o111) != 0,
        Err(_) => false,
    }
}

/// Find a CLI tool by name in common locations (GUI apps get a minimal PATH).
fn find_tool(name: &str) -> Option<PathBuf> {
    for dir in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/opt/local/bin"] {
        let p = Path::new(dir).join(name);
        if is_executable_file(&p) {
            return Some(p);
        }
    }
    if let Ok(path) = std::env::var("PATH") {
        for dir in path.split(':') {
            let p = Path::new(dir).join(name);
            if is_executable_file(&p) {
                return Some(p);
            }
        }
    }
    None
}

/// Run a child process to completion with a wall-clock timeout. The child gets
/// no stdin (so it can never block waiting for input), and its stdout/stderr are
/// drained on threads (so a full pipe can never deadlock it). If it outlives the
/// deadline it is killed and an error is returned — yt-dlp/ffmpeg can otherwise
/// hang forever on a stalled connection, a 429 retry loop, or an interactive prompt.
fn run_with_timeout(mut cmd: Command, timeout: Duration) -> Result<Output, String> {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let mut out_pipe = child.stdout.take();
    let mut err_pipe = child.stderr.take();
    let out_h = thread::spawn(move || {
        let mut b = Vec::new();
        if let Some(p) = out_pipe.as_mut() {
            let _ = p.read_to_end(&mut b);
        }
        b
    });
    let err_h = thread::spawn(move || {
        let mut b = Vec::new();
        if let Some(p) = err_pipe.as_mut() {
            let _ = p.read_to_end(&mut b);
        }
        b
    });
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) => {
                if start.elapsed() > timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("Timed out — the video may be unavailable or the connection stalled.".to_string());
                }
                thread::sleep(Duration::from_millis(100));
            }
            Err(e) => return Err(e.to_string()),
        }
    };
    let stdout = out_h.join().unwrap_or_default();
    let stderr = err_h.join().unwrap_or_default();
    Ok(Output {
        status,
        stdout,
        stderr,
    })
}

/// Update yt-dlp in place: a Homebrew install gets `brew upgrade yt-dlp`, any
/// other install yt-dlp's own `-U`. YouTube changes its player every few weeks
/// and only a CURRENT yt-dlp keeps downloading — this is the real fix behind the
/// "HTTP Error 403" failure, offered as a button instead of a terminal trip.
/// Returns the version that is installed afterwards.
#[tauri::command]
pub async fn update_ytdlp() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base_path = std::env::var("PATH").unwrap_or_default();
        let aug_path = format!("/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:{base_path}");
        let ytdlp = find_tool("yt-dlp")
            .ok_or("yt-dlp is not installed. Install it with: brew install yt-dlp")?;
        let brew = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"]
            .iter()
            .map(PathBuf::from)
            .find(|p| is_executable_file(p));
        // A STANDALONE yt-dlp (the Mach-O release binary, self-updating via `-U`)
        // can sit in /opt/homebrew/bin and shadow the Homebrew formula — seen on
        // the owner's Mac: brew upgraded the Cellar but couldn't link over the
        // stale binary, so the app kept running a June build and every download
        // 403'd. Homebrew's yt-dlp is a `#!` Python script; a Mach-O file means
        // standalone → use its own updater. Otherwise brew, and if brew's link
        // step is blocked by a leftover file, `brew link --overwrite` resolves it.
        let standalone = std::fs::File::open(&ytdlp)
            .and_then(|mut f| {
                let mut magic = [0u8; 2];
                f.read_exact(&mut magic).map(|_| &magic != b"#!")
            })
            .unwrap_or(false);
        let brew_managed = !standalone
            && (ytdlp.starts_with("/opt/homebrew") || ytdlp.starts_with("/usr/local"));
        match brew {
            Some(brew) if brew_managed => {
                let run_brew = |args: &[&str]| -> Result<Output, String> {
                    let mut cmd = Command::new(&brew);
                    cmd.env("PATH", &aug_path)
                        .env("HOMEBREW_NO_ENV_HINTS", "1")
                        .env("HOMEBREW_NO_INSTALL_CLEANUP", "1")
                        .env("HOMEBREW_NO_INSTALL_UPGRADE", "1")
                        .args(args);
                    run_with_timeout(cmd, Duration::from_secs(900))
                };
                let out = run_brew(&["upgrade", "yt-dlp"])?;
                if !out.status.success() {
                    let err = String::from_utf8_lossy(&out.stderr).to_string();
                    if err.contains("already exists") || err.contains("Could not symlink") {
                        let link = run_brew(&["link", "--overwrite", "yt-dlp"])?;
                        if !link.status.success() {
                            return Err(format!(
                                "brew link --overwrite yt-dlp failed: {}",
                                String::from_utf8_lossy(&link.stderr).trim()
                            ));
                        }
                    } else if !err.contains("already installed") {
                        // Nothing to upgrade is reported as a warning, not a failure.
                        let last = err
                            .lines()
                            .filter(|l| l.contains("Error"))
                            .last()
                            .unwrap_or(err.trim())
                            .to_string();
                        return Err(format!("brew upgrade yt-dlp failed: {last}"));
                    }
                }
            }
            _ => {
                let mut cmd = Command::new(&ytdlp);
                cmd.env("PATH", &aug_path).arg("-U");
                let out = run_with_timeout(cmd, Duration::from_secs(300))?;
                if !out.status.success() {
                    return Err(format!(
                        "yt-dlp -U failed: {}",
                        String::from_utf8_lossy(&out.stderr).trim()
                    ));
                }
            }
        }
        let mut v = Command::new(&ytdlp);
        v.env("PATH", &aug_path).arg("--version");
        let out = run_with_timeout(v, Duration::from_secs(30))?;
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    })
    .await
    .map_err(|e| format!("update task failed: {e}"))?
}

/// A downloaded YouTube video (mp4, played locally) + a WAV extracted from it
/// for on-device chord analysis + the title.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct YtAudio {
    pub audio_path: String,
    pub video_path: String,
    pub title: String,
}

/// Download a YouTube video (≤480p mp4) via yt-dlp, then extract a small WAV
/// with ffmpeg for on-device chord analysis. The mp4 is played locally (no
/// YouTube embed → no embed errors); the WAV is analyzed then deleted.
#[tauri::command]
pub async fn download_youtube_audio(
    app: tauri::AppHandle,
    video_id: String,
) -> Result<YtAudio, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // Guard against shell/arg injection — YouTube ids are [A-Za-z0-9_-].
        if video_id.is_empty()
            || video_id.len() > 20
            || !video_id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        {
            return Err("Invalid video id.".to_string());
        }
        let ytdlp = find_tool("yt-dlp")
            .ok_or("yt-dlp is not installed. Install it with: brew install yt-dlp")?;
        let ffmpeg = find_tool("ffmpeg").ok_or("ffmpeg is not installed (brew install ffmpeg)")?;

        let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?;
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let out_tmpl = dir.join(format!("ytdl-{video_id}.%(ext)s"));
        let out_mp4 = dir.join(format!("ytdl-{video_id}.mp4"));
        let out_wav = dir.join(format!("ytdl-{video_id}.wav"));
        let nonempty = |p: &Path| std::fs::metadata(p).map(|m| m.len() > 0).unwrap_or(false);

        let url = format!("https://www.youtube.com/watch?v={video_id}");
        // GUI apps inherit a minimal PATH; yt-dlp needs deno (JS challenges) +
        // ffmpeg. Prepend the common Homebrew/local bin dirs.
        let base_path = std::env::var("PATH").unwrap_or_default();
        let aug_path = format!("/opt/homebrew/bin:/usr/local/bin:/usr/bin:{base_path}");

        // Title/artist/uploader printed by the download run itself (see below).
        let mut printed_title: Option<String> = None;

        // 1) Download a small, webview-playable mp4 (h264/aac ≤480p) — UNLESS we
        // already have it. Reusing avoids deleting the file the <video> element
        // may still be streaming (re-pasting the same link) and is instant.
        if !nonempty(&out_mp4) {
            let _ = std::fs::remove_file(&out_mp4);
            let _ = std::fs::remove_file(&out_wav);
            // YouTube intermittently 403s an adaptive stream from one player_client
            // but not another, and some videos lack the combined 360p format (18).
            // Try a few (format, client) combos before giving up. Prefer h264/aac
            // (webview-playable); 18 = combined mp4, else avc1+m4a merged.
            let attempts: [(&str, &str); 3] = [
                (
                    "18/bv*[height<=480][vcodec^=avc1]+ba[acodec^=mp4a]/b[height<=480][ext=mp4]",
                    "tv,default",
                ),
                (
                    "18/b[height<=480][ext=mp4]/b[ext=mp4]/b",
                    "tv,web_safari,default",
                ),
                ("b[ext=mp4]/b", "default"),
            ];
            let mut last_err = String::from("download failed");
            for (i, (fmt, client)) in attempts.iter().enumerate() {
                if i > 0 {
                    std::thread::sleep(Duration::from_secs(2));
                    let _ = std::fs::remove_file(&out_mp4);
                }
                let ea = format!("youtube:player_client={client}");
                let mut cmd = Command::new(&ytdlp);
                cmd.env("PATH", &aug_path);
                cmd.args([
                    "-f",
                    fmt,
                    "--merge-output-format",
                    "mp4",
                    "--no-playlist",
                    "--no-progress",
                    "--socket-timeout",
                    "30",
                    "--retries",
                    "3",
                    "--extractor-args",
                    &ea,
                    // Print the metadata in the SAME run (--print implies --quiet,
                    // so stdout carries only this line; --no-simulate keeps the
                    // download going) — saves a second yt-dlp round trip per song.
                    "--no-simulate",
                    "--print",
                    TITLE_PRINT_TEMPLATE,
                    "--ffmpeg-location",
                ])
                .arg(&ffmpeg)
                .arg("-o")
                .arg(&out_tmpl)
                .arg(&url);
                let output = run_with_timeout(cmd, Duration::from_secs(180))?;
                if nonempty(&out_mp4) {
                    if let Some(t) = parse_title_line(&String::from_utf8_lossy(&output.stdout)) {
                        printed_title = Some(t);
                    }
                    break;
                }
                let stderr = String::from_utf8_lossy(&output.stderr);
                last_err = stderr
                    .lines()
                    .filter(|l| l.contains("ERROR") || l.contains("Forbidden"))
                    .last()
                    .unwrap_or("download failed")
                    .to_string();
            }

            if !nonempty(&out_mp4) {
                // YouTube changes its player regularly and only a CURRENT yt-dlp
                // keeps up — an outdated one is by far the most common cause here,
                // so say so instead of leaving the user to guess.
                return Err(format!(
                    "Couldn't get the video from YouTube. {last_err} If this keeps happening, update yt-dlp (brew upgrade yt-dlp)."
                ));
            }
        }

        // 2) Extract a mono 22.05 kHz WAV from the local mp4 for analysis
        // (only when missing — it may have been swept since a prior analysis).
        if !nonempty(&out_wav) {
            let mut ffcmd = Command::new(&ffmpeg);
            ffcmd
                .args(["-nostdin", "-loglevel", "error", "-y", "-i"])
                .arg(&out_mp4)
                .args(["-vn", "-ac", "1", "-ar", "22050"])
                .arg(&out_wav);
            let ff = run_with_timeout(ffcmd, Duration::from_secs(90))?;
            if !nonempty(&out_wav) {
                let stderr = String::from_utf8_lossy(&ff.stderr);
                return Err(format!(
                    "Couldn't extract audio for analysis. {}",
                    stderr.lines().last().unwrap_or("")
                ));
            }
        }

        // 3) Best-effort title + ARTIST in one metadata call. A bare title
        // ("Solitude") makes every by-title lookup ambiguous — the wrong famous
        // band wins the tab search, and audio cross-validation can't always
        // disambiguate two similar songs. YouTube's own metadata knows the artist
        // (music uploads carry %(artist)s; official channels name themselves), so
        // compose "Artist - Title" when the title lacks one. Cached in a v2
        // sidecar so reopening never waits on the network (old .title ignored).
        let title_cache = dir.join(format!("ytdl-{video_id}.title2"));
        let title = match std::fs::read_to_string(&title_cache) {
            Ok(t) if !t.trim().is_empty() => t.trim().to_string(),
            _ => {
                // Prefer the metadata the download run already printed; only an
                // mp4 reused from disk (no download this time) needs its own call.
                let fetched = match printed_title {
                    Some(t) => Some(t),
                    None => {
                        let mut t = Command::new(&ytdlp);
                        t.env("PATH", &aug_path);
                        t.args([
                            "--skip-download",
                            "--no-playlist",
                            "--no-warnings",
                            "--socket-timeout",
                            "20",
                            "--extractor-args",
                            "youtube:player_client=tv,default",
                            "--print",
                            TITLE_PRINT_TEMPLATE,
                        ])
                        .arg(&url);
                        run_with_timeout(t, Duration::from_secs(40))
                            .ok()
                            .and_then(|o| parse_title_line(&String::from_utf8_lossy(&o.stdout)))
                    }
                };
                if let Some(ref s) = fetched {
                    let _ = std::fs::write(&title_cache, s);
                }
                fetched.unwrap_or_else(|| format!("YouTube · {video_id}"))
            }
        };

        Ok(YtAudio {
            audio_path: out_wav.to_string_lossy().into_owned(),
            video_path: out_mp4.to_string_lossy().into_owned(),
            title,
        })
    })
    .await
    .map_err(|e| format!("download task failed: {e}"))?
}

// --- Guitar/bass tab fetching (Songsterr) -----------------------------------

const SONGSTERR_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/// A fetched tab: the raw Songsterr track JSON for guitar + bass (either null),
/// plus the ranked alternate candidates (for audio cross-validation / "try
/// another version"). `guitar`/`bass` are the best candidate's tracks.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabResult {
    pub song_id: i64,
    pub artist: String,
    pub title: String,
    pub guitar: Option<serde_json::Value>,
    pub bass: Option<serde_json::Value>,
    pub drums: Option<serde_json::Value>,
    pub piano: Option<serde_json::Value>,
    pub candidates: Vec<TabCandidate>,
}

/// A lightweight ranked search candidate (no track JSON until selected).
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TabCandidate {
    pub song_id: i64,
    pub artist: String,
    pub title: String,
    pub score: f64,
    pub views: i64,
    pub has_chords: bool,
}

#[derive(Deserialize)]
struct HitTrack {
    #[serde(rename = "instrumentId")]
    instrument_id: Option<i64>,
    views: Option<i64>,
}

#[derive(Deserialize)]
struct SongHit {
    #[serde(rename = "songId")]
    song_id: i64,
    artist: Option<String>,
    title: Option<String>,
    #[serde(rename = "isJunk", default)]
    is_junk: bool,
    #[serde(rename = "hasChords", default)]
    has_chords: bool,
    #[serde(default)]
    tracks: Vec<HitTrack>,
    #[serde(rename = "popularTrackGuitar")]
    pop_guitar: Option<i64>,
    #[serde(rename = "popularTrackBass")]
    pop_bass: Option<i64>,
    #[serde(rename = "popularTrackDrum")]
    pop_drum: Option<i64>,
}

impl SongHit {
    /// Track index (= CDN part id) of the best PIANO/keyboard track (GM program
    /// 0-7 are pianos), by views. Songsterr encodes piano notes as string/fret on
    /// a guitar tuning, so the normal converter handles it (show notation).
    fn piano_part(&self) -> Option<i64> {
        self.tracks
            .iter()
            .enumerate()
            .filter(|(_, t)| t.instrument_id.is_some_and(|id| (0..=7).contains(&id)))
            .max_by_key(|(_, t)| t.views.unwrap_or(0))
            .map(|(i, _)| i as i64)
    }
    /// Track index of the DRUMS track (instrumentId 1024) if `popularTrackDrum`
    /// isn't given.
    fn drum_part(&self) -> Option<i64> {
        self.pop_drum.or_else(|| {
            self.tracks
                .iter()
                .position(|t| t.instrument_id == Some(1024))
                .map(|i| i as i64)
        })
    }
}

impl SongHit {
    /// Max per-track views — Songsterr's only popularity/quality proxy.
    fn views(&self) -> i64 {
        self.tracks.iter().filter_map(|t| t.views).max().unwrap_or(0)
    }

    /// Candidate part ids for an instrument, best-first: tracks whose GM program
    /// is in `gm` (by views), then every other non-drum track (by views) — the
    /// labels LIE (vocal sketches tagged "Electric Bass"), so content validation
    /// downstream decides; the id ranking just orders the search.
    fn instrument_candidates(&self, gm: std::ops::RangeInclusive<i64>) -> Vec<i64> {
        let mut labeled: Vec<(i64, i64)> = Vec::new(); // (views, part)
        let mut rest: Vec<(i64, i64)> = Vec::new();
        for (i, t) in self.tracks.iter().enumerate() {
            let id = t.instrument_id.unwrap_or(-1);
            if id == 1024 {
                continue; // drums
            }
            let v = t.views.unwrap_or(0);
            if gm.contains(&id) {
                labeled.push((v, i as i64));
            } else {
                rest.push((v, i as i64));
            }
        }
        labeled.sort_by(|a, b| b.0.cmp(&a.0));
        rest.sort_by(|a, b| b.0.cmp(&a.0));
        labeled.into_iter().chain(rest).map(|(_, p)| p).collect()
    }
}

/// (lowest tuned string midi, string count, fraction of beats carrying notes).
fn track_stats(t: &serde_json::Value) -> (i64, usize, f64) {
    let tuning: Vec<i64> = t
        .get("tuning")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_i64()).collect())
        .unwrap_or_default();
    let min_t = tuning.iter().copied().min().unwrap_or(0);
    let mut beats = 0usize;
    let mut with_notes = 0usize;
    if let Some(ms) = t.get("measures").and_then(|v| v.as_array()) {
        for m in ms {
            let Some(vs) = m.get("voices").and_then(|v| v.as_array()) else { continue };
            for v in vs {
                let Some(bs) = v.get("beats").and_then(|v| v.as_array()) else { continue };
                for b in bs {
                    beats += 1;
                    let rest = b.get("rest").and_then(|r| r.as_bool()).unwrap_or(false);
                    let notes = b
                        .get("notes")
                        .and_then(|v| v.as_array())
                        .map(|a| {
                            a.iter()
                                .filter(|n| !n.get("rest").and_then(|r| r.as_bool()).unwrap_or(false))
                                .count()
                        })
                        .unwrap_or(0);
                    if !rest && notes > 0 {
                        with_notes += 1;
                    }
                }
            }
        }
    }
    let density = if beats == 0 { 0.0 } else { with_notes as f64 / beats as f64 };
    (min_t, tuning.len(), density)
}

/// A REAL bass track: 4-5 strings tuned into the bass register (lowest ≤ C2),
/// actually played (not a rest sheet). Every genuine bass in the wild fits
/// (min 23-28, density 69-100%); the mislabeled junk (6-string guitar tuning,
/// 13% density, "Electric Bass" name) doesn't. Content over labels.
fn is_real_bass(t: &serde_json::Value) -> bool {
    let (min_t, n_strings, density) = track_stats(t);
    (4..=5).contains(&n_strings) && min_t > 0 && min_t <= 33 && density >= 0.25
}

/// A REAL guitar track: ≥6 strings in guitar register, with actual content.
fn is_real_guitar(t: &serde_json::Value) -> bool {
    let (min_t, n_strings, density) = track_stats(t);
    n_strings >= 6 && min_t >= 34 && density >= 0.20
}

#[derive(Deserialize)]
struct TabMeta {
    #[serde(rename = "revisionId")]
    revision_id: i64,
    image: String,
    #[serde(rename = "popularTrackGuitar")]
    pop_guitar: Option<i64>,
    #[serde(rename = "popularTrackBass")]
    pop_bass: Option<i64>,
}

/// Performance/variant markers — a tab whose title carries one of these is a
/// different recording (live/acoustic/cover/…) and must lose to the canonical
/// studio version unless the query explicitly asked for that variant.
const VARIANT_WORDS: &[&str] = &[
    "live", "acoustic", "cover", "remix", "demo", "karaoke", "instrumental", "medley", "tribute",
    "unplugged", "rehearsal", "soundcheck", "bootleg", "reprise", "session", "orchestral",
];
/// Noise tokens from YouTube titles that shouldn't drive matching either way.
const JUNK_WORDS: &[&str] = &[
    "official", "music", "video", "audio", "lyric", "lyrics", "hd", "hq", "4k", "mv", "feat", "ft",
    "remaster", "remastered", "explicit", "visualizer", "performance", "full", "song",
];

/// Tokenize a title: lowercase alphanumerics, drop 1-char + junk words.
fn norm_tokens(s: &str) -> std::collections::HashSet<String> {
    s.to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .filter(|t| t.len() > 1 && !JUNK_WORDS.contains(t))
        .map(String::from)
        .collect()
}

type TokenSet = std::collections::HashSet<String>;

/// Parse a (possibly messy YouTube) title into matching signals: all tokens, the
/// artist tokens (left of " - " if present), and the variant words the SOURCE
/// itself carries (so a "live" query intentionally matches the live tab).
fn parse_query(raw: &str) -> (TokenSet, TokenSet, TokenSet) {
    let all = norm_tokens(raw);
    let variants: TokenSet = VARIANT_WORDS
        .iter()
        .filter(|w| all.contains(**w))
        .map(|s| s.to_string())
        .collect();
    // Split artist from title on the first " - " (the YouTube convention).
    let artist = raw
        .find(" - ")
        .map(|i| norm_tokens(&raw[..i]))
        .unwrap_or_default();
    (all, artist, variants)
}

/// Score a Songsterr search hit. Hard-rejects junk; rewards token + artist match
/// and community popularity (views); penalizes verbosity and live/acoustic/cover
/// variants the source didn't ask for (and rewards the ones it did).
fn hit_score(
    qtokens: &TokenSet,
    artist_tokens: &TokenSet,
    src_variants: &TokenSet,
    hit: &SongHit,
) -> f64 {
    if hit.is_junk {
        return f64::MIN;
    }
    let hay = format!(
        "{} {}",
        hit.artist.as_deref().unwrap_or(""),
        hit.title.as_deref().unwrap_or("")
    );
    let ht = norm_tokens(&hay);
    let matched = qtokens.iter().filter(|t| ht.contains(*t)).count();
    if matched == 0 {
        return f64::MIN;
    }
    let extra = ht.iter().filter(|t| !qtokens.contains(*t)).count();
    // Artist match is the strongest signal against covers (right title, wrong band).
    let artist_hit =
        !artist_tokens.is_empty() && artist_tokens.iter().all(|t| ht.contains(t));
    // Variant words present in the hit but not in the source → wrong version.
    let hit_variants: TokenSet = VARIANT_WORDS
        .iter()
        .filter(|w| ht.contains(**w))
        .map(|s| s.to_string())
        .collect();
    let mismatch = hit_variants.iter().filter(|w| !src_variants.contains(*w)).count();
    let reward = hit_variants.iter().filter(|w| src_variants.contains(*w)).count();
    // log10(views): ~0 (obscure) .. ~6-7 (a million+ views).
    let pop = hit.views();
    let pop_score = if pop > 0 { (pop as f64).log10() } else { 0.0 };

    matched as f64 * 10.0 + if artist_hit { 15.0 } else { 0.0 } - extra as f64
        - mismatch as f64 * 14.0
        + reward as f64 * 6.0
        + pop_score * 2.0
        + if hit.has_chords { 2.0 } else { 0.0 }
}

/// Fetch one track's gzip JSON from the CDN, caching it (immutable per revision).
async fn fetch_track_json(
    client: &reqwest::Client,
    cache_dir: &Path,
    song_id: i64,
    rev: i64,
    image: &str,
    part: i64,
) -> Option<serde_json::Value> {
    let cache = cache_dir.join(format!("tab-{song_id}-{rev}-{part}.json"));
    if let Ok(s) = std::fs::read_to_string(&cache) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&s) {
            return Some(v);
        }
    }
    let url = format!("https://dqsljvtekg760.cloudfront.net/{song_id}/{rev}/{image}/{part}.json");
    let resp = client.get(&url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let val: serde_json::Value = resp.json().await.ok()?;
    let _ = std::fs::create_dir_all(cache_dir);
    let _ = std::fs::write(&cache, val.to_string());
    Some(val)
}

/// A song's fetched track JSON per instrument (any may be None).
#[derive(Default)]
struct SongTracks {
    guitar: Option<serde_json::Value>,
    bass: Option<serde_json::Value>,
    drums: Option<serde_json::Value>,
    piano: Option<serde_json::Value>,
}

/// Fetch parts in `order` (deduped, capped) until one passes `valid`. Returns
/// `(first_valid, first_fetched)` — the caller decides whether to fall back.
async fn pick_valid_track(
    client: &reqwest::Client,
    cache_dir: &Path,
    song_id: i64,
    rev: i64,
    img: &str,
    order: &[i64],
    valid: fn(&serde_json::Value) -> bool,
) -> (Option<serde_json::Value>, Option<serde_json::Value>) {
    let mut tried = std::collections::HashSet::new();
    let mut first: Option<serde_json::Value> = None;
    for &p in order.iter() {
        if tried.len() >= 6 {
            break; // cap CDN fetches per instrument (cache makes retries cheap)
        }
        if !tried.insert(p) {
            continue;
        }
        if let Some(j) = fetch_track_json(client, cache_dir, song_id, rev, img, p).await {
            if valid(&j) {
                return (Some(j), first);
            }
            if first.is_none() {
                first = Some(j);
            }
        }
    }
    (None, first)
}

/// Fetch a song's guitar / bass / drums / piano track JSON (meta → CDN). Any may
/// be None; all None on a meta failure. Songsterr's "popular track" pointers and
/// instrument labels are unreliable (rest-sheet vocal sketches tagged as bass),
/// so each pick is CONTENT-validated (tuning register + note density) and the
/// song's other tracks are scanned when the labeled pick fails.
async fn fetch_song_tracks(
    client: &reqwest::Client,
    cache_dir: &Path,
    song_id: i64,
    guitar_part: Option<i64>,
    bass_part: Option<i64>,
    drum_part: Option<i64>,
    piano_part: Option<i64>,
    guitar_cands: &[i64],
    bass_cands: &[i64],
) -> SongTracks {
    let meta: TabMeta = match client
        .get(format!("https://www.songsterr.com/api/meta/{song_id}"))
        .send()
        .await
        .and_then(|r| r.error_for_status())
    {
        Ok(r) => match r.json().await {
            Ok(m) => m,
            Err(_) => return SongTracks::default(),
        },
        Err(_) => return SongTracks::default(),
    };
    let rev = meta.revision_id;
    let img = meta.image;

    let mut border: Vec<i64> = Vec::new();
    border.extend(meta.pop_bass);
    border.extend(bass_part);
    border.extend_from_slice(bass_cands);
    let mut gorder: Vec<i64> = Vec::new();
    gorder.extend(meta.pop_guitar);
    gorder.extend(guitar_part);
    gorder.extend_from_slice(guitar_cands);

    let (bass, _bad_bass) =
        pick_valid_track(client, cache_dir, song_id, rev, &img, &border, is_real_bass).await;
    let (guitar, bad_guitar) =
        pick_valid_track(client, cache_dir, song_id, rev, &img, &gorder, is_real_guitar).await;

    SongTracks {
        // No validated guitar → keep the labeled pick (a sparse guitar still beats
        // losing the whole tab). No validated bass → NONE: a rest-sheet "bass" is
        // exactly the failure users hit, and the UI has real fallbacks (generated
        // bass, ⭐ rated text tab).
        guitar: guitar.or(bad_guitar),
        bass,
        drums: match drum_part {
            Some(p) => fetch_track_json(client, cache_dir, song_id, rev, &img, p).await,
            None => None,
        },
        piano: match piano_part {
            Some(p) => fetch_track_json(client, cache_dir, song_id, rev, &img, p).await,
            None => None,
        },
    }
}

/// Find + fetch the best guitar & bass tab for a song title (Songsterr), plus a
/// ranked list of alternate candidates for audio cross-validation. Returns null
/// when nothing matches. Unofficial endpoints — every step degrades to a skip.
#[tauri::command]
pub async fn fetch_tabs(
    app: tauri::AppHandle,
    title: String,
    fresh: Option<bool>,
) -> Result<Option<TabResult>, String> {
    // Whole-result disk cache keyed by the (normalized) title + a PICK VERSION:
    // reopening a song never waits on the Songsterr search again, but bumping
    // TAB_PICK_VERSION (when the ranking/validation changes) invalidates every
    // stale pick automatically. `fresh` (↻ Refresh) bypasses + rewrites the cache.
    const TAB_PICK_VERSION: u32 = 2; // bump when fetch/track-pick logic changes
    let cache_dir_early = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("tabs");
    let mut key_parts: Vec<String> = norm_tokens(&title).into_iter().collect();
    key_parts.sort();
    let result_cache =
        cache_dir_early.join(format!("sresult-v{TAB_PICK_VERSION}-{}.json", key_parts.join("_")));
    if !fresh.unwrap_or(false) {
        if let Ok(s) = std::fs::read_to_string(&result_cache) {
            if let Ok(r) = serde_json::from_str::<TabResult>(&s) {
                return Ok(Some(r));
            }
        }
    }

    let client = reqwest::Client::builder()
        .user_agent(SONGSTERR_UA)
        .gzip(true)
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;

    // 1) Search → rank all hits (junk-filtered), best-first.
    let hits: Vec<SongHit> = match client
        .get("https://www.songsterr.com/api/songs")
        .query(&[("pattern", title.as_str()), ("size", "16")])
        .send()
        .await
        .and_then(|r| r.error_for_status())
    {
        Ok(r) => r.json().await.unwrap_or_default(),
        Err(_) => return Ok(None),
    };
    let (qtokens, artist_tokens, src_variants) = parse_query(&title);
    let mut ranked: Vec<(f64, &SongHit)> = hits
        .iter()
        .map(|h| (hit_score(&qtokens, &artist_tokens, &src_variants, h), h))
        .filter(|(s, _)| *s > 0.0)
        .collect();
    ranked.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    if ranked.is_empty() {
        return Ok(None);
    }
    let candidates: Vec<TabCandidate> = ranked
        .iter()
        .take(6)
        .map(|(s, h)| TabCandidate {
            song_id: h.song_id,
            artist: h.artist.clone().unwrap_or_default(),
            title: h.title.clone().unwrap_or_default(),
            score: *s,
            views: h.views(),
            has_chords: h.has_chords,
        })
        .collect();

    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("tabs");

    // 2) Fetch the best candidate that actually yields tracks (try the top few).
    //    Pulls guitar/bass/drums/piano in one shot.
    for (_, h) in ranked.iter().take(3) {
        let t = fetch_song_tracks(
            &client,
            &cache_dir,
            h.song_id,
            h.pop_guitar,
            h.pop_bass,
            h.drum_part(),
            h.piano_part(),
            &h.instrument_candidates(24..=31), // GM guitars
            &h.instrument_candidates(32..=39), // GM basses
        )
        .await;
        if t.guitar.is_some() || t.bass.is_some() || t.drums.is_some() || t.piano.is_some() {
            let result = TabResult {
                song_id: h.song_id,
                artist: h.artist.clone().unwrap_or_default(),
                title: h.title.clone().unwrap_or_default(),
                guitar: t.guitar,
                bass: t.bass,
                drums: t.drums,
                piano: t.piano,
                candidates,
            };
            // Cache only successes — a transient failure must not stick.
            let _ = std::fs::create_dir_all(&cache_dir_early);
            if let Ok(s) = serde_json::to_string(&result) {
                let _ = std::fs::write(&result_cache, s);
            }
            return Ok(Some(result));
        }
    }
    Ok(None)
}

/// Fetch a specific song's tracks by id — for "try another version" (selecting
/// an alternate candidate after audio cross-validation rejects the first pick).
#[tauri::command]
pub async fn fetch_tab_track(
    app: tauri::AppHandle,
    song_id: i64,
    title: String,
    artist: String,
) -> Result<Option<TabResult>, String> {
    let client = reqwest::Client::builder()
        .user_agent(SONGSTERR_UA)
        .gzip(true)
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("tabs");
    // Recover this song's track list (instrument ids + hints) so the content
    // validation can hunt the real bass/guitar among its parts too.
    let hit: Option<SongHit> = match client
        .get("https://www.songsterr.com/api/songs")
        .query(&[("pattern", title.as_str()), ("size", "16")])
        .send()
        .await
        .and_then(|r| r.error_for_status())
    {
        Ok(r) => r
            .json::<Vec<SongHit>>()
            .await
            .ok()
            .and_then(|hs| hs.into_iter().find(|h| h.song_id == song_id)),
        Err(_) => None,
    };
    let (pop_g, pop_b, drum, piano, gcands, bcands) = match &hit {
        Some(h) => (
            h.pop_guitar,
            h.pop_bass,
            h.drum_part(),
            h.piano_part(),
            h.instrument_candidates(24..=31),
            h.instrument_candidates(32..=39),
        ),
        None => (None, None, None, None, Vec::new(), Vec::new()),
    };
    let t =
        fetch_song_tracks(&client, &cache_dir, song_id, pop_g, pop_b, drum, piano, &gcands, &bcands)
            .await;
    if t.guitar.is_none() && t.bass.is_none() {
        return Ok(None);
    }
    Ok(Some(TabResult {
        song_id,
        artist,
        title,
        guitar: t.guitar,
        bass: t.bass,
        drums: t.drums,
        piano: t.piano,
        candidates: vec![],
    }))
}

/// Find the highest-RATED community bass tab (Ultimate Guitar) for a song title.
/// Returns plain-text ASCII tab + star rating + alternate versions, or null.
/// `fresh` bypasses the on-disk pick cache (↻ refresh).
#[tauri::command]
pub async fn fetch_bass_tab(
    app: tauri::AppHandle,
    title: String,
    fresh: Option<bool>,
) -> Option<ug::BassTab> {
    let cache_dir = app.path().app_cache_dir().ok()?.join("tabs");
    ug::best_bass_tab(&cache_dir, &title, fresh.unwrap_or(false)).await
}

/// Fetch a specific bass-tab version's ASCII content by id (for the version picker).
#[tauri::command]
pub async fn fetch_bass_tab_content(app: tauri::AppHandle, id: u64) -> Option<String> {
    let cache_dir = app.path().app_cache_dir().ok()?.join("tabs");
    ug::tab_content(&cache_dir, id).await
}

// --- Lyrics (lrclib.net — free, synced LRC) ---------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricsResult {
    pub synced: Option<String>,
    pub plain: Option<String>,
    pub artist: String,
    pub title: String,
}

#[derive(Deserialize)]
struct LrcEntry {
    #[serde(rename = "trackName")]
    track_name: Option<String>,
    #[serde(rename = "artistName")]
    artist_name: Option<String>,
    #[serde(rename = "syncedLyrics")]
    synced_lyrics: Option<String>,
    #[serde(rename = "plainLyrics")]
    plain_lyrics: Option<String>,
    #[serde(default)]
    instrumental: bool,
}

impl LrcEntry {
    fn has_lyrics(&self) -> bool {
        !self.instrumental
            && (self.synced_lyrics.as_deref().is_some_and(|s| !s.is_empty())
                || self.plain_lyrics.as_deref().is_some_and(|s| !s.is_empty()))
    }
    fn into_result(self) -> LyricsResult {
        LyricsResult {
            synced: self.synced_lyrics.filter(|s| !s.is_empty()),
            plain: self.plain_lyrics.filter(|s| !s.is_empty()),
            artist: self.artist_name.unwrap_or_default(),
            title: self.track_name.unwrap_or_default(),
        }
    }
}

/// Strip YouTube cruft + split a messy title into (artist, track) on " - ".
fn clean_for_lyrics(raw: &str) -> (String, String) {
    let mut s = String::with_capacity(raw.len());
    let mut depth: i32 = 0;
    for c in raw.chars() {
        match c {
            '(' | '[' | '{' => depth += 1,
            ')' | ']' | '}' => depth = (depth - 1).max(0),
            _ if depth == 0 => s.push(c),
            _ => {}
        }
    }
    // Drop a file extension if present.
    let s = s.trim();
    let s = s.rsplit_once('.').map_or(s, |(stem, ext)| {
        if ext.len() <= 4 && ext.chars().all(|c| c.is_ascii_alphanumeric()) {
            stem
        } else {
            s
        }
    });
    let s = s.trim();
    match s.split_once(" - ") {
        Some((a, t)) => (a.trim().to_string(), t.trim().to_string()),
        None => (String::new(), s.to_string()),
    }
}

/// Lowercase alphanumeric tokens of a title, minus common noise words and
/// pure-number / single-char tokens. Used to judge if a lyrics hit is on-topic.
fn lyric_tokens(s: &str) -> std::collections::HashSet<String> {
    const NOISE: &[&str] = &[
        "official", "video", "audio", "lyrics", "lyric", "music", "hd", "hq", "mv", "mp3", "kbps",
        "remaster", "remastered", "remix", "live", "version", "feat", "ft", "the", "and", "of",
    ];
    s.to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .filter(|t| t.len() > 1 && !t.chars().all(|c| c.is_ascii_digit()) && !NOISE.contains(t))
        .map(str::to_string)
        .collect()
}

/// Reject an lrclib hit that isn't actually the song we asked for — the fuzzy
/// `/search` will happily return an unrelated track (e.g. "Suzanne Vega – Luka"
/// for a completely different song). The candidate's TRACK name must be
/// well-represented in the (messy) title; if we parsed an "Artist - Title", the
/// candidate's artist must share a token too (so Adele's "Hello" ≠ Lionel's).
fn lyrics_relevant(title: &str, parsed_artist: &str, e: &LrcEntry) -> bool {
    let want = lyric_tokens(title);
    let track = lyric_tokens(e.track_name.as_deref().unwrap_or(""));
    if want.is_empty() || track.is_empty() {
        return false;
    }
    let inter = track.intersection(&want).count();
    let denom = track.len().min(want.len());
    if (inter as f32 / denom as f32) < 0.5 {
        return false;
    }
    let pa = lyric_tokens(parsed_artist);
    if pa.is_empty() {
        return true; // title was just a track name — nothing to cross-check
    }
    let ca = lyric_tokens(e.artist_name.as_deref().unwrap_or(""));
    pa.intersection(&ca).count() >= 1
}

/// Fetch lyrics for a (messy) song title from lrclib — synced LRC if available.
#[tauri::command]
pub async fn fetch_lyrics(title: String) -> Result<Option<LyricsResult>, String> {
    let client = reqwest::Client::builder()
        .user_agent("chordMatik (https://github.com/chordmatik)")
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let (artist, track) = clean_for_lyrics(&title);
    let has_synced = |e: &LrcEntry| e.synced_lyrics.as_deref().is_some_and(|s| !s.is_empty());
    // Remember a plain-only hit but keep hunting for SYNCED lyrics (they highlight).
    let mut plain_fallback: Option<LyricsResult> = None;

    // 1) Exact get by artist + track.
    if !artist.is_empty() && !track.is_empty() {
        if let Ok(r) = client
            .get("https://lrclib.net/api/get")
            .query(&[("artist_name", artist.as_str()), ("track_name", track.as_str())])
            .send()
            .await
            .and_then(|r| r.error_for_status())
        {
            if let Ok(e) = r.json::<LrcEntry>().await {
                if lyrics_relevant(&title, &artist, &e) {
                    if has_synced(&e) {
                        return Ok(Some(e.into_result()));
                    }
                    if e.has_lyrics() {
                        plain_fallback = Some(e.into_result());
                    }
                }
            }
        }
    }

    // 2) Fuzzy search — first SYNCED hit wins; otherwise remember a plain one.
    let q = if track.is_empty() {
        title.clone()
    } else if artist.is_empty() {
        track.clone()
    } else {
        format!("{artist} {track}")
    };
    if let Ok(r) = client
        .get("https://lrclib.net/api/search")
        .query(&[("q", q.as_str())])
        .send()
        .await
        .and_then(|r| r.error_for_status())
    {
        if let Ok(list) = r.json::<Vec<LrcEntry>>().await {
            for e in list.into_iter().filter(|e| e.has_lyrics()) {
                if !lyrics_relevant(&title, &artist, &e) {
                    continue; // unrelated fuzzy hit — skip rather than show wrong lyrics
                }
                if has_synced(&e) {
                    return Ok(Some(e.into_result()));
                }
                if plain_fallback.is_none() {
                    plain_fallback = Some(e.into_result());
                }
            }
        }
    }
    Ok(plain_fallback)
}

// --- Phase B: fine chroma-frame tab↔recording alignment ---

#[derive(Deserialize)]
pub struct CoarseAnchor {
    #[serde(rename = "barIndex")]
    bar_index: usize,
    #[serde(rename = "millisecondOffset")]
    millisecond_offset: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefinedAnchor {
    bar_index: usize,
    millisecond_offset: f64,
    confidence: f64,
}

#[derive(Serialize)]
pub struct RefineResult {
    anchors: Vec<RefinedAnchor>,
    confidence: f64,
}

/// Piecewise-linear map (recording ms → expected tab frame) from the coarse
/// Phase-A anchors, used to band the fine DTW. Falls back to the diagonal.
fn coarse_tab_frame(knots: &[(f64, f64)], ms: f64, i: f64, n: f64, m: f64) -> f64 {
    if knots.is_empty() {
        return if n > 0.0 { i / n * m } else { 0.0 };
    }
    if ms <= knots[0].0 {
        return knots[0].1;
    }
    let last = knots[knots.len() - 1];
    if ms >= last.0 {
        return last.1;
    }
    for w in knots.windows(2) {
        let (m0, t0) = w[0];
        let (m1, t1) = w[1];
        if ms >= m0 && ms <= m1 {
            let frac = if m1 > m0 { (ms - m0) / (m1 - m0) } else { 0.0 };
            return t0 + frac * (t1 - t0);
        }
    }
    last.1
}

/// Refine the coarse (chord-DTW) sync anchors to ~50–100 ms by aligning the
/// recording's CENS chroma frames against the tab's synthesized CENS frames with
/// a banded DTW centred on the coarse path. Returns per-bar refined anchors +
/// per-anchor and global confidence; the JS side gates these against Phase A.
#[tauri::command]
pub async fn refine_sync(
    wav_path: String,
    tab_frames: Vec<[f32; 12]>,
    bar_start_tab_frame: Vec<usize>,
    coarse_anchors: Vec<CoarseAnchor>,
) -> Result<RefineResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if tab_frames.is_empty() || bar_start_tab_frame.is_empty() {
            return Err("empty tab frames".to_string());
        }
        // Recording CENS (reuse the shared analysis decode + default CQT).
        let signal = audio::decode_analysis(Path::new(&wav_path))?;
        let cfg = dsp::CqtConfig::default();
        let cqt = dsp::Cqt::new(cfg);
        let spec = cqt.process(&signal);
        let hop = cqt.hop_seconds();
        let params = dsp::cens::CensParams::default();
        let audio_cens = dsp::cens::cens(&dsp::chroma_raw(&spec, cfg.bins_per_octave), &params);
        // Tab CENS — IDENTICAL pipeline (the whole point of CENS).
        let tab_cens = dsp::cens::cens(&tab_frames, &params);
        if audio_cens.is_empty() || tab_cens.is_empty() {
            return Err("empty chroma".to_string());
        }
        let n = audio_cens.len();
        let m = tab_cens.len();

        // Band centre from the coarse anchors (ms → tab frame).
        let mut knots: Vec<(f64, f64)> = coarse_anchors
            .iter()
            .filter_map(|a| {
                bar_start_tab_frame
                    .get(a.bar_index)
                    .map(|&tf| (a.millisecond_offset, tf as f64))
            })
            .collect();
        knots.sort_by(|x, y| x.0.partial_cmp(&y.0).unwrap_or(std::cmp::Ordering::Equal));
        let center: Vec<usize> = (0..n)
            .map(|i| {
                let ms = i as f64 * hop * 1000.0;
                let tf = coarse_tab_frame(&knots, ms, i as f64, n as f64, m as f64);
                (tf.round() as i64).clamp(0, m as i64 - 1) as usize
            })
            .collect();

        // Radius ≈ ±2 bars, clamped.
        let mean_bar_frames = if bar_start_tab_frame.len() > 1 {
            bar_start_tab_frame[bar_start_tab_frame.len() - 1] as f64
                / (bar_start_tab_frame.len() - 1) as f64
        } else {
            20.0
        };
        let radius = ((2.0 * mean_bar_frames).round() as usize).clamp(20, 80);

        let (path, costs) = dsp::cens::banded_fine_dtw(&audio_cens, &tab_cens, &center, radius);
        let raw = dsp::cens::path_to_bar_anchors(&path, &costs, &bar_start_tab_frame, hop);
        let global = if costs.is_empty() {
            0.0
        } else {
            (1.0 - (costs.iter().sum::<f32>() / costs.len() as f32) as f64).clamp(0.0, 1.0)
        };
        let anchors = raw
            .into_iter()
            .map(|(b, ms, conf)| RefinedAnchor {
                bar_index: b,
                millisecond_offset: ms,
                confidence: conf,
            })
            .collect();
        Ok(RefineResult {
            anchors,
            confidence: global,
        })
    })
    .await
    .map_err(|e| format!("refine task failed: {e}"))?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BeatEstimate {
    bpm: f32,
    start_sec: f64,
    /// Strong onset times (s) for magnetic snapping of the manual start marker.
    onsets: Vec<f64>,
}

/// Estimate the recording's tempo + first strong onset (the "auto-guess" brain):
/// CQT → spectral-flux onset envelope → autocorrelation tempo + first onset.
/// Audio-only (no tab needed), so it works even when the fetched tab mismatches.
#[tauri::command]
pub async fn detect_beat(wav_path: String) -> Result<BeatEstimate, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let signal = audio::decode_analysis(Path::new(&wav_path))?;
        let cqt = dsp::Cqt::new(dsp::CqtConfig::default());
        let spec = cqt.process(&signal);
        let hop = cqt.hop_seconds();
        let env = dsp::tempo::onset_envelope(&spec);
        Ok(BeatEstimate {
            // Tempo from the BASS band (locks to the beat, not the 8th-note);
            // start + onset peaks from the full band (catch every transient).
            bpm: dsp::tempo::estimate_tempo(&dsp::tempo::bass_onset_envelope(&spec), hop),
            start_sec: dsp::tempo::first_onset(&env, hop),
            onsets: dsp::tempo::onset_peaks(&env, hop),
        })
    })
    .await
    .map_err(|e| format!("detect task failed: {e}"))?
}

/// Beat positions (seconds) tracked from the recording at a target tempo. Drives
/// the metronome so its clicks ride the song's REAL beats (and any tempo drift)
/// instead of a rigid grid. `bpm` only sets the octave — onset-following fixes the
/// exact value. Full-band onset envelope (every transient), DP beat tracker.
#[tauri::command]
pub async fn track_beats(wav_path: String, bpm: f32) -> Result<Vec<f64>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let signal = audio::decode_analysis(Path::new(&wav_path))?;
        // Fine (~11.6 ms hop) onset envelope — the CQT's ~23 ms hop quantizes beats.
        let (env, hop) = dsp::tempo::fine_onset_envelope(&signal, audio::ANALYSIS_SAMPLE_RATE);
        Ok(dsp::tempo::track_beats(&env, hop, bpm))
    })
    .await
    .map_err(|e| format!("beat-track task failed: {e}"))?
}

/// Holds the in-flight system-audio capture between the start/stop commands.
#[derive(Default)]
pub struct CaptureState(pub Mutex<Option<CaptureSession>>);

// --- Live chord detection (continuous capture → current chord events) ---

/// The current chord, pushed to the UI as a `live-chord` event.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LiveChord {
    pub idx: usize,
    pub label: String,
    pub root_pc: i32,
    pub quality: String,
}

/// Estimate the dominant chord of a captured window (no Viterbi — a fast,
/// frame-averaged argmax for low-latency live display).
fn detect_chord(window: &[f32], src_sr: u32, cqt: &dsp::Cqt, model: &Path) -> Option<usize> {
    let sig = audio::resample_mono(window, src_sr, audio::ANALYSIS_SAMPLE_RATE).ok()?;
    if sig.len() < 2048 {
        return None;
    }
    let spec = cqt.process(&sig);
    if spec.frames == 0 {
        return None;
    }
    let (emissions, _engine) = ml::emissions(&spec, model).ok()?;
    let mut acc = [0f32; chords::NUM_CHORDS];
    for frame in &emissions {
        for (i, v) in frame.iter().enumerate() {
            acc[i] += v;
        }
    }
    let mut best = 0usize;
    let mut best_val = f32::MIN;
    for (i, &v) in acc.iter().enumerate() {
        if v > best_val {
            best_val = v;
            best = i;
        }
    }
    Some(best)
}

/// A running live session: the capture + its detector worker.
pub struct LiveHandle {
    capture: Option<LiveCapture>,
    stop: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}

impl Drop for LiveHandle {
    /// Guarantee the worker thread + SCStream are torn down whenever the handle
    /// is dropped — not only via the explicit `stop_live` command (e.g. app
    /// teardown, or the managed slot being replaced).
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(w) = self.worker.take() {
            let _ = w.join();
        }
        if let Some(c) = self.capture.take() {
            c.stop();
        }
    }
}

#[derive(Default)]
pub struct LiveState(pub Mutex<Option<LiveHandle>>);

/// Start continuous capture + live chord detection. Emits `live-chord` events
/// as the playing audio's chord changes. Triggers the Screen Recording prompt.
#[tauri::command]
pub fn start_live(app: tauri::AppHandle, state: tauri::State<'_, LiveState>) -> Result<(), String> {
    let mut slot = state.0.lock().map_err(|_| "live state poisoned")?;
    if slot.is_some() {
        return Ok(()); // already live
    }
    let capture = LiveCapture::start()?;
    let reader = capture.reader();
    let stop = Arc::new(AtomicBool::new(false));
    let stop_w = stop.clone();
    let model = btc_model_path(&app);
    let app_w = app.clone();
    let sr = capture::capture_sample_rate();

    let worker = thread::spawn(move || {
        let cqt = dsp::Cqt::new(dsp::CqtConfig::default());
        let mut last = usize::MAX;
        while !stop_w.load(Ordering::Relaxed) {
            thread::sleep(Duration::from_millis(350));
            if stop_w.load(Ordering::Relaxed) {
                break;
            }
            let window = reader.snapshot(3.0);
            if window.len() < sr as usize {
                continue; // need ≥ 1 s of audio for a stable estimate
            }
            if let Some(idx) = detect_chord(&window, sr, &cqt, &model) {
                if idx != last {
                    last = idx;
                    let _ = app_w.emit(
                        "live-chord",
                        LiveChord {
                            idx,
                            label: chords::chord_label(idx),
                            root_pc: chords::chord_root_pc(idx),
                            quality: chords::chord_quality(idx).to_string(),
                        },
                    );
                }
            }
        }
    });

    *slot = Some(LiveHandle {
        capture: Some(capture),
        stop,
        worker: Some(worker),
    });
    Ok(())
}

/// Stop live detection and tear down the capture. Dropping the taken handle runs
/// `LiveHandle::drop`, which signals + joins the worker and stops the capture.
#[tauri::command]
pub fn stop_live(state: tauri::State<'_, LiveState>) -> Result<(), String> {
    let _ = state.0.lock().map_err(|_| "live state poisoned")?.take();
    Ok(())
}

/// Start capturing system audio (e.g. the playing YouTube video). Triggers the
/// macOS Screen Recording permission prompt on first use. The capture runs
/// entirely on-device — nothing is downloaded.
#[tauri::command]
pub fn start_system_capture(
    app: tauri::AppHandle,
    state: tauri::State<'_, CaptureState>,
) -> Result<(), String> {
    let mut slot = state.0.lock().map_err(|_| "capture state poisoned")?;
    if slot.is_some() {
        return Err("a capture is already running".into());
    }
    // Hygiene: remove any leftover capture WAVs from prior runs that failed
    // before the post-analysis delete could fire.
    if let Ok(dir) = app.path().app_cache_dir() {
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for e in entries.flatten() {
                let p = e.path();
                if p.file_name()
                    .and_then(|n| n.to_str())
                    .map(|n| n.starts_with("capture-") && n.ends_with(".wav"))
                    .unwrap_or(false)
                {
                    let _ = std::fs::remove_file(p);
                }
            }
        }
    }
    *slot = Some(capture::start()?);
    Ok(())
}

/// Stop capturing, write the captured audio to a WAV in the app cache dir, and
/// return its path. The frontend then feeds it to `analyze_chords` like any
/// other local file.
#[tauri::command]
pub fn stop_system_capture(
    app: tauri::AppHandle,
    state: tauri::State<'_, CaptureState>,
) -> Result<String, String> {
    let session = state
        .0
        .lock()
        .map_err(|_| "capture state poisoned")?
        .take()
        .ok_or("no capture is running")?;

    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let out = dir.join(format!("capture-{ts}.wav"));

    let result = session.stop_and_write(out)?;
    Ok(result.wav_path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures")
            .join(name)
    }

    // Manual probe (NOT a CI test): print the production bass-weighted tempo for the
    // owner's downloaded song wavs to eyeball the felt octave (Careless Whisper ≈ 76,
    // Common People ≈ 138, Africa ≈ 93). Run with:
    //   cargo test --features btc tempo_probe -- --ignored --nocapture
    // Inspect basic-pitch nmp.onnx I/O (download to /tmp/nmp.onnx first):
    //   cargo test --features btc inspect_basic_pitch -- --ignored --nocapture
    #[test]
    #[ignore]
    fn inspect_basic_pitch_model() {
        let s = ort::session::Session::builder()
            .unwrap()
            .commit_from_file("/tmp/nmp.onnx")
            .unwrap();
        for i in &s.inputs {
            println!("BP_INPUT  {i:?}");
        }
        for o in &s.outputs {
            println!("BP_OUTPUT {o:?}");
        }
    }

    // Transcribe a real song's bass with basic-pitch (needs /tmp/nmp.onnx):
    //   cargo test --features btc basic_pitch_probe -- --ignored --nocapture
    #[test]
    #[ignore]
    fn basic_pitch_probe() {
        let wav = PathBuf::from(std::env::var("HOME").unwrap())
            .join("Library/Caches/com.chordmatik.app/ytdl-2lvs2FzF64o.wav"); // Toto - Africa
        if !wav.exists() {
            println!("BP_PROBE no wav at {wav:?}");
            return;
        }
        let decoded = audio::decode_file(&wav).unwrap();
        let audio22 = audio::resample_mono(&decoded.samples_mono, decoded.sample_rate, 22050).unwrap();
        let t0 = Instant::now();
        let notes = ml::basicpitch::transcribe(&audio22, Path::new("/tmp/nmp.onnx")).unwrap();
        let bass: Vec<_> = notes.iter().filter(|n| n.midi >= 28 && n.midi <= 55).collect();
        println!(
            "BP_PROBE {:.1}s  total={}  bass(28-55)={}",
            t0.elapsed().as_secs_f32(),
            notes.len(),
            bass.len()
        );
        let names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
        for n in bass.iter().take(16) {
            let pc = (((n.midi % 12) + 12) % 12) as usize;
            println!(
                "  t={:.2}s dur={:.2}s {}{} (midi {})",
                n.start_sec,
                n.dur_sec,
                names[pc],
                n.midi / 12 - 1,
                n.midi
            );
        }
        assert!(bass.len() > 5, "expected a bass line");
    }

    // Verify Demucs bass isolation on a real song (needs /tmp/htdemucs_ft_bass.onnx
    // + /tmp/nmp.onnx). Compares basic-pitch on the raw mix vs the isolated bass —
    // the isolated stem should keep the bass register and drop high-register notes.
    //   cargo test --features btc demucs_probe -- --ignored --nocapture
    #[test]
    #[ignore]
    fn demucs_probe() {
        let wav = PathBuf::from(std::env::var("HOME").unwrap())
            .join("Library/Caches/com.chordmatik.app/ytdl-2lvs2FzF64o.wav"); // Toto - Africa
        let dm = Path::new("/tmp/htdemucs_ft_bass.onnx");
        if !wav.exists() || !dm.exists() {
            println!("DEMUCS_PROBE missing wav or model");
            return;
        }
        let st = audio::decode_file_stereo(&wav).unwrap();
        // First ~24 s keeps the probe to a handful of chunks.
        let win = (st.sample_rate as usize * 24).min(st.left.len());
        let l44 = audio::resample_mono(&st.left[..win], st.sample_rate, 44_100).unwrap();
        let r44 = audio::resample_mono(&st.right[..win], st.sample_rate, 44_100).unwrap();

        let rms = |x: &[f32]| (x.iter().map(|v| v * v).sum::<f32>() / x.len().max(1) as f32).sqrt();
        let mix_rms = rms(&l44);

        let t0 = Instant::now();
        let bass44 = ml::demucs::separate_bass_mono(&l44, &r44, dm).unwrap();
        println!(
            "DEMUCS_PROBE sep {:.1}s  len={} (in {})  mixRMS={:.4} bassRMS={:.4}",
            t0.elapsed().as_secs_f32(),
            bass44.len(),
            l44.len(),
            mix_rms,
            rms(&bass44)
        );
        assert_eq!(bass44.len(), l44.len(), "bass length must match input");
        assert!(rms(&bass44) > 1e-5, "isolated bass should have energy");

        // basic-pitch on the isolated bass vs the raw mix (same window).
        let count = |sig: &[f32]| -> (usize, usize, usize) {
            let notes = ml::basicpitch::transcribe(sig, Path::new("/tmp/nmp.onnx")).unwrap();
            let total = notes.len();
            let low = notes.iter().filter(|n| n.midi >= 28 && n.midi <= 55).count();
            let high = notes.iter().filter(|n| n.midi > 55).count();
            (total, low, high)
        };
        let bass22 = audio::resample_mono(&bass44, 44_100, 22_050).unwrap();
        let mix_mono: Vec<f32> = l44.iter().zip(&r44).map(|(a, b)| 0.5 * (a + b)).collect();
        let mix22 = audio::resample_mono(&mix_mono, 44_100, 22_050).unwrap();
        let (bt, bl, bh) = count(&bass22);
        let (mt, ml_, mh) = count(&mix22);
        println!("  isolated bass: total={bt} low(28-55)={bl} high(>55)={bh}");
        println!("  raw mix:       total={mt} low(28-55)={ml_} high(>55)={mh}");
        assert!(bl > 3, "isolated bass should yield a bass line");
    }

    #[test]
    fn composes_artist_from_metadata() {
        // The Candlemass case: bare title, artist in metadata.
        assert_eq!(
            compose_video_title("Solitude", "Candlemass, Leif Edling", "CANDLEMASS OFFICIAL"),
            "Candlemass - Solitude"
        );
        // No %(artist)s → cleaned channel name.
        assert_eq!(
            compose_video_title("Solitude", "NA", "CANDLEMASS OFFICIAL"),
            "CANDLEMASS - Solitude"
        );
        // Topic channels.
        assert_eq!(
            compose_video_title("Sliver", "NA", "Nirvana - Topic"),
            "Nirvana - Sliver"
        );
        // Title already has an artist → untouched.
        assert_eq!(
            compose_video_title("Toto - Africa (Official HD Video)", "Toto", "TotoVEVO"),
            "Toto - Africa (Official HD Video)"
        );
        // Title already contains the artist name (no separator) → untouched.
        assert_eq!(
            compose_video_title("Candlemass Solitude full", "Candlemass", "x"),
            "Candlemass Solitude full"
        );
        // Nothing usable → untouched.
        assert_eq!(compose_video_title("Some Song", "NA", ""), "Some Song");
    }

    // Offline: content validators over every REAL cached Songsterr track. The
    // mislabeled junk ("Electric Bass" with a 6-string guitar tuning at 13%
    // density — the Careless Whisper bug) must fail; every genuine bass passes.
    //   cargo test track_validators_on_cache -- --ignored --nocapture
    #[test]
    #[ignore]
    fn track_validators_on_cache() {
        let dir = PathBuf::from(std::env::var("HOME").unwrap())
            .join("Library/Caches/com.chordmatik.app/tabs");
        let mut checked = 0;
        for e in std::fs::read_dir(&dir).unwrap().flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if !name.starts_with("tab-") || !name.ends_with(".json") {
                continue;
            }
            let Ok(s) = std::fs::read_to_string(e.path()) else { continue };
            let Ok(j) = serde_json::from_str::<serde_json::Value>(&s) else { continue };
            let (min_t, n, d) = track_stats(&j);
            let label = j.get("instrument").and_then(|v| v.as_str()).unwrap_or("?");
            let bass_labeled = j
                .get("instrumentId")
                .and_then(|v| v.as_i64())
                .is_some_and(|id| (32..=39).contains(&id));
            // Ground truth from CONTENT: 4-5 strings in bass register + played.
            let truly_bass = (4..=5).contains(&n) && min_t > 0 && min_t <= 33 && d >= 0.25;
            assert_eq!(
                is_real_bass(&j),
                truly_bass,
                "{name} {label} min={min_t} n={n} d={d:.2}"
            );
            if bass_labeled && !truly_bass {
                println!("CAUGHT mislabeled bass: {name} {label} min={min_t} n={n} d={d:.2}");
            }
            checked += 1;
        }
        println!("validated {checked} cached tracks");
        assert!(checked > 20, "expected a populated cache");
    }

    // Live: the song that showed a rest-sheet as \"bass\" (George Michael) must now
    // return either a REAL bass or none — never the junk track.
    //   cargo test --features btc bass_pick_probe -- --ignored --nocapture
    #[test]
    #[ignore]
    fn bass_pick_probe() {
        tauri::async_runtime::block_on(async {
            let client = reqwest::Client::builder()
                .user_agent(SONGSTERR_UA)
                .gzip(true)
                .timeout(Duration::from_secs(20))
                .build()
                .unwrap();
            let dir = std::env::temp_dir().join("bass_pick_probe");
            for (query, want_bass) in [
                ("George Michael - Careless Whisper", false), // junk-labeled: real bass or None
                ("Toto - Africa", true),                      // regression: must keep its bass
                ("Toto - Hold The Line", true),
            ] {
                let hits: Vec<SongHit> = client
                    .get("https://www.songsterr.com/api/songs")
                    .query(&[("pattern", query), ("size", "16")])
                    .send()
                    .await
                    .unwrap()
                    .json()
                    .await
                    .unwrap();
                let (qt, at, sv) = parse_query(query);
                let h = hits
                    .iter()
                    .max_by(|a, b| {
                        hit_score(&qt, &at, &sv, a)
                            .partial_cmp(&hit_score(&qt, &at, &sv, b))
                            .unwrap()
                    })
                    .expect("a hit");
                let t = fetch_song_tracks(
                    &client,
                    &dir,
                    h.song_id,
                    h.pop_guitar,
                    h.pop_bass,
                    h.drum_part(),
                    h.piano_part(),
                    &h.instrument_candidates(24..=31),
                    &h.instrument_candidates(32..=39),
                )
                .await;
                match &t.bass {
                    Some(b) => {
                        let (min_t, n, d) = track_stats(b);
                        println!(
                            "PICK {query}: songId={} bass {} min={min_t} n={n} d={d:.2}",
                            h.song_id,
                            b.get("instrument").and_then(|v| v.as_str()).unwrap_or("?")
                        );
                        assert!(is_real_bass(b), "picked bass must be REAL");
                    }
                    None => {
                        println!("PICK {query}: songId={} bass=None (no real bass found)", h.song_id);
                        assert!(!want_bass, "{query} should have a real bass");
                    }
                }
            }
        });
    }

    // Verify the Ultimate Guitar bass-tab lookup against the real mobile API:
    //   cargo test ug_bass_probe -- --ignored --nocapture
    #[test]
    #[ignore]
    fn ug_bass_probe() {
        let dir = std::env::temp_dir().join("ugbass_probe");
        let _ = std::fs::remove_dir_all(&dir);
        for title in [
            "Red Hot Chili Peppers - Californication (Official Music Video)",
            "Nirvana - Sliver",
        ] {
            match tauri::async_runtime::block_on(ug::best_bass_tab(&dir, title, true)) {
                Some(b) => {
                    println!(
                        "UG_PROBE \"{title}\" -> {} — {} | ★{:.2} ({} votes) id={} | {} versions",
                        b.artist,
                        b.song,
                        b.rating,
                        b.votes,
                        b.id,
                        b.versions.len()
                    );
                    println!(
                        "  content[..200]: {}",
                        b.content.chars().take(200).collect::<String>().replace('\n', " / ")
                    );
                    assert!(!b.content.is_empty(), "expected tab content");
                    assert!(b.content.contains('|'), "expected tab bar lines");
                }
                None => panic!("UG_PROBE got None for \"{title}\""),
            }
        }
    }

    // Verify the DP beat tracker on a real song through the actual CQT pipeline:
    //   cargo test --features btc beat_track_probe -- --ignored --nocapture
    #[test]
    #[ignore]
    fn beat_track_probe() {
        let wav = PathBuf::from(std::env::var("HOME").unwrap())
            .join("Library/Caches/com.chordmatik.app/ytdl-QECJ9pCyhns.wav"); // Nirvana - Sliver
        if !wav.exists() {
            println!("BEAT_PROBE no wav");
            return;
        }
        let decoded = audio::decode_file(&wav).unwrap();
        let signal = audio::resample_mono(
            &decoded.samples_mono,
            decoded.sample_rate,
            audio::ANALYSIS_SAMPLE_RATE,
        )
        .unwrap();
        let (env, hop) = dsp::tempo::fine_onset_envelope(&signal, audio::ANALYSIS_SAMPLE_RATE);
        for target in [135.0f32, 138.0] {
            let beats = dsp::tempo::track_beats(&env, hop, target);
            let mut ibis: Vec<f64> = beats.windows(2).map(|w| w[1] - w[0]).collect();
            ibis.sort_by(|a, b| a.partial_cmp(b).unwrap());
            let med = ibis[ibis.len() / 2];
            println!(
                "BEAT_PROBE target={target} -> {} beats, median IBI={:.0}ms => {:.1} BPM",
                beats.len(),
                med * 1000.0,
                60.0 / med
            );
            assert!(beats.len() > 50, "expected a beat track");
            assert!((60.0 / med - 138.0).abs() < 8.0, "median tempo should be ~138");
        }
    }

    #[test]
    #[ignore]
    fn tempo_probe_real_wavs() {
        let cache = PathBuf::from(std::env::var("HOME").unwrap())
            .join("Library/Caches/com.chordmatik.app");
        let mut found = false;
        for entry in std::fs::read_dir(&cache).into_iter().flatten().flatten() {
            let p = entry.path();
            let name = p.file_name().and_then(|s| s.to_str()).unwrap_or("").to_string();
            if !name.starts_with("ytdl-") || p.extension().and_then(|e| e.to_str()) != Some("wav") {
                continue;
            }
            found = true;
            let decoded = audio::decode_file(&p).unwrap();
            let signal = audio::resample_mono(
                &decoded.samples_mono,
                decoded.sample_rate,
                audio::ANALYSIS_SAMPLE_RATE,
            )
            .unwrap();
            let cqt = dsp::Cqt::new(dsp::CqtConfig::default());
            let spec = cqt.process(&signal);
            let bpm =
                dsp::tempo::estimate_tempo(&dsp::tempo::bass_onset_envelope(&spec), cqt.hop_seconds());
            println!("TEMPO_PROBE {name}: {bpm:.0} BPM (bass)");
        }
        assert!(found, "no ytdl wavs found in {cache:?}");
    }

    #[test]
    fn lyrics_gate_rejects_unrelated_and_accepts_real() {
        let entry = |artist: &str, track: &str| LrcEntry {
            track_name: Some(track.to_string()),
            artist_name: Some(artist.to_string()),
            synced_lyrics: Some("[00:01.00] x".to_string()),
            plain_lyrics: None,
            instrumental: false,
        };
        // The bug: a totally unrelated fuzzy hit must be REJECTED.
        assert!(!lyrics_relevant("Bum Bum Bum (1).mp3", "", &entry("Suzanne Vega", "Luka")));
        // Real matches accepted (with and without a parsed artist).
        assert!(lyrics_relevant(
            "Toto - Africa (Official HD Video)",
            "Toto",
            &entry("Toto", "Africa")
        ));
        assert!(lyrics_relevant(
            "Careless Whisper",
            "",
            &entry("George Michael", "Careless Whisper")
        ));
        // Same track name but the title named a different artist → rejected.
        assert!(!lyrics_relevant("Adele - Hello", "Adele", &entry("Lionel Richie", "Hello")));
    }

    #[test]
    fn analyzes_real_audio_to_a_plausible_chord() {
        let no_model = PathBuf::from("/nonexistent/btc.onnx");
        let res = analyze_core(fixture("tone.wav").to_str().unwrap(), &no_model, 1600)
            .expect("analysis should succeed");

        assert_eq!(res.analysis.engine, "chroma");
        assert!(!res.analysis.segments.is_empty());

        let longest = res
            .analysis
            .segments
            .iter()
            .max_by(|a, b| {
                (a.end_sec - a.start_sec)
                    .partial_cmp(&(b.end_sec - b.start_sec))
                    .unwrap()
            })
            .unwrap();
        let a_major = longest.root_pc == 9 && longest.quality == "maj";
        let fsharp_minor = longest.root_pc == 6 && longest.quality == "min";
        assert!(
            a_major || fsharp_minor,
            "expected A major or F# minor, got {} (pc {}, {})",
            longest.label,
            longest.root_pc,
            longest.quality
        );
    }

    /// End-to-end check that the BTC ONNX engine loads + runs via `ort` and is
    /// the engine actually used (not exact chords — BTC is for real recordings,
    /// the fixtures are synthetic, so we only assert it ran and produced output).
    #[cfg(feature = "btc")]
    #[test]
    fn btc_engine_runs_end_to_end() {
        let model = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/models/btc.onnx");
        assert!(
            model.exists(),
            "btc.onnx missing at {model:?} — run tools/export_btc_onnx.py first"
        );
        let res = analyze_core(fixture("tone.wav").to_str().unwrap(), &model, 1600)
            .expect("BTC analysis should succeed");
        // A neural engine ran via ort (chordnet supersedes btc when its model is
        // bundled alongside; either confirms the ONNX→ort pipeline works).
        assert!(
            res.analysis.engine == "btc" || res.analysis.engine == "chordnet",
            "expected a neural engine (btc/chordnet), got {}",
            res.analysis.engine
        );
        assert!(!res.analysis.segments.is_empty(), "BTC produced no segments");
        let labels: Vec<String> = res
            .analysis
            .segments
            .iter()
            .map(|s| format!("{:.1}-{:.1}:{}", s.start_sec, s.end_sec, s.label))
            .collect();
        eprintln!(
            "BTC tone.wav → {} segments: {labels:?}",
            res.analysis.segments.len()
        );
    }

    /// Opt-in BTC dump on a real file:
    /// `CHORDMATIK_BTC_FILE=/path cargo test --features btc btc_dump_real -- --nocapture`
    #[cfg(feature = "btc")]
    #[test]
    fn btc_dump_real() {
        let Ok(file) = std::env::var("CHORDMATIK_BTC_FILE") else {
            return;
        };
        let model = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/models/btc.onnx");
        let res = analyze_core(&file, &model, 1600).expect("btc analysis");
        eprintln!("BTC engine={} segments={}", res.analysis.engine, res.analysis.segments.len());
        for s in &res.analysis.segments {
            eprintln!("  {:.1}-{:.1}  {}", s.start_sec, s.end_sec, s.label);
        }
    }

    /// Opt-in live Songsterr fetch check:
    /// `CHORDMATIK_TEST_TABS=1 cargo test fetch_tabs_live -- --nocapture`
    #[test]
    fn fetch_tabs_live() {
        if std::env::var("CHORDMATIK_TEST_TABS").is_err() {
            return;
        }
        let (g_ok, b_ok, measures) = tauri::async_runtime::block_on(async {
            let client = reqwest::Client::builder()
                .user_agent(SONGSTERR_UA)
                .gzip(true)
                .timeout(Duration::from_secs(20))
                .build()
                .unwrap();
            let hits: Vec<SongHit> = client
                .get("https://www.songsterr.com/api/songs")
                .query(&[("pattern", "nirvana smells like teen spirit"), ("size", "5")])
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            assert!(!hits.is_empty(), "search returned no hits");
            let h = &hits[0];
            eprintln!(
                "hit: {} - {} (id {}) g={:?} b={:?}",
                h.artist.clone().unwrap_or_default(),
                h.title.clone().unwrap_or_default(),
                h.song_id,
                h.pop_guitar,
                h.pop_bass
            );
            let meta: TabMeta = client
                .get(format!("https://www.songsterr.com/api/meta/{}", h.song_id))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            let tmp = std::env::temp_dir().join("cmk-tabtest");
            let g = fetch_track_json(&client, &tmp, h.song_id, meta.revision_id, &meta.image, meta.pop_guitar.unwrap()).await;
            let b = fetch_track_json(&client, &tmp, h.song_id, meta.revision_id, &meta.image, meta.pop_bass.unwrap()).await;
            let m = g
                .as_ref()
                .and_then(|v| v.get("measures"))
                .and_then(|m| m.as_array())
                .map(|a| a.len());
            (g.is_some(), b.is_some(), m)
        });
        eprintln!("guitar_ok={g_ok} bass_ok={b_ok} guitar_measures={measures:?}");
        assert!(g_ok && b_ok, "expected both guitar and bass tabs");
    }

    /// Opt-in perf check: `CHORDMATIK_BENCH_FILE=/path cargo test --release bench -- --nocapture`
    #[test]
    fn bench_optional() {
        let Ok(file) = std::env::var("CHORDMATIK_BENCH_FILE") else {
            return;
        };
        let t0 = std::time::Instant::now();
        let res = analyze_core(&file, &PathBuf::from("/no"), 1600).expect("analysis");
        eprintln!(
            "BENCH: {} → {:.1}s audio, {} segments, engine={}, analyzed in {:?}",
            file,
            res.analysis.duration_sec,
            res.analysis.segments.len(),
            res.analysis.engine,
            t0.elapsed()
        );
    }

    #[test]
    fn detects_chord_progression_roots() {
        let no_model = PathBuf::from("/nonexistent/btc.onnx");
        let res = analyze_core(fixture("progression.wav").to_str().unwrap(), &no_model, 1600)
            .expect("analysis");
        let segs = &res.analysis.segments;
        let all: Vec<String> = segs
            .iter()
            .map(|s| format!("{:.1}-{:.1}:{}", s.start_sec, s.end_sec, s.label))
            .collect();

        let expected = [(1.0, 0i32, "C"), (3.0, 7, "G"), (5.0, 9, "Am"), (7.0, 5, "F")];
        for (t, root_pc, name) in expected {
            let seg = segs
                .iter()
                .find(|s| s.start_sec <= t && t < s.end_sec)
                .unwrap_or_else(|| panic!("no segment at {t}s; segments={all:?}"));
            assert_eq!(
                seg.root_pc, root_pc,
                "at {t}s expected {name} (root {root_pc}), got {} (root {}); segments={all:?}",
                seg.label, seg.root_pc
            );
        }
    }
}
