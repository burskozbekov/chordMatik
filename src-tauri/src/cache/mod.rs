//! On-disk analysis cache, keyed by a fast content hash of the audio file.
//! Re-opening a previously analyzed song is then instant (no decode/CQT/infer).
//! Also backs the local library list.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::chords::ChordSegment;

/// Bump whenever the chord engine, models, CQT, or decode change shape — older
/// cache entries (different version, or pre-versioning = 0) are then treated as a
/// miss and re-analyzed, so a model/feature upgrade never serves stale chords.
pub const ENGINE_CACHE_VERSION: u32 = 3; // v3: segment boundaries snapped to tracked beats

/// Everything needed to restore a song view without touching the audio file.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CacheEntry {
    pub path: String,
    pub name: String,
    pub duration_sec: f64,
    pub sample_rate: u32,
    pub channels: u16,
    pub peaks: Vec<f32>,
    pub engine: String,
    pub frame_hop_sec: f64,
    pub segments: Vec<ChordSegment>,
    pub saved_at: u64,
    /// Engine/model version this entry was computed with (see ENGINE_CACHE_VERSION).
    #[serde(default)]
    pub cache_version: u32,
    /// Downloaded/captured temp song — cached for instant re-open but kept OUT of
    /// the persistent library list (privacy).
    #[serde(default)]
    pub ephemeral: bool,
    /// Measured felt-tactus tempo (BPM) from the recording, 0 if unknown.
    #[serde(default)]
    pub bpm: f32,
}

/// A library row (lightweight metadata, no peaks/segments).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryItem {
    pub hash: String,
    pub path: String,
    pub name: String,
    pub duration_sec: f64,
    pub engine: String,
    pub chord_count: usize,
    pub saved_at: u64,
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Fast, dependency-free FNV-1a hash over the file length + head/tail chunks.
/// Plenty to key a local cache; not cryptographic.
pub fn hash_file(path: &Path) -> Result<String, String> {
    const CHUNK: usize = 128 * 1024;
    let mut f = File::open(path).map_err(|e| format!("cannot open file: {e}"))?;
    let len = f.metadata().map_err(|e| format!("stat failed: {e}"))?.len();

    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    const PRIME: u64 = 0x0100_0000_01b3;
    let mix = |bytes: &[u8], h: &mut u64| {
        for &b in bytes {
            *h ^= b as u64;
            *h = h.wrapping_mul(PRIME);
        }
    };

    mix(&len.to_le_bytes(), &mut h);
    let mut buf = vec![0u8; CHUNK];

    if len <= (4 * CHUNK) as u64 {
        // Small files: hash the whole thing (head+tail alone collide for two files
        // that differ only in the middle, or any file < CHUNK had its tail unhashed).
        loop {
            let n = f.read(&mut buf).map_err(|e| format!("read failed: {e}"))?;
            if n == 0 {
                break;
            }
            mix(&buf[..n], &mut h);
        }
    } else {
        // Large files: head + middle + tail chunks (distinct audio differs in ≥1).
        let n = f.read(&mut buf).map_err(|e| format!("read failed: {e}"))?;
        mix(&buf[..n], &mut h);
        f.seek(SeekFrom::Start(len / 2 - (CHUNK / 2) as u64))
            .map_err(|e| format!("seek failed: {e}"))?;
        let n = f.read(&mut buf).map_err(|e| format!("read failed: {e}"))?;
        mix(&buf[..n], &mut h);
        f.seek(SeekFrom::End(-(CHUNK as i64)))
            .map_err(|e| format!("seek failed: {e}"))?;
        let n = f.read(&mut buf).map_err(|e| format!("read failed: {e}"))?;
        mix(&buf[..n], &mut h);
    }

    Ok(format!("{h:016x}"))
}

fn cache_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("no cache dir: {e}"))?
        .join("analyses");
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir cache: {e}"))?;
    Ok(dir)
}

pub fn load(app: &tauri::AppHandle, hash: &str) -> Option<CacheEntry> {
    let path = cache_dir(app).ok()?.join(format!("{hash}.json"));
    let text = std::fs::read_to_string(path).ok()?;
    let entry: CacheEntry = serde_json::from_str(&text).ok()?;
    // Stale engine/model version → treat as a miss so it gets re-analyzed.
    if entry.cache_version != ENGINE_CACHE_VERSION {
        return None;
    }
    Some(entry)
}

pub fn store(app: &tauri::AppHandle, hash: &str, entry: &mut CacheEntry) -> Result<(), String> {
    entry.saved_at = now_secs();
    entry.cache_version = ENGINE_CACHE_VERSION;
    let path = cache_dir(app)?.join(format!("{hash}.json"));
    let text = serde_json::to_string(entry).map_err(|e| format!("serialize cache: {e}"))?;
    std::fs::write(path, text).map_err(|e| format!("write cache: {e}"))
}

/// All cached analyses as library rows, newest first.
pub fn list(app: &tauri::AppHandle) -> Vec<LibraryItem> {
    let dir = match cache_dir(app) {
        Ok(d) => d,
        Err(_) => return Vec::new(),
    };
    let mut items: Vec<LibraryItem> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for e in entries.flatten() {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) != Some("json") {
                continue;
            }
            let hash = p
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string();
            if let Some(entry) = std::fs::read_to_string(&p)
                .ok()
                .and_then(|t| serde_json::from_str::<CacheEntry>(&t).ok())
            {
                if entry.ephemeral {
                    continue; // downloaded/captured — cached, but not a library song
                }
                // A song whose file was moved/deleted can't be opened — listing it
                // only offers a click that ends in an error. Keep the cache entry
                // (the file may come back, e.g. an external drive) but hide the row.
                if !Path::new(&entry.path).exists() {
                    continue;
                }
                items.push(LibraryItem {
                    hash,
                    path: entry.path,
                    name: entry.name,
                    duration_sec: entry.duration_sec,
                    engine: entry.engine,
                    chord_count: entry.segments.len(),
                    saved_at: entry.saved_at,
                });
            }
        }
    }
    items.sort_by(|a, b| b.saved_at.cmp(&a.saved_at));
    items
}

pub fn remove(app: &tauri::AppHandle, hash: &str) -> Result<(), String> {
    let path = cache_dir(app)?.join(format!("{hash}.json"));
    if path.exists() {
        std::fs::remove_file(path).map_err(|e| format!("remove cache: {e}"))?;
    }
    Ok(())
}
