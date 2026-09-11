"""Break down validation corner error so the mean can't hide anything.

    python diagnose.py --ckpt runs/base/best.pt --data ../data

Per visible face: corner error in input pixels, face size (sqrt of quad area),
cube style. Prints percentiles, error by face-size bin, and error by style -
the difference between "uniformly sloppy" and "wrecked tail of tiny cubes"
decides whether the fix is training longer or changing the generator/model.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import torch

from dataset import FACE_ORDER, CubeKeypointDataset
from model import FaceKP

INPUT_WH = (320, 240)


def quad_area(c):  # shoelace, c: (4,2)
    x, y = c[:, 0], c[:, 1]
    return 0.5 * abs(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt", default="runs/base/best.pt")
    ap.add_argument("--data", default="../data")
    args = ap.parse_args()

    device = "cuda" if torch.cuda.is_available() else "cpu"
    ckpt = torch.load(args.ckpt, map_location="cpu", weights_only=True)
    model = FaceKP(pretrained=False, input_hw=(INPUT_WH[1], INPUT_WH[0])).to(device)
    model.load_state_dict(ckpt["model"])
    model.eval()

    ds = CubeKeypointDataset(args.data, split="val", input_size=INPUT_WH)
    rows = []  # (err_px, size_px, style, face)
    wh = np.array(INPUT_WH, dtype=np.float32)
    with torch.no_grad():
        for start in range(0, len(ds), 64):
            idxs = range(start, min(start + 64, len(ds)))
            batch = [ds[i] for i in idxs]
            x = torch.stack([b[0] for b in batch]).to(device)
            pred = model(x).cpu().numpy()
            for j, i in enumerate(idxs):
                _, conf, corners, valid = batch[j]
                style = json.loads(ds.files[i].read_text()).get("style", "?")
                for f in range(6):
                    if conf[f] < 0.5 or valid[f] < 0.5:
                        continue
                    gt = corners[f].numpy() * wh
                    pd = pred[j, f, 1:].reshape(4, 2) * wh
                    err = float(np.linalg.norm(gt - pd, axis=1).mean())
                    rows.append((err, float(np.sqrt(quad_area(gt))), style, FACE_ORDER[f]))

    errs = np.array([r[0] for r in rows])
    sizes = np.array([r[1] for r in rows])
    print(f"visible faces: {len(rows)}   mean {errs.mean():.2f} px")
    qs = [10, 25, 50, 75, 90, 95, 99]
    print("percentiles:", "  ".join(f"p{q} {np.percentile(errs, q):.2f}" for q in qs))
    print("\nerror by face size (sqrt of quad area, input px):")
    bins = [(0, 40), (40, 70), (70, 100), (100, 1e9)]
    for lo, hi in bins:
        m = (sizes >= lo) & (sizes < hi)
        if m.any():
            rel = errs[m] / np.maximum(sizes[m], 1)
            print(f"  {lo:>3.0f}-{'inf' if hi > 1e8 else f'{hi:.0f}':>4} px: n={m.sum():5d}  mean {errs[m].mean():6.2f} px  "
                  f"median {np.median(errs[m]):6.2f} px  rel {100 * rel.mean():5.1f}% of face size")
    print("\nerror by style:")
    for s in ("stickered", "stickerless"):
        m = np.array([r[2] == s for r in rows])
        if m.any():
            print(f"  {s:11s}: n={m.sum():5d}  mean {errs[m].mean():6.2f} px  median {np.median(errs[m]):6.2f} px")
    print("\nerror by face:")
    for f in FACE_ORDER:
        m = np.array([r[3] == f for r in rows])
        if m.any():
            print(f"  {f}: n={m.sum():5d}  mean {errs[m].mean():6.2f} px")


if __name__ == "__main__":
    main()
