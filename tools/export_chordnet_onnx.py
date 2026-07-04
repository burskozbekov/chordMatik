#!/usr/bin/env python3
"""Export music-x-lab ChordNet (structured 6-head chord model) to ONNX for
chordMatik's Step-3 inversions engine. Run from inside the cloned
github.com/music-x-lab/ISMIR2019-Large-Vocabulary-Chord-Recognition repo:

  PYTHONPATH=$repo python export_chordnet_onnx.py \
      cache_data/joint_chord_net_ismir_naive_v1.0_reweight\(0.0,10.0\)_s0.best.sdict \
      /path/to/chordmatik/src-tauri/resources/models/chordnet.onnx

Input  : (1, seq, 252)  — a 252-bin slice of a 288-bin CQT (36 bpo, fmin F#0, hop 512).
Outputs: 6 heads (triad, bass, 7th, 9th, 11th, 13th) as per-(frame) logits.
The Rust side softmaxes + reassembles them into chords with inversions.
"""
import sys
import numpy as np
import torch
import torch.nn as nn

from chordnet_ismir_naive import ChordNet, SPEC_DIM  # noqa: E402


class Wrap(nn.Module):
    def __init__(self, m):
        super().__init__()
        self.m = m

    def forward(self, x):  # x: (1, seq, 252)
        return self.m.forward(x)  # tuple of 6 head logits


def main():
    sdict_path, out_path = sys.argv[1], sys.argv[2]
    model = ChordNet(None)
    state = torch.load(sdict_path, map_location="cpu", weights_only=False)
    # The .sdict is a training checkpoint; the model weights live under "net".
    sd = state.get("net", state.get("state_dict", state)) if isinstance(state, dict) else state
    model.load_state_dict(sd)
    model.eval()

    w = Wrap(model).eval()
    dummy = torch.zeros(1, 100, SPEC_DIM, dtype=torch.float32)
    names = ["triad", "bass", "s7", "s9", "s11", "s13"]
    torch.onnx.export(
        w, dummy, out_path,
        input_names=["cqt"], output_names=names,
        opset_version=17,
        dynamic_axes={"cqt": {1: "seq"}, **{n: {0: "seqframes"} for n in names}},
        dynamo=False,
    )

    # Validate ONNX == PyTorch on random input.
    import onnxruntime as ort
    x = torch.randn(1, 100, SPEC_DIM)
    with torch.no_grad():
        t = [o.numpy() for o in w(x)]
    o = ort.InferenceSession(out_path).run(names, {"cqt": x.numpy()})
    print(f"wrote {out_path}")
    for i, (a, b) in enumerate(zip(t, o)):
        print(f"  {names[i]}: shape {a.shape}  maxdiff {np.max(np.abs(a - b)):.2e}")


if __name__ == "__main__":
    main()
