//! Ultimate Guitar bass-tab lookup via their MOBILE API (`api.ultimate-guitar.com`).
//! The website is Cloudflare-gated (scraping returns a "Just a moment" 403), but the
//! mobile API is not — it just needs a signed request:
//!   `X-UG-API-KEY = md5(clientId + UTC "yyyy-MM-dd:HH" + "createLog()")`.
//! Given a (messy YouTube) title, returns the highest-RATED community bass tab as
//! plain ASCII (UG `[tab]`/`[ch]` markup stripped), plus alternate versions.

use std::collections::HashSet;
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

const UG_UA: &str = "UGT_ANDROID/4.11.1 (SM-G930F; Android 8.0.0)";
/// A fixed device id — the API is read-only so it needn't be unique per install.
const UG_CLIENT_ID: &str = "b84de892-9178-4a3f-9c1f-2d7e6a0b1c33";
/// UG tab-type id for "Bass Tabs".
const BASS_TYPE: &str = "400";

/// YouTube-title noise dropped before searching / relevance scoring. Kept narrow
/// on purpose: words like "the"/"and"/"music" can be real artist/song words
/// (e.g. "The The", "A-ha"), so we only strip unambiguous upload cruft.
const NOISE: &[&str] = &[
    "official", "video", "audio", "lyric", "lyrics", "hd", "4k", "mv", "feat", "ft",
    "remaster", "remastered", "explicit", "visualizer", "vevo", "hq",
];

/// One alternate bass-tab version (metadata only) for the UI's version picker.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BassTabVersion {
    pub id: u64,
    pub artist: String,
    pub song: String,
    pub rating: f32,
    pub votes: u32,
}

/// The chosen bass tab (ASCII content) + alternates, returned to the UI.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BassTab {
    pub id: u64,
    pub artist: String,
    pub song: String,
    pub rating: f32,
    pub votes: u32,
    pub url: String,
    /// Plain-text bass tab (UG markup stripped).
    pub content: String,
    /// Ranked alternates (incl. the chosen one) so the user can switch versions.
    pub versions: Vec<BassTabVersion>,
}

/// Civil UTC date-hour as `yyyy-MM-dd:HH` (Howard Hinnant's algorithm — avoids a
/// chrono dependency). Must match `date -u +"%Y-%m-%d:%H"`.
fn utc_date_hour(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let hour = (secs % 86_400) / 3_600;
    let z = days + 719_468;
    let era = (if z >= 0 { z } else { z - 146_096 }) / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };
    format!("{year:04}-{m:02}-{d:02}:{hour:02}")
}

/// The per-request signature for a given hour-offset from now. UG's notary clock
/// runs AHEAD of real UTC (empirically ~+1h as of 2026-07) and rejects a key
/// signed for the "wrong" hour with HTTP 498 — so callers retry across offsets.
fn api_key_for(offset_hours: i64) -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let secs = (now + offset_hours * 3600).max(0) as u64;
    let payload = format!("{UG_CLIENT_ID}{}createLog()", utc_date_hour(secs));
    format!("{:x}", md5::compute(payload.as_bytes()))
}

/// Hour offsets to try, best-guess first (server runs ahead → +1 usually wins).
const KEY_OFFSETS: [i64; 3] = [1, 0, -1];

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(UG_UA)
        .gzip(true)
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())
}

/// Attach the auth headers (signature for `offset_hours`) to a request.
fn auth(rb: reqwest::RequestBuilder, offset_hours: i64) -> reqwest::RequestBuilder {
    rb.header("Accept", "application/json")
        .header("X-UG-CLIENT-ID", UG_CLIENT_ID)
        .header("X-UG-API-KEY", api_key_for(offset_hours))
}

/// GET a UG endpoint, retrying across hour-offsets when the notary clock rejects
/// the signature (HTTP 498). Returns the first 2xx JSON body, else None.
async fn ug_get(
    cl: &reqwest::Client,
    url: &str,
    query: &[(&str, &str)],
) -> Option<serde_json::Value> {
    for off in KEY_OFFSETS {
        let Ok(resp) = auth(cl.get(url).query(query), off).send().await else {
            return None;
        };
        let status = resp.status();
        if status.is_success() {
            return resp.json::<serde_json::Value>().await.ok();
        }
        if status.as_u16() != 498 {
            return None; // a real error (404/500/…), not clock-skew
        }
    }
    None
}

