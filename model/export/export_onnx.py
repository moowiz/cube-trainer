"""Export the trained FaceKP model for the browser (M4).

    python export_onnx.py --ckpt ../train/runs/base/best.pt

Steps: torch -> ONNX (static 1x3x240x320, opset 17) -> parity check in
onnxruntime -> int8 quantization -> parity check again -> copy to
web/public/models/facekp.onnx plus a facekp.json metadata sidecar describing
preprocessing and the output layout, so web/ never hardcodes them.

DECISION: dynamic int8 quantization (weights int8, activations fp32). For a
conv net it shrinks the file ~4x with negligible accuracy cost and needs no
calibration set. If wasm inference is too slow on a phone (M4 exit test),
switch to static QDQ quantization with a calibration reader before shrinking
the architecture.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import onnxruntime as ort
import torch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "train"))
from dataset import NORM_MEAN, NORM_STD, CubeKeypointDataset  # noqa: E402
from model import FaceKP  # noqa: E402

WEB_MODELS = Path(__file__).resolve().parent.parent.parent / "web" / "public" / "models"
INPUT_WH = (320, 240)


def ort_run(path, x):
    sess = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    return sess.run(None, {"image": x.numpy()})[0]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt", default="../train/runs/base/best.pt")
    ap.add_argument("--data", default="../data", help="real samples for the quantization parity check")
    ap.add_argument("--out", default="out")
    args = ap.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    ckpt = torch.load(args.ckpt, map_location="cpu", weights_only=True)
    model = FaceKP(pretrained=False, input_hw=(INPUT_WH[1], INPUT_WH[0]))
    model.load_state_dict(ckpt["model"])
    model.eval()

    fp32_path = out / "facekp.fp32.onnx"
    x = torch.randn(1, 3, INPUT_WH[1], INPUT_WH[0])
    torch.onnx.export(
        model, x, fp32_path, opset_version=17,
        input_names=["image"], output_names=["faces"],
        dynamo=False,
    )

    # parity: torch vs onnxruntime on random input
    with torch.no_grad():
        ref = model(x).numpy()
    got = ort_run(fp32_path, x)
    fp32_diff = float(np.abs(ref - got).max())
    print(f"fp32 onnx vs torch: max abs diff {fp32_diff:.2e}")
    assert fp32_diff < 1e-3, "fp32 export does not match torch"

    from onnxruntime.quantization import QuantType, quantize_dynamic

    int8_path = out / "facekp.onnx"
    quantize_dynamic(fp32_path, int8_path, weight_type=QuantType.QInt8)

    # parity on real samples, reported in pixels (what actually matters)
    try:
        ds = CubeKeypointDataset(args.data, split="val", input_size=INPUT_WH)
        xs = torch.stack([ds[i][0] for i in range(min(16, len(ds)))])
    except FileNotFoundError:
        xs = torch.randn(8, 3, INPUT_WH[1], INPUT_WH[0])
    ref = np.concatenate([ort_run(fp32_path, xs[i : i + 1]) for i in range(len(xs))])
    got = np.concatenate([ort_run(int8_path, xs[i : i + 1]) for i in range(len(xs))])
    px = np.abs(ref[:, :, 1:] - got[:, :, 1:]).reshape(-1, 4, 2) * np.array(INPUT_WH)
    print(f"int8 vs fp32 on {len(xs)} samples: mean corner shift {px.mean():.3f} px, max {px.max():.3f} px")
    sizes = (fp32_path.stat().st_size // 1024, int8_path.stat().st_size // 1024)
    print(f"sizes: fp32 {sizes[0]} KB -> int8 {sizes[1]} KB")

    WEB_MODELS.mkdir(parents=True, exist_ok=True)
    (WEB_MODELS / "facekp.onnx").write_bytes(int8_path.read_bytes())
    meta = {
        "input": {"name": "image", "shape": [1, 3, INPUT_WH[1], INPUT_WH[0]], "layout": "NCHW rgb",
                  "mean": NORM_MEAN.tolist(), "std": NORM_STD.tolist(), "scale": "pixel/255 then (x-mean)/std",
                  "letterbox": "aspect-preserving fit, centered, pad rgb(114,114,114); "
                               "coords map back as (u*W - dx)/scale (see train/dataset.py letterbox_params)"},
        "output": {"name": "faces", "shape": [1, 6, 9], "faces": "URFDLB",
                   "channels": "0: visibility logit (sigmoid me), 1..8: x0,y0..x3,y3 normalized by input w,h",
                   "cornerOrder": "TL,TR,BR,BL in the face's cubejs sticker-layout orientation"},
        "trainedEpoch": ckpt.get("epoch"), "valPx": ckpt.get("val_px"),
    }
    (WEB_MODELS / "facekp.json").write_text(json.dumps(meta, indent=2))
    print(f"wrote {WEB_MODELS / 'facekp.onnx'} and facekp.json")


if __name__ == "__main__":
    main()
