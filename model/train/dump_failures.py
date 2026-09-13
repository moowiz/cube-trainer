"""Save the frames the detector gets WRONG, drawn, so they can be looked at.

    python dump_failures.py --ckpt runs/v4base/best.pt --data ../data_v4 --split val
    python dump_failures.py --ckpt runs/v4base/best.pt --data ../data_real_val --split all

diagnose.py says how often each failure happens; this says what they look
like. Same checkpoint, same matching rule (greedy on centres, accepted within
MATCH_CENTROID_FRAC of the ground-truth face's mean edge), same out-of-range
ignore - so the counts printed here reconcile with diagnose.py's table.

Three failure kinds, one contact sheet each in --out:

  miss  a ground-truth face inside scanning range with no detection matched
  fp    a detection matched to no ground-truth face
  err   a matched face whose corners are furthest off

Drawing: ground truth green, matched prediction blue, missed ground truth red,
false positive orange. The dot marks each quad's first corner - the quads are
anonymous, so it is only there to show winding, and green and blue dots
disagreeing is NOT an error.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import torch
from PIL import Image, ImageDraw

from dataset import CubeKeypointDataset, normalize_batch
from model import MATCH_CENTROID_FRAC, build_model, decode_maps
from shapes import min_face_edge_px
from targets import quad_centers

from shapes import KP_WH
INPUT_WH = KP_WH  # overwritten from the checkpoint
GT_OK, GT_MISS, DET_OK, DET_FP = (60, 200, 110), (235, 70, 60), (70, 150, 245), (240, 150, 40)


def quad_area(c):  # shoelace
    x, y = c[:, 0], c[:, 1]
    return 0.5 * abs(float(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1))))


def edges(q):
    return np.linalg.norm(q - np.roll(q, -1, axis=0), axis=1)


def draw_quad(dr, q, color, width=2, tag=None):
    pts = [(float(x), float(y)) for x, y in q]
    dr.line(pts + [pts[0]], fill=color, width=width)
    x, y = pts[0]
    dr.ellipse([x - 3, y - 3, x + 3, y + 3], fill=color)
    if tag:
        dr.text((min(max(x + 6, 2), INPUT_WH[0] - 60), max(y - 12, 2)), tag, fill=color)


def contact_sheet(tiles, path, cols=4, scale=2):
    """tiles: list of (PIL image, caption). Saved as one grid, 2x upscaled."""
    if not tiles:
        return None
    w, h = INPUT_WH[0] * scale, INPUT_WH[1] * scale
    rows = (len(tiles) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * w, rows * (h + 22)), (18, 20, 22))
    dr = ImageDraw.Draw(sheet)
    for i, (img, cap) in enumerate(tiles):
        cx, cy = (i % cols) * w, (i // cols) * (h + 22)
        sheet.paste(img.resize((w, h), Image.NEAREST), (cx, cy))
        dr.text((cx + 6, cy + h + 6), cap, fill=(210, 215, 220))
    sheet.save(path)
    return path


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt", default="runs/v4base/best.pt")
    ap.add_argument("--data", default="../data_v4")
    ap.add_argument("--split", default="val", choices=["train", "val", "all"])
    ap.add_argument("--out", default="failures")
    ap.add_argument("--n", type=int, default=12, help="frames per contact sheet")
    ap.add_argument("--thresh", type=float, default=0.5)
    ap.add_argument("--min-edge", type=float, default=None, help="default: the range floor at the input height")
    ap.add_argument("--limit", type=int, default=0, help="only scan the first N frames")
    args = ap.parse_args()

    device = "cuda" if torch.cuda.is_available() else "cpu"
    ckpt = torch.load(args.ckpt, map_location="cpu", weights_only=True)
    head = ckpt.get("head", "legacy")
    if head != "center":
        raise SystemExit(f"this tool is for the center head, checkpoint says {head!r}")
    global INPUT_WH
    INPUT_WH = tuple(ckpt.get("input_wh", KP_WH))
    if args.min_edge is None:
        args.min_edge = min_face_edge_px(INPUT_WH[1])
    model = build_model(head, pretrained=False, input_hw=(INPUT_WH[1], INPUT_WH[0])).to(device)
    model.load_state_dict(ckpt["model"])
    model.eval()

    ds = CubeKeypointDataset(args.data, split=args.split, input_size=INPUT_WH, raw_uint8=True,
                             view=ckpt.get("view", "frame"))
    n_frames = len(ds) if not args.limit else min(args.limit, len(ds))
    wh = np.array(INPUT_WH, dtype=np.float32)
    frames = []          # one record per frame that has at least one failure
    tot = {"faces": 0, "far": 0, "matched": 0, "missed": 0, "fp": 0}

    with torch.no_grad():
        for start in range(0, n_frames, 64):
            idxs = range(start, min(start + 64, n_frames))
            batch = [ds[i] for i in idxs]
            raw = torch.stack([b[0] for b in batch])
            pred = model(normalize_batch(raw).to(device))
            scores, quads = decode_maps(pred, input_wh=INPUT_WH, thresh=args.thresh)
            scores = scores.cpu().numpy()
            quads_px = (quads.cpu() * torch.from_numpy(wh))
            det_c = quad_centers(quads_px).numpy()
            quads_px = quads_px.numpy()

            for j, i in enumerate(idxs):
                _, conf, corners, valid = batch[j]
                gts = [f for f in range(6) if conf[f] >= 0.5 and valid[f] >= 0.5]
                gt_q = {f: corners[f].numpy() * wh for f in gts}
                in_range = {f: bool(edges(gt_q[f]).max() >= args.min_edge) for f in gts}
                dets = [d for d in range(scores.shape[1]) if scores[j, d] > 0]
                gt_c = {f: quad_centers(torch.from_numpy(gt_q[f])).numpy() for f in gts}
                pairs = sorted(((float(np.linalg.norm(det_c[j, d] - gt_c[f])), d, f)
                                for d in dets for f in gts), key=lambda t: t[0])
                used_d, used_g = set(), {}
                for dist, d, f in pairs:
                    if d in used_d or f in used_g:
                        continue
                    if dist > MATCH_CENTROID_FRAC * edges(gt_q[f]).mean():
                        continue
                    used_d.add(d)
                    used_g[f] = d

                misses, errs_here = [], []
                for f in gts:
                    tot["faces"] += 1
                    if not in_range[f]:
                        tot["far"] += 1
                        continue
                    e = edges(gt_q[f])
                    info = {"face": f, "size": float(np.sqrt(quad_area(gt_q[f]))),
                            "maxEdge": float(e.max()), "squash": float(e.min() / max(e.max(), 1e-9))}
                    if f not in used_g:
                        tot["missed"] += 1
                        misses.append(info)
                        continue
                    tot["matched"] += 1
                    d = used_g[f]
                    err = min(float(np.linalg.norm(quads_px[j, d] - np.roll(gt_q[f], r, axis=0),
                                                   axis=1).mean()) for r in range(4))
                    errs_here.append({**info, "det": d, "err": err})
                fps = [d for d in dets if d not in used_d]
                tot["fp"] += len(fps)
                if not (misses or fps or errs_here):
                    continue
                meta = json.loads(ds.files[i].read_text())
                frames.append({
                    "i": i, "img": batch[j][0].numpy(), "style": meta.get("style", "?"),
                    "gt": gt_q, "in_range": in_range, "used_g": used_g,
                    "quads": quads_px[j], "scores": scores[j],
                    "misses": misses, "fps": fps, "errs": errs_here,
                })

    print(f"{args.data} ({args.split}): {n_frames} frames, {tot['faces']} labelled faces")
    print(f"  ignored out of range (long edge < {args.min_edge:.0f} px): {tot['far']}")
    print(f"  matched {tot['matched']}   missed {tot['missed']}   false positives {tot['fp']}")

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    def render(fr, highlight):
        img = Image.fromarray(fr["img"]).convert("RGB")
        dr = ImageDraw.Draw(img)
        for f, q in fr["gt"].items():
            if not fr["in_range"][f]:
                continue
            missed = f not in fr["used_g"]
            draw_quad(dr, q, GT_MISS if missed else GT_OK, 2 if missed else 1,
                      "MISS" if missed else None)
        for d in range(len(fr["scores"])):
            if fr["scores"][d] <= 0:
                continue
            fp = d in fr["fps"]
            tag = f"FP {fr['scores'][d]:.2f}" if fp else None
            if not fp and highlight == "err":
                hit = next((e for e in fr["errs"] if e["det"] == d), None)
                tag = f"{hit['err']:.1f}px" if hit else None
            draw_quad(dr, fr["quads"][d], DET_FP if fp else DET_OK, 2 if fp else 1, tag)
        return img

    sheets = {}
    # worst first: most missed faces, then the biggest missed face (a big miss is
    # a worse bug than a marginal one) / lowest-score FP / largest corner error
    ranks = {
        "miss": (lambda fr: (-len(fr["misses"]), -max((m["maxEdge"] for m in fr["misses"]), default=0)),
                 lambda fr: bool(fr["misses"])),
        "fp": (lambda fr: (-len(fr["fps"]), -max((fr["scores"][d] for d in fr["fps"]), default=0)),
               lambda fr: bool(fr["fps"])),
        "err": (lambda fr: (-max((e["err"] for e in fr["errs"]), default=0),),
                lambda fr: bool(fr["errs"])),
    }
    for kind, (key, keep) in ranks.items():
        sel = sorted([f for f in frames if keep(f)], key=key)[:args.n]
        tiles = []
        for fr in sel:
            if kind == "miss":
                m = max(fr["misses"], key=lambda m: m["maxEdge"])
                cap = (f"#{fr['i']} {fr['style'][:11]} missed {len(fr['misses'])}  "
                       f"edge {m['maxEdge']:.0f}px squash {m['squash']:.2f}")
            elif kind == "fp":
                cap = (f"#{fr['i']} {fr['style'][:11]} {len(fr['fps'])} false pos  "
                       f"top score {max(fr['scores'][d] for d in fr['fps']):.2f}")
            else:
                e = max(fr["errs"], key=lambda e: e["err"])
                cap = (f"#{fr['i']} {fr['style'][:11]} err {e['err']:.1f}px  "
                       f"edge {e['maxEdge']:.0f}px squash {e['squash']:.2f}")
            tiles.append((render(fr, kind), cap))
        path = contact_sheet(tiles, out / f"{kind}.png")
        sheets[kind] = (len([f for f in frames if keep(f)]), path)
        print(f"  {kind}: {sheets[kind][0]} frames affected -> {path}")

    (out / "summary.json").write_text(json.dumps({
        "ckpt": args.ckpt, "data": args.data, "split": args.split, "totals": tot,
        "frames_with_failures": len(frames),
    }, indent=1))


if __name__ == "__main__":
    main()
