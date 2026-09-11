"""Run the keypoint model on arbitrary images and draw what it sees.

    python predict.py --ckpt runs/base/best.pt --images "../../web/test/fixtures/*.png" --out preds

The sim-to-real eyeball: point it at real frames (M2 fixtures, phone photos)
and look. Faces with sigmoid confidence >= 0.5 are drawn solid in scheme
colors with the confidence written at the first corner; 0.25..0.5 are drawn
thin (the model's "maybe"). No detection threshold tuning here - this is a
debug view, not a product.
"""
from __future__ import annotations

import argparse
import glob
from pathlib import Path

import numpy as np
import torch
from PIL import Image, ImageDraw

from dataset import FACE_ORDER, NORM_MEAN, NORM_STD
from model import FaceKP

INPUT_WH = (320, 240)
COLORS = {"U": (255, 255, 255), "R": (220, 40, 40), "F": (40, 190, 80),
          "D": (235, 220, 50), "L": (255, 140, 0), "B": (50, 90, 230)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt", default="runs/base/best.pt")
    ap.add_argument("--images", required=True, help="glob of images to run on")
    ap.add_argument("--out", default="preds")
    args = ap.parse_args()

    device = "cuda" if torch.cuda.is_available() else "cpu"
    ckpt = torch.load(args.ckpt, map_location="cpu", weights_only=True)
    model = FaceKP(pretrained=False, input_hw=(INPUT_WH[1], INPUT_WH[0])).to(device)
    model.load_state_dict(ckpt["model"])
    model.eval()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    files = sorted(glob.glob(args.images))
    if not files:
        raise SystemExit(f"no images match {args.images}")
    for path in files:
        img = Image.open(path).convert("RGB")
        small = img.resize(INPUT_WH, Image.BILINEAR)
        x = (np.asarray(small, dtype=np.float32) / 255.0 - NORM_MEAN) / NORM_STD
        with torch.no_grad():
            pred = model(torch.from_numpy(x.transpose(2, 0, 1)).unsqueeze(0).to(device))[0].cpu().numpy()
        draw = ImageDraw.Draw(img)
        sx, sy = img.width, img.height  # coords are normalized -> original size
        lines = []
        for f in range(6):
            conf = 1 / (1 + np.exp(-pred[f, 0]))
            if conf < 0.25:
                continue
            quad = [(pred[f, 1 + 2 * k] * sx, pred[f, 2 + 2 * k] * sy) for k in range(4)]
            width = 4 if conf >= 0.5 else 1
            draw.line(quad + [quad[0]], fill=COLORS[FACE_ORDER[f]], width=width)
            r = 6
            draw.ellipse([quad[0][0] - r, quad[0][1] - r, quad[0][0] + r, quad[0][1] + r], fill=COLORS[FACE_ORDER[f]])
            draw.text((quad[0][0] + 8, quad[0][1] + 2), f"{FACE_ORDER[f]} {conf:.2f}", fill=COLORS[FACE_ORDER[f]])
            lines.append(f"{FACE_ORDER[f]}:{conf:.2f}")
        dst = out / (Path(path).stem + ".pred.png")
        img.save(dst)
        print(f"{Path(path).name}: {', '.join(lines) if lines else 'nothing >= 0.25'}")
    print(f"wrote {len(files)} previews to {out}")


if __name__ == "__main__":
    main()
