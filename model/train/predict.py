"""Run the keypoint model on arbitrary images and draw what it sees.

    python predict.py --ckpt runs/kpft1/best.pt --box-ckpt runs/box9/best.pt --images "photos/*.jpg" --out preds

The sim-to-real eyeball: point it at real frames (M2 fixtures, phone photos)
and look. Always two-stage, like the app: `--box-ckpt` runs the stage-1
localizer on the whole image, the box is padded by PAD_VAL per side, and
the crop-view keypoint model runs on that crop only (a stage-1 miss draws
nothing). Without --box-ckpt the image is assumed to BE the crop.

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

from dataset import FACE_ORDER, NORM_MEAN, NORM_STD, crop_letterbox, crop_window, letterbox_image, letterbox_params
from model import build_model, decode_to_list
from shapes import BOX_WH, KP_WH, PAD_VAL

INPUT_WH = KP_WH
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
    ap.add_argument("--box-ckpt", default=None, help="stage-1 cubebox checkpoint (two-stage, like the app)")
    args = ap.parse_args()

    device = "cuda" if torch.cuda.is_available() else "cpu"
    ckpt = torch.load(args.ckpt, map_location="cpu", weights_only=True)
    head = ckpt.get("head", "legacy")
    global INPUT_WH
    INPUT_WH = tuple(ckpt.get("input_wh", KP_WH))
    model = build_model(head, pretrained=False, input_hw=(INPUT_WH[1], INPUT_WH[0])).to(device)
    model.load_state_dict(ckpt["model"])
    model.eval()
    localizer = None
    if args.box_ckpt:
        from train_bbox import build_box_model
        bck = torch.load(args.box_ckpt, map_location="cpu", weights_only=True)
        localizer = build_box_model(bck.get("head", "gap")).to(device)
        localizer.load_state_dict(bck["model"])
        localizer.eval()
    print(f"head={head}  view={ckpt.get('view', 'frame')} {INPUT_WH}  ckpt={args.ckpt}"
          + (f"  stage 1 {args.box_ckpt}" if localizer else ""))

    def locate(img):
        """stage 1 on the whole image -> (obj, box in source px) or None."""
        lb = letterbox_image(img, *BOX_WH)
        x = (np.asarray(lb, dtype=np.float32) / 255.0 - NORM_MEAN) / NORM_STD
        with torch.no_grad():
            y = localizer(torch.from_numpy(x.transpose(2, 0, 1)).unsqueeze(0).to(device))[0].cpu().numpy()
        sig = lambda v: 1 / (1 + np.exp(-v))
        obj = float(sig(y[0]))
        if obj < 0.5:
            return None
        s, dx, dy = letterbox_params(img.width, img.height, *BOX_WH)
        cx, cy, w, h = sig(y[1]) * BOX_WH[0], sig(y[2]) * BOX_WH[1], sig(y[3]) * BOX_WH[0], sig(y[4]) * BOX_WH[1]
        return obj, (((cx - w / 2) - dx) / s, ((cy - h / 2) - dy) / s, ((cx + w / 2) - dx) / s, ((cy + h / 2) - dy) / s)

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    files = sorted(glob.glob(args.images))
    if not files:
        raise SystemExit(f"no images match {args.images}")
    for path in files:
        img = Image.open(path).convert("RGB")
        draw = ImageDraw.Draw(img)
        window = (0.0, 0.0, float(img.width), float(img.height))
        if localizer:
            hit = locate(img)
            if hit is None:
                print(f"{Path(path).name}: stage 1 found no cube")
                img.save(out / (Path(path).stem + ".pred.png"))
                continue
            obj, box = hit
            window = crop_window(box, (PAD_VAL,) * 4, (0, 0, img.width, img.height))
            draw.rectangle(box, outline=(90, 230, 110), width=3)
            draw.rectangle(window, outline=(90, 230, 110), width=1)
            draw.text((box[0] + 4, box[1] + 4), f"obj {obj:.2f}", fill=(90, 230, 110))
        small, scale, dx, dy, window = crop_letterbox(img, window, *INPUT_WH)
        x = (np.asarray(small, dtype=np.float32) / 255.0 - NORM_MEAN) / NORM_STD
        xt = torch.from_numpy(x.transpose(2, 0, 1)).unsqueeze(0).to(device)
        with torch.no_grad():
            pred = model(xt)

        def to_source(u, v, dx=dx, dy=dy, scale=scale, window=window):
            return ((u * INPUT_WH[0] - dx) / scale + window[0], (v * INPUT_WH[1] - dy) / scale + window[1])

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
