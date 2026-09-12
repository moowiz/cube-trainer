"""Run the keypoint model on arbitrary images and draw what it sees.

    python predict.py --ckpt runs/base/best.pt --images "../../web/test/fixtures/*.png" --out preds

The sim-to-real eyeball: point it at real frames (M2 fixtures, phone photos)
and look.

Legacy head: faces with sigmoid confidence >= 0.5 are drawn solid in scheme
colors with the confidence written at the first corner; 0.25..0.5 are drawn
thin (the model's "maybe").

Center head: quads are ANONYMOUS - there is no face id to color by, so every
quad is drawn in one color with its detection score. Naming happens in the
web app from the center sticker (web/src/detect/identify.ts), not here.

No detection threshold tuning here - this is a debug view, not a product.
"""
from __future__ import annotations

import argparse
import glob
from pathlib import Path

import numpy as np
import torch
from PIL import Image, ImageDraw

from dataset import FACE_ORDER, NORM_MEAN, NORM_STD, letterbox_image, letterbox_params
from model import build_model, decode_to_list

INPUT_WH = (320, 240)
COLORS = {"U": (255, 255, 255), "R": (220, 40, 40), "F": (40, 190, 80),
          "D": (235, 220, 50), "L": (255, 140, 0), "B": (50, 90, 230)}
QUAD_COLOR = (0, 230, 255)   # anonymous quads: one color, no identity implied
CORNER_COLOR = (255, 0, 200)  # corner 0, to show the (arbitrary) cyclic start


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt", default="runs/base/best.pt")
    ap.add_argument("--images", required=True, help="glob of images to run on")
    ap.add_argument("--out", default="preds")
    ap.add_argument("--thresh", type=float, default=0.25,
                    help="center head: minimum detection score to draw")
    args = ap.parse_args()

    device = "cuda" if torch.cuda.is_available() else "cpu"
    ckpt = torch.load(args.ckpt, map_location="cpu", weights_only=True)
    head = ckpt.get("head", "legacy")
    model = build_model(head, pretrained=False, input_hw=(INPUT_WH[1], INPUT_WH[0])).to(device)
    model.load_state_dict(ckpt["model"])
    model.eval()
    print(f"head={head}  ckpt={args.ckpt}")

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    files = sorted(glob.glob(args.images))
    if not files:
        raise SystemExit(f"no images match {args.images}")
    for path in files:
        img = Image.open(path).convert("RGB")
        small = letterbox_image(img, *INPUT_WH)
        x = (np.asarray(small, dtype=np.float32) / 255.0 - NORM_MEAN) / NORM_STD
        xt = torch.from_numpy(x.transpose(2, 0, 1)).unsqueeze(0).to(device)
        with torch.no_grad():
            pred = model(xt)
        draw = ImageDraw.Draw(img)
        # predictions are normalized in the letterboxed frame -> map back
        scale, dx, dy = letterbox_params(img.width, img.height, *INPUT_WH)

        def to_source(u, v):
            return ((u * INPUT_WH[0] - dx) / scale, (v * INPUT_WH[1] - dy) / scale)

        lines = []
        if head == "center":
            for det in decode_to_list(pred, input_wh=INPUT_WH, thresh=args.thresh)[0]:
                quad = [to_source(u, v) for u, v in det["quad"]]
                width = 4 if det["score"] >= 0.5 else 1
                draw.line(quad + [quad[0]], fill=QUAD_COLOR, width=width)
                r = 5
                draw.ellipse([quad[0][0] - r, quad[0][1] - r, quad[0][0] + r, quad[0][1] + r],
                             fill=CORNER_COLOR)
                draw.text((quad[0][0] + 8, quad[0][1] + 2), f"{det['score']:.2f}", fill=QUAD_COLOR)
                lines.append(f"{det['score']:.2f}")
        else:
            p = pred[0].cpu().numpy()
            for f in range(6):
                conf = 1 / (1 + np.exp(-p[f, 0]))
                if conf < 0.25:
                    continue
                quad = [to_source(p[f, 1 + 2 * k], p[f, 2 + 2 * k]) for k in range(4)]
                width = 4 if conf >= 0.5 else 1
                color = COLORS[FACE_ORDER[f]]
                draw.line(quad + [quad[0]], fill=color, width=width)
                r = 6
                draw.ellipse([quad[0][0] - r, quad[0][1] - r, quad[0][0] + r, quad[0][1] + r], fill=color)
                draw.text((quad[0][0] + 8, quad[0][1] + 2), f"{FACE_ORDER[f]} {conf:.2f}", fill=color)
                lines.append(f"{FACE_ORDER[f]}:{conf:.2f}")
        dst = out / (Path(path).stem + ".pred.png")
        img.save(dst)
        print(f"{Path(path).name}: {', '.join(lines) if lines else f'nothing >= {args.thresh}'}")
    print(f"wrote {len(files)} previews to {out}")


if __name__ == "__main__":
    main()
