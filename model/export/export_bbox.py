"""Export the stage-1 cube localizer (DenseBox/TinyBox) to ONNX for the browser.

    python export_bbox.py --ckpt ../train/runs/box9/best.pt

Writes web/public/models/cubebox.onnx + cubebox.json. No quantization pass:
the model is ~0.2M params (<1 MB fp32), far below any size concern.
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

import numpy as np
import onnxruntime as ort
import torch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "train"))
from dataset import NORM_MEAN, NORM_STD
from shapes import BOX_WH, MIN_FACE_EDGE_FRAC
from train_bbox import build_box_model

WEB_MODELS = Path(__file__).resolve().parent.parent.parent / "web" / "public" / "models"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt", default="../train/runs/box9/best.pt")
    ap.add_argument("--out", default="out")
    args = ap.parse_args()

    ckpt = torch.load(args.ckpt, map_location="cpu", weights_only=True)
    head = ckpt.get("head", "gap")  # checkpoints before 2026-09-12 are all gap
    input_wh = tuple(ckpt.get("input_wh", BOX_WH))
    if input_wh != tuple(BOX_WH):
        raise SystemExit(f"{args.ckpt} was trained at {input_wh}, this tree builds {BOX_WH} models - "
                         "landscape checkpoints are not deployed (PORTRAIT-DESIGN.md 5)")
    model = build_box_model(head)
    model.load_state_dict(ckpt["model"])
    model.eval()
    print(f"head: {head}  input {input_wh[0]}x{input_wh[1]}")

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    onnx_path = out / "cubebox.onnx"
    w, h = BOX_WH
    dummy = torch.zeros(1, 3, h, w)
    torch.onnx.export(model, dummy, onnx_path, input_names=["image"], output_names=["box"],
                      opset_version=17, dynamo=False)

    # parity check: onnxruntime output must match torch
    sess = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    x = np.random.default_rng(0).standard_normal((1, 3, h, w)).astype(np.float32)
    with torch.no_grad():
        want = model(torch.from_numpy(x)).numpy()
    got = sess.run(None, {"image": x})[0]
    diff = float(np.abs(want - got).max())
    print(f"onnx vs torch max abs diff: {diff:.2e}")
    assert diff < 1e-4, "export mismatch"

    WEB_MODELS.mkdir(parents=True, exist_ok=True)
    (WEB_MODELS / "cubebox.onnx").write_bytes(onnx_path.read_bytes())
    meta = {
        "input": {"name": "image", "shape": [1, 3, h, w], "layout": "NCHW rgb",
                  "mean": NORM_MEAN.tolist(), "std": NORM_STD.tolist(),
                  "scale": "pixel/255 then (x-mean)/std",
                  "letterbox": "aspect-preserving fit, centered, pad rgb(114,114,114)"},
        "output": {"name": "box", "shape": [1, 5],
                   "channels": "0: objectness logit (sigmoid me); 1..4: cx,cy,w,h raw - "
                               "sigmoid each, then multiply by input w/h; map back "
                               "through the letterbox like facekp corners"},
        "task": "stage-1 cube localizer (two-stage detector): single bbox + objectness",
        "head": head,
        "valIou": ckpt.get("val_iou"), "realIou": ckpt.get("real_iou"), "realBad": ckpt.get("real_bad"),
        "minFaceEdgeFrac": MIN_FACE_EDGE_FRAC,
        "trainedEpoch": ckpt.get("epoch"),
        "run": Path(args.ckpt).resolve().parent.name,
        "checkpoint": Path(args.ckpt).name,
        "exported": datetime.now().strftime("%Y-%m-%d %H:%M"),
    }
    (WEB_MODELS / "cubebox.json").write_text(json.dumps(meta, indent=2))
    size_kb = (WEB_MODELS / "cubebox.onnx").stat().st_size // 1024
    print(f"wrote {WEB_MODELS / 'cubebox.onnx'} ({size_kb} KB) and cubebox.json")


if __name__ == "__main__":
    main()