/// Tokenize a string: lowercase alphanumerics, drop 1-char + noise words.
fn tokset(s: &str) -> HashSet<String> {
    s.split(|c: char| !c.is_alphanumeric())
        .filter(|w| w.len() > 1)
        .map(|w| w.to_lowercase())
        .filter(|w| !NOISE.contains(&w.as_str()))
        .collect()
}

/// Reduce a messy YouTube title to a clean search string (drop bracketed groups,
/// separators, and noise words; keep artist + song words in order).
fn clean_query(title: &str) -> String {
    let mut flat = String::new();
    let mut depth = 0i32;
    for ch in title.chars() {
        match ch {
            '(' | '[' | '{' => depth += 1,
            ')' | ']' | '}' => depth = (depth - 1).max(0),
            _ if depth == 0 => flat.push(ch),
            _ => {}
        }
    }
    let flat = flat.replace(" - ", " ").replace('-', " ");
    flat.split(|c: char| !c.is_alphanumeric())
        .filter(|w| w.len() > 1)
        .map(|w| w.to_lowercase())
        .filter(|w| !NOISE.contains(&w.as_str()))
        .collect::<Vec<_>>()
        .join(" ")
}

/// Bayesian-weighted rating so a 5.0/1-vote tab can't beat a 4.8/400-vote one.
fn bayes(rating: f32, votes: u32) -> f32 {
    const M: f32 = 8.0;
    const PRIOR: f32 = 3.8;
    (votes as f32 * rating + M * PRIOR) / (votes as f32 + M)
}

/// Strip UG wiki markup to plain text: drop `[tab]`/`[/tab]`, unwrap `[ch]X[/ch]`.
fn clean_content(raw: &str) -> String {
    raw.replace("[tab]", "")
        .replace("[/tab]", "")
        .replace("[ch]", "")
        .replace("[/ch]", "")
        .replace("\r\n", "\n")
        .trim()
        .to_string()
}

struct Hit {
    id: u64,
    song: String,
    artist: String,
    rating: f32,
    votes: u32,
    url: String,
}

