#!/usr/bin/env python3
"""
Export the pretrained BTC (Bi-directional Transformer for Chord recognition)
network to ONNX for chordMatik.

chordMatik runs the neural network in Rust via ONNX Runtime (`ort`) and does the
CRF-free decoding (median filter + Viterbi) in plain Rust. So we export ONLY the
network that maps CQT features -> per-frame chord logits. We do NOT export the
CRF; the reference inference also just argmaxes the output layer.

What this writes:
  src-tauri/resources/models/btc.onnx        the network (dynamic batch)
  src-tauri/resources/models/btc.meta.json   { mean, std, sr, n_bins,
                                               bins_per_octave, hop_length, fmin,
                                               timestep, num_chords, idx_to_chord }

The Rust side reads btc.meta.json to reproduce the exact feature normalization
(features = log(|CQT| + 1e-6); (features - mean) / std) and to map class indices
to labels.

--------------------------------------------------------------------------------
USAGE
--------------------------------------------------------------------------------
1. Clone the reference implementation and grab the pretrained weights:

     git clone https://github.com/jayg996/BTC-ISMIR19.git
     cd BTC-ISMIR19
     # pretrained checkpoint: test/btc_model.pt  (maj/min, num_chords=25)

2. Create an environment with PyTorch + this repo's deps:

     python -m venv .venv && source .venv/bin/activate
     pip install torch onnx pyyaml numpy

3. Run this exporter FROM INSIDE the BTC-ISMIR19 repo (so `btc_model` and
   `utils` import), pointing at the checkpoint and chordMatik's models dir:

     python /path/to/chordmatik/tools/export_btc_onnx.py \
         --checkpoint test/btc_model.pt \
         --config run_config.yaml \
         --out /path/to/chordmatik/src-tauri/resources/models

4. Build chordMatik with the BTC engine enabled:

     cd /path/to/chordmatik/src-tauri && cargo build --features btc
   (ONNX Runtime binaries are fetched by `ort` at build time — needs network.)

Without a model, chordMatik uses its built-in chroma engine automatically.

NOTE: BTC internals (attribute names on the model, exact class ordering) can
vary by checkpoint. The two spots most likely to need a tweak are marked
`ADJUST IF NEEDED` below.
"""

import argparse
import json
import os
import sys

import numpy as np
import torch


def build_idx_to_chord(num_chords: int):
    """Index → chord label, matching the BTC repo's ordering (and the Rust
    `chords::chord_label` mapping, which is the authoritative one at runtime).

    25-class (maj/min):   0..11 = C..B maj, 12..23 = C..B min, 24 = N.
    170-class (large voca, from utils/chords.py convert_to_id_voca):
        id = root*14 + quality_offset, qualities in this exact order:
        [min, maj, dim, aug, min6, maj6, min7, minmaj7, maj7, 7, dim7, hdim7, sus2, sus4]
        168 = X (unknown), 169 = N (no chord).
    """
    roots = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
    if num_chords == 170:
        suff = ["m", "", "dim", "aug", "m6", "6", "m7", "mM7", "maj7", "7", "dim7", "m7b5", "sus2", "sus4"]
        labels = ["X"] * 170
        for r in range(12):
            for q in range(14):
                labels[r * 14 + q] = roots[r] + suff[q]
        labels[168] = "X"
        labels[169] = "N"
        return labels
    labels = roots[:] + [r + "m" for r in roots]
    labels = labels[: max(0, num_chords - 1)]
    labels.append("N")
    return labels


class LogitWrapper(torch.nn.Module):
    """Wrap BTC so forward(x) -> per-frame logits [B, T, num_chords]."""

    def __init__(self, model):
        super().__init__()
        self.model = model

    def forward(self, x):
        # x: [B, timestep, feature_size=144]
        # ADJUST IF NEEDED: match the reference forward up to the output layer.
        # In BTC-ISMIR19, the encoder is `self_attn_layers` and the classifier
        # is `output_layer`; `output_layer(...)` returns (prediction, logits-ish).
        enc, _ = self.model.self_attn_layers(x)
        out = self.model.output_layer(enc)
        # output_layer may return a tuple (prediction, second_out) or logits.
        logits = out[1] if isinstance(out, (tuple, list)) else out
        return logits


def main():
    ap = argparse.ArgumentParser(description="Export BTC to ONNX for chordMatik.")
    ap.add_argument("--checkpoint", required=True, help="path to btc_model.pt")
    ap.add_argument("--config", default="run_config.yaml", help="run_config.yaml")
    ap.add_argument("--out", required=True, help="output models directory")
    ap.add_argument("--opset", type=int, default=17)
    args = ap.parse_args()

    try:
        from btc_model import BTC_model  # noqa: E402  (provided by the BTC repo)
        from utils.hparams import HParams  # noqa: E402
    except Exception as e:  # pragma: no cover
        sys.exit(
            "ERROR: run this from inside the BTC-ISMIR19 repo so `btc_model` and "
            f"`utils` import.\n({e})"
        )

    config = HParams.load(args.config)
    feature_size = int(config.model["feature_size"])  # 144
    timestep = int(config.model["timestep"])  # 108
    num_chords = int(config.model["num_chords"])  # 25

    model = BTC_model(config=config.model)
    ckpt = torch.load(args.checkpoint, map_location="cpu", weights_only=False)
    state = ckpt.get("model", ckpt)
    model.load_state_dict(state)
    model.eval()

    # CRITICAL: with probs_out=False the BTC output layer returns top-k chord
    # INDICES (integers), not logits. Force probs_out=True so output_layer(...)
    # returns the raw pre-softmax logits — which is what the Rust side softmaxes.
    model.probs_out = True
    model.output_layer.probs_out = True

    mean = float(ckpt.get("mean", 0.0))
    std = float(ckpt.get("std", 1.0))

    wrapper = LogitWrapper(model).eval()
    dummy = torch.zeros(1, timestep, feature_size, dtype=torch.float32)

    os.makedirs(args.out, exist_ok=True)
    onnx_path = os.path.join(args.out, "btc.onnx")
    meta_path = os.path.join(args.out, "btc.meta.json")

    with torch.no_grad():
        torch.onnx.export(
            wrapper,
            dummy,
            onnx_path,
            input_names=["cqt"],
            output_names=["logits"],
            opset_version=args.opset,
            dynamic_axes={"cqt": {0: "batch"}, "logits": {0: "batch"}},
            dynamo=False,  # classic TorchScript exporter (no onnxscript dep; clean graph for ort)
        )

    meta = {
        "mean": mean,
        "std": std,
        "sr": int(config.mp3["song_hz"]),
        "n_bins": int(config.feature["n_bins"]),
        "bins_per_octave": int(config.feature["bins_per_octave"]),
        "hop_length": int(config.feature["hop_length"]),
        "fmin": 32.70319566257483,  # librosa default (C1)
        "timestep": timestep,
        "num_chords": num_chords,
        "idx_to_chord": build_idx_to_chord(num_chords),
    }
    with open(meta_path, "w") as f:
        json.dump(meta, f, indent=2)

    # Quick sanity check of the exported graph shape.
    out = wrapper(dummy)
    print(f"✓ wrote {onnx_path}")
    print(f"✓ wrote {meta_path}")
    print(f"  input  : [batch, {timestep}, {feature_size}]")
    print(f"  output : {tuple(np.array(out.shape))}  (expected [1, {timestep}, {num_chords}])")
    print(f"  mean={mean:.4f} std={std:.4f}")


if __name__ == "__main__":
    main()
