# chordMatik

Offline, on-device automatic **chord recognition & practice** for songs you own.
Load a local audio file → chordMatik analyzes it fully on your machine → an
interactive, synced chord timeline with diagrams, transpose/capo, and practice loops.

> Private by design: no uploads, no streaming, no accounts. chordMatik only
> analyzes **local audio files you own**.

## Stack

| Layer | Tech |
| --- | --- |
| App shell | Tauri 2 (Rust core + web frontend) |
| Frontend | React 19 + TypeScript + Vite 7 |
| UI | Tailwind CSS v4 + HeroUI v3 + Motion |
| Audio decode / DSP / ML *(later phases)* | symphonia · rubato · rustfft · ort (ONNX Runtime) |
| Chord model *(later phases)* | BTC (Bi-Directional Transformer for Chord Recognition) → ONNX |

Playback & sync live in the webview (Web Audio API); Rust does analysis only.

## Develop

Prerequisites: Node ≥ 20, Rust (stable), Xcode Command Line Tools (macOS).

```bash
npm install

# Run the native desktop app (Rust + webview):
npm run tauri dev

# Or run just the web frontend (UI work, fast iteration):
npm run dev          # → http://localhost:1420

# Checks:
npm run typecheck    # tsc --noEmit
npm run build        # tsc && vite build
```

Primary target is **macOS on Apple Silicon** (`aarch64-apple-darwin`). Windows is a
later port — OS-specific code is isolated under `src-tauri/src/platform/`.

## Project layout

```
src/                  React + TS frontend
  components/          TopBar, EmptyState, TimelinePreview, icons, …
  hooks/               useTheme (light/dark, persisted)
  theme/               design tokens (TS mirror of the CSS palette)
  styles/globals.css   Tailwind + HeroUI imports + chordMatik theme
src-tauri/            Rust core
  src/                 commands, audio/, dsp/, ml/, chords/, cache/, platform/ (added per phase)
  resources/models/    btc.onnx (place here; app degrades gracefully if absent)
tools/               export_btc_onnx.py (PyTorch BTC → ONNX, added in Phase 3)
```

## Design system

Airy, modern, premium — soft glassmorphism, generous spacing, `rounded-2xl`, smooth
Motion. Palette: **light blue + mint green** and their tones. The active chord block
is the signature blue→green gradient `linear-gradient(135deg, #38BDF8 0%, #34D399 100%)`.
Brand colors are wired into both the Tailwind theme (`brand-*` utilities) and HeroUI's
semantic tokens (`--accent`, `--success`, …), so theming is consistent everywhere.

## Features

- **Open local audio** — drag & drop or native picker (mp3, wav, m4a/aac, flac, ogg).
- **On-device analysis** — chords extracted entirely on your machine (~0.35 s for a
  3.5-min song in release); results cached by file-content hash for instant re-open.
- **Synced timeline** — horizontally-scrolling chord ribbon, active chord locked to a
  playhead, click any block to seek. 60 fps (single GPU transform, no per-frame React).
- **Player** — play/pause/seek, ±5 s skip, waveform with playhead, A–B loop (drawn on
  the waveform), playback speed (0.5–1.5×).
- **Practice** — chord diagrams (guitar default, piano + ukulele), transpose (±semitones),
  capo (shows the easier shape + "play X" hint).
- **Library** — recent analyzed songs, one click to reopen instantly.
- **Watch the video in-app** — paste a YouTube link to play the video inside the app
  (official IFrame embed) with the chord timeline synced to it + an alignment offset.
- **Keyboard** — Space = play/pause, ←/→ = seek ∓5 s (⇧ for ∓1 s).
- **Dark / light** — persisted, system-aware.

> **Audio source:** chord analysis always runs on a **local file you own** — chordMatik
> never downloads or extracts audio from YouTube (that would violate YouTube's ToS /
> copyright). The YouTube integration is playback-only via the official embedded player.

Try the UI without the backend: run `npm run dev` and open
[`http://localhost:1420/?demo`](http://localhost:1420/?demo) for a bundled demo clip.

## Build roadmap

- **Phase 0 — Scaffold & theme** ✅ — Tauri 2 + React/TS/Vite, Tailwind v4 + HeroUI v3 + Motion, theme + shell.
- **Phase 1 — Audio decode** ✅ — symphonia decode (all formats) + rubato resample; metadata/waveform command (+tests).
- **Phase 2 — Loading & playback** ✅ — drag & drop + picker, `<audio>` playback via asset protocol, transport + waveform.
- **Phase 3 — DSP + inference** ✅ — sparse-kernel CQT (rustfft); built-in chroma engine + optional BTC/ort; median + Viterbi decode.
- **Phase 4 — Synced timeline** ✅ — the scrolling chord ribbon, playhead-locked, click-to-seek, 60 fps.
- **Phase 5 — Diagrams + transpose/capo** ✅ — guitar/piano/ukulele SVG diagrams; transpose + capo.
- **Phase 6 — Practice + library** ✅ — A–B loop, speed, hash-keyed disk cache + recent-songs library.
- **Phase 7 — Polish** ✅ — empty/loading/error states, keyboard shortcuts, footer, light/dark pass, platform isolation.
- **Phase 8 — In-app YouTube** ✅ — official IFrame Player embedded in-app, chord timeline synced to the video with an alignment offset; playback-only (no download/ripping).

All heavy logic lives in OS-agnostic Rust (`audio`, `dsp`, `chords`, `ml`, `cache`); the
only platform-specific code is in `src-tauri/src/platform/`, so the Windows port is a
build-target change.
