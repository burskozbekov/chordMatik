# Models

chordMatik works out of the box with its **built-in chroma engine** — no model
file required. This folder is for the optional, higher-accuracy **BTC** engine.

## Enabling BTC (optional)

1. Generate the model with [`tools/export_btc_onnx.py`](../../../tools/export_btc_onnx.py)
   (see the script header for full steps). It writes:
   - `btc.onnx` — the network (CQT features → per-frame chord logits)
   - `btc.meta.json` — `{ mean, std, sr, n_bins, bins_per_octave, hop_length, fmin, timestep, num_chords, idx_to_chord }`
   into this directory.

2. Build/run with the `btc` Cargo feature (fetches ONNX Runtime at build time):

   ```bash
   cd src-tauri && cargo run --features btc      # or: cargo build --features btc
   ```

When `btc.onnx` is present **and** the app was built with `--features btc`,
analysis uses BTC; otherwise it falls back to the chroma engine automatically.
The app degrades gracefully if the model is missing or fails to load.

> The Rust CQT (`src/dsp`) matches BTC's librosa parameters
> (sr 22050, 144 bins, 24/octave, hop 2048, fmin C1) but is not bit-identical to
> librosa; expect minor accuracy differences vs. the original PyTorch pipeline.

`*.onnx` and `*.meta.json` here are git-ignored.
