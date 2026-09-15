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
Inference itself lives in twostage.py (shared with detect_server.py).
"""
from __future__ import annotations

import argparse
import glob
from pathlib import Path

from PIL import Image, ImageDraw

from twostage import TwoStage

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

    ts = TwoStage.load(args.ckpt, args.box_ckpt, thresh=args.thresh)

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    files = sorted(glob.glob(args.images))
    if not files:
        raise SystemExit(f"no images match {args.images}")
    for path in files:
        img = Image.open(path).convert("RGB")
        draw = ImageDraw.Draw(img)
        det = ts.detect(img)
        if det is None:
            print(f"{Path(path).name}: stage 1 found no cube")
            img.save(out / (Path(path).stem + ".pred.png"))
            continue
        if det.box is not None:
            draw.rectangle(det.box, outline=(90, 230, 110), width=3)
            draw.rectangle(det.window, outline=(90, 230, 110), width=1)
            draw.text((det.box[0] + 4, det.box[1] + 4), f"obj {det.obj:.2f}", fill=(90, 230, 110))

        lines = []
        for d in det.quads:
            quad = [tuple(p) for p in d["quad"]]
            width = 4 if d["score"] >= 0.5 else 1
            draw.line(quad + [quad[0]], fill=QUAD_COLOR, width=width)
            r = 5
            draw.ellipse([quad[0][0] - r, quad[0][1] - r, quad[0][0] + r, quad[0][1] + r],
                         fill=CORNER_COLOR)
            draw.text((quad[0][0] + 8, quad[0][1] + 2), f"{d['score']:.2f}", fill=QUAD_COLOR)
            lines.append(f"{d['score']:.2f}")
        for letter, conf, q in det.faces:
            quad = [tuple(p) for p in q]
            width = 4 if conf >= 0.5 else 1
            color = COLORS[letter]
            draw.line(quad + [quad[0]], fill=color, width=width)
            r = 6
            draw.ellipse([quad[0][0] - r, quad[0][1] - r, quad[0][0] + r, quad[0][1] + r], fill=color)
            draw.text((quad[0][0] + 8, quad[0][1] + 2), f"{letter} {conf:.2f}", fill=color)
            lines.append(f"{letter}:{conf:.2f}")
        dst = out / (Path(path).stem + ".pred.png")
        img.save(dst)
        print(f"{Path(path).name}: {', '.join(lines) if lines else f'nothing >= {args.thresh}'}")
    print(f"wrote {len(files)} previews to {out}")


if __name__ == "__main__":
    main()