/// Search UG for bass tabs matching `query`, ranked by (title relevance, then
/// Bayesian rating). Best first. Empty on network/parse failure. `song_tokens`
/// (the song-NAME part of the query) must ALL match — an artist-only hit (the
/// artist's other songs) never passes, no matter how well-rated.
async fn search_ranked(
    cl: &reqwest::Client,
    query: &str,
    song_tokens: &HashSet<String>,
) -> Vec<Hit> {
    let Some(json) = ug_get(
        cl,
        "https://api.ultimate-guitar.com/api/v1/tab/search",
        &[("title", query), ("type[]", BASS_TYPE), ("page", "1")],
    )
    .await
    else {
        return Vec::new();
    };
    let tabs = json.get("tabs").and_then(|t| t.as_array()).cloned().unwrap_or_default();

    let qtokens = tokset(query);
    let mut hits: Vec<(f32, Hit)> = tabs
        .iter()
        .filter_map(|t| {
            // Only public ASCII bass tabs (Pro/Official need a paid app + are binary).
            if t.get("tab_access_type").and_then(|v| v.as_str()) != Some("public") {
                return None;
            }
            if t.get("type").and_then(|v| v.as_str()) != Some("Bass Tabs") {
                return None;
            }
            let hit = Hit {
                id: t.get("id").and_then(|v| v.as_u64())?,
                song: t.get("song_name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                artist: t.get("artist_name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                rating: t.get("rating").and_then(|v| v.as_f64()).unwrap_or(0.0) as f32,
                votes: t.get("votes").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
                url: t.get("tab_url").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            };
            // Relevance: fraction of query tokens present in "artist song".
            let hay = tokset(&format!("{} {}", hit.artist, hit.song));
            let matched = qtokens.iter().filter(|q| hay.contains(*q)).count();
            let rel = if qtokens.is_empty() {
                0.0
            } else {
                matched as f32 / qtokens.len() as f32
            };
            if !qtokens.is_empty() && matched == 0 {
                return None;
            }
            // The SONG-name tokens must ALL be present. The old half-overlap floor
            // had an off-by-one at exactly 0.5 AND still let artist-only matches
            // through for multi-word artists — when UG lacks the exact song, the
            // artist's best-rated OTHER song won. Better no tab than a wrong one.
            if !song_tokens.is_empty() && !song_tokens.iter().all(|t| hay.contains(t)) {
                return None;
            }
            if qtokens.len() >= 2 && rel < 0.5 {
                return None;
            }
            // Relevance dominates (×100); Bayesian rating breaks ties within a song.
            Some((rel * 100.0 + bayes(hit.rating, hit.votes), hit))
        })
        .collect();
    hits.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    hits.into_iter().map(|(_, h)| h).collect()
}

/// Fetch a tab's `(cleaned ASCII content, canonical web url)` from `/tab/info`.
async fn fetch_info(id: u64) -> Option<(String, String)> {
    let cl = client().ok()?;
    let json = ug_get(
        &cl,
        "https://api.ultimate-guitar.com/api/v1/tab/info",
        &[("tab_id", id.to_string().as_str()), ("tab_access_type", "public")],
    )
    .await?;
    let content = clean_content(json.get("content").and_then(|v| v.as_str())?);
    if content.is_empty() {
        return None;
    }
    let url = json.get("urlWeb").and_then(|v| v.as_str()).unwrap_or("").to_string();
    Some((content, url))
}

/// Fetch + clean a specific tab's ASCII content (cached on disk by id).
pub async fn tab_content(cache_dir: &Path, id: u64) -> Option<String> {
    let cache = cache_dir.join(format!("ugbass-content-{id}.txt"));
    if let Ok(s) = std::fs::read_to_string(&cache) {
        if !s.is_empty() {
            return Some(s);
        }
    }
    let (content, _) = fetch_info(id).await?;
    let _ = std::fs::create_dir_all(cache_dir);
    let _ = std::fs::write(&cache, &content);
    Some(content)
}

/// Find the highest-rated bass tab for a song title. Cached on disk by title;
/// `fresh` bypasses + rewrites the cache (↻ refresh / after ranking changes).
pub async fn best_bass_tab(cache_dir: &Path, title: &str, fresh: bool) -> Option<BassTab> {
    let query = clean_query(title);
    if query.is_empty() {
        return None;
    }
    // Song-name part: after the last " - " / " – " (titles are composed
    // "Artist - Song"); the whole title when there's no separator.
    let song_part = title
        .rsplit_once(" – ")
        .map(|(_, s)| s)
        .or_else(|| title.rsplit_once(" - ").map(|(_, s)| s))
        .unwrap_or(title);
    let song_tokens = tokset(&clean_query(song_part));
    // v2 cache: keyed by the SAME cleaned query the search uses (bracket-only
    // title variants collide correctly), sorted for determinism, and VERSIONED so
    // a ranking change invalidates stale picks. Bump v when this logic changes.
    let mut key_parts: Vec<&str> = query.split(' ').collect();
    key_parts.sort_unstable();
    let cache = cache_dir.join(format!("ugbass-v2-{}.json", key_parts.join("_")));
    if !fresh {
        if let Ok(s) = std::fs::read_to_string(&cache) {
            if let Ok(bt) = serde_json::from_str::<BassTab>(&s) {
                return Some(bt);
            }
        }
    }
    let cl = client().ok()?;
    let hits = search_ranked(&cl, &query, &song_tokens).await;
    if hits.is_empty() {
        return None;
    }
    let versions: Vec<BassTabVersion> = hits
        .iter()
        .take(8)
        .map(|h| BassTabVersion {
            id: h.id,
            artist: h.artist.clone(),
            song: h.song.clone(),
            rating: h.rating,
            votes: h.votes,
        })
        .collect();
    // Fetch the best candidate that actually yields content (try the top few).
    for h in hits.iter().take(3) {
        if let Some((content, url)) = fetch_info(h.id).await {
            let _ = std::fs::create_dir_all(cache_dir);
            // Cache the content by id too, so the version picker hits the cache.
            let _ = std::fs::write(cache_dir.join(format!("ugbass-content-{}.txt", h.id)), &content);
            let bt = BassTab {
                id: h.id,
                artist: h.artist.clone(),
                song: h.song.clone(),
                rating: h.rating,
                votes: h.votes,
                url: if url.is_empty() { h.url.clone() } else { url },
                content,
                versions,
            };
            let _ = serde_json::to_string(&bt).map(|s| std::fs::write(&cache, s));
            return Some(bt);
        }
    }
    None
}
