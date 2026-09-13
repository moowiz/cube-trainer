"""Draw WHY the 3x3 max-pool NMS drops a face on a small cube.

    python viz_nms.py --ckpt runs/v4base/best.pt --data ../data_v4 --out failures/nms.png

Picks two frames automatically - one small cube where a confident face centre
loses its 3x3 window to a neighbouring face's blob, and one large cube where
the same three faces are far enough apart to all survive - and draws, for
each: the frame with ground truth, the raw centre heatmap over the 15x20
grid, and the cell values around the contested centre.

The point of the figure: on the small cube the discarded centre is genuinely
confident (the model found the face), it just is not the brightest cell
within one cell of itself, because the neighbouring face's blob is still
rising as it crosses over.
"""
from __future__ import annotations

import argparse
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt          # noqa: E402
import numpy as np                        # noqa: E402
import torch                              # noqa: E402
import torch.nn.functional as F           # noqa: E402
from matplotlib.patches import Polygon, Rectangle   # noqa: E402

from dataset import CubeKeypointDataset, normalize_batch          # noqa: E402
from model import MATCH_CENTROID_FRAC, build_model, decode_maps   # noqa: E402
from targets import MIN_FACE_EDGE_PX, quad_centers                # noqa: E402

INPUT_WH, STRIDE, THRESH = (320, 240), 16, 0.5
KEPT, DROPPED, GT = "#2ecc71", "#e74c3c", "#f5f5f5"


def edges(q):
    return np.linalg.norm(q - np.roll(q, -1, axis=0), axis=1)


def scan(ds, model, device, want, limit):
    """-> the first frame matching `want(record)`; record carries everything
    the drawing needs."""
    wh = np.array(INPUT_WH, dtype=np.float32)
    for start in range(0, min(limit, len(ds)), 64):
        idxs = range(start, min(start + 64, len(ds)))
        batch = [ds[i] for i in idxs]
        with torch.no_grad():
            maps = model(normalize_batch(torch.stack([b[0] for b in batch])).to(device))
        heat_t = torch.sigmoid(maps[:, 0])
        pooled = F.max_pool2d(heat_t.unsqueeze(1), 3, stride=1, padding=1).squeeze(1)
        is_peak = (heat_t >= pooled).cpu().numpy()
        heat = heat_t.cpu().numpy()
        scores, quads = decode_maps(maps, input_wh=INPUT_WH, thresh=THRESH)
        scores = scores.cpu().numpy()
        qpx = (quads.cpu() * torch.from_numpy(wh)).numpy()

        for j, i in enumerate(idxs):
            img, conf, corners, valid = batch[j]
            gts = [f for f in range(6) if conf[f] >= 0.5 and valid[f] >= 0.5]
            gt_q = {f: corners[f].numpy() * wh for f in gts}
            gt_q = {f: q for f, q in gt_q.items() if edges(q).max() >= MIN_FACE_EDGE_PX}
            if len(gt_q) < 2:
                continue
            gt_c = {f: quad_centers(torch.from_numpy(gt_q[f])).numpy() for f in gt_q}
            dets = [d for d in range(scores.shape[1]) if scores[j, d] > 0]
            det_c = {d: quad_centers(torch.from_numpy(qpx[j, d])).numpy() for d in dets}
            pairs = sorted(((float(np.linalg.norm(det_c[d] - gt_c[f])), d, f)
                            for d in dets for f in gt_q), key=lambda t: t[0])
            used_d, used_g = set(), {}
            for dist, d, f in pairs:
                if d in used_d or f in used_g:
                    continue
                if dist > MATCH_CENTROID_FRAC * edges(gt_q[f]).mean():
                    continue
                used_d.add(d); used_g[f] = d
            cells = {f: (int(np.clip(c[1] / STRIDE, 0, heat.shape[1] - 1)),
                         int(np.clip(c[0] / STRIDE, 0, heat.shape[2] - 1)))
                     for f, c in gt_c.items()}
            spacing = min(float(np.linalg.norm((gt_c[a] - gt_c[b]) / STRIDE))
                          for a in gt_c for b in gt_c if a < b)
            rec = {"img": img.numpy(), "gt_q": gt_q, "gt_c": gt_c, "cells": cells,
                   "heat": heat[j], "peak": is_peak[j], "used_g": used_g,
                   "spacing": spacing, "idx": i,
                   "maxedge": max(float(edges(q).max()) for q in gt_q.values())}
            if want(rec):
                return rec
    return None


def wants_failure(rec):
    for f, (ci, cj) in rec["cells"].items():
        if f not in rec["used_g"] and rec["heat"][ci, cj] >= 0.6 and not rec["peak"][ci, cj]:
            rec["focus"] = f
            return rec["spacing"] < 2.3
    return False


def wants_clean(rec):
    if len(rec["gt_q"]) < 3 or rec["spacing"] < 4.5 or rec["maxedge"] < 90:
        return False
    if len(rec["used_g"]) != len(rec["gt_q"]):
        return False
    rec["focus"] = min(rec["cells"])
    return True


def draw_row(axes, rec, title, note):
    ax0, ax1, ax2 = axes
    H, W = rec["heat"].shape

    ax0.imshow(rec["img"])
    for f, q in rec["gt_q"].items():
        missed = f not in rec["used_g"]
        ax0.add_patch(Polygon(q, closed=True, fill=False,
                              edgecolor=DROPPED if missed else KEPT, lw=2))
        c = rec["gt_c"][f]
        ax0.plot(*c, marker="+", color=DROPPED if missed else KEPT, ms=9, mew=2)
        if missed:
            ax0.annotate("dropped", c + np.array([6, -8]), color=DROPPED, fontsize=8, weight="bold")
    ax0.set_title(title, fontsize=10, loc="left")
    ax0.set_xlabel(note, fontsize=8)
    ax0.set_xticks([]); ax0.set_yticks([])

    im = ax1.imshow(rec["heat"], cmap="magma", vmin=0, vmax=1, interpolation="nearest")
    ax1.set_xticks(np.arange(-.5, W, 1), minor=True)
    ax1.set_yticks(np.arange(-.5, H, 1), minor=True)
    ax1.grid(which="minor", color="#ffffff", lw=.25, alpha=.35)
    ax1.set_xticks([]); ax1.set_yticks([])
    for f, (ci, cj) in rec["cells"].items():
        kept = f in rec["used_g"]
        ax1.add_patch(Rectangle((cj - .5, ci - .5), 1, 1, fill=False,
                                edgecolor=KEPT if kept else DROPPED, lw=1.8))
    ax1.set_title("confidence map the model emits  (15 x 20 cells)", fontsize=10, loc="left")
    ax1.set_xlabel("one cell = 16 x 16 input px;  boxes are the true face middles", fontsize=8)
    plt.colorbar(im, ax=ax1, fraction=.036, pad=.02)

    ci, cj = rec["cells"][rec["focus"]]
    r = 3
    y0, x0 = max(ci - r, 0), max(cj - r, 0)
    y1, x1 = min(ci + r + 1, H), min(cj + r + 1, W)
    sub = rec["heat"][y0:y1, x0:x1]
    ax2.imshow(sub, cmap="magma", vmin=0, vmax=1, interpolation="nearest")
    for a in range(sub.shape[0]):
        for b in range(sub.shape[1]):
            v = sub[a, b]
            ax2.text(b, a, f"{v:.2f}".lstrip("0"), ha="center", va="center", fontsize=8,
                     color="#111111" if v > .55 else "#eeeeee")
    fi, fj = ci - y0, cj - x0
    focus_kept = rec["focus"] in rec["used_g"]
    ax2.add_patch(Rectangle((fj - .5, fi - .5), 1, 1, fill=False,
                            edgecolor=KEPT if focus_kept else DROPPED, lw=2.2))
    ax2.add_patch(Rectangle((fj - 1.5, fi - 1.5), 3, 3, fill=False,
                            edgecolor="#3498db", lw=1.6, ls="--"))
    for f, (oi, oj) in rec["cells"].items():
        if f == rec["focus"] or not (y0 <= oi < y1 and x0 <= oj < x1):
            continue
        ax2.add_patch(Rectangle((oj - x0 - .5, oi - y0 - .5), 1, 1, fill=False,
                                edgecolor=KEPT if f in rec["used_g"] else DROPPED, lw=1.6))
    ax2.set_xticks([]); ax2.set_yticks([])
    ax2.set_title("the same cells, up close", fontsize=10, loc="left")
    win = rec["heat"][max(ci - 1, 0):ci + 2, max(cj - 1, 0):cj + 2]
    ax2.set_xlabel(f"solid box: this face's true middle ({rec['heat'][ci, cj]:.2f})\n"
                   f"dashed: the 3x3 window it must be brightest in "
                   f"(best there: {win.max():.2f})", fontsize=8)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt", default="runs/v4base/best.pt")
    ap.add_argument("--data", default="../data_v4")
    ap.add_argument("--split", default="val")
    ap.add_argument("--out", default="failures/nms.png")
    ap.add_argument("--limit", type=int, default=1200)
    args = ap.parse_args()

    device = "cuda" if torch.cuda.is_available() else "cpu"
    ckpt = torch.load(args.ckpt, map_location="cpu", weights_only=True)
    model = build_model("center", pretrained=False, input_hw=(240, 320)).to(device)
    model.load_state_dict(ckpt["model"]); model.eval()
    ds = CubeKeypointDataset(args.data, split=args.split, input_size=INPUT_WH, raw_uint8=True)

    bad = scan(ds, model, device, wants_failure, args.limit)
    good = scan(ds, model, device, wants_clean, args.limit)
    if bad is None or good is None:
        raise SystemExit("could not find both a failing and a clean frame in --limit frames")

    fig, axs = plt.subplots(2, 3, figsize=(13.5, 7.4),
                            gridspec_kw={"width_ratios": [1.15, 1.15, 1]})
    fig.patch.set_facecolor("#ffffff")
    draw_row(axs[0], bad,
             f"SMALL CUBE  (frame #{bad['idx']}, longest face edge {bad['maxedge']:.0f} px)",
             f"face middles only {bad['spacing']:.1f} cells apart -> one face is dropped")
    draw_row(axs[1], good,
             f"LARGE CUBE  (frame #{good['idx']}, longest face edge {good['maxedge']:.0f} px)",
             f"face middles {good['spacing']:.1f} cells apart -> all faces survive")
    fig.suptitle("Why small cubes lose a face: the dedupe step keeps a cell only if it is the "
                 "brightest within one cell of itself", fontsize=12, y=.98)
    fig.tight_layout(rect=(0, 0, 1, .96))
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(out, dpi=150)
    print(f"wrote {out}")
    print(f"  small cube: frame {bad['idx']}, spacing {bad['spacing']:.2f} cells, "
          f"dropped face heat {bad['heat'][bad['cells'][bad['focus']]]:.2f}")
    print(f"  large cube: frame {good['idx']}, spacing {good['spacing']:.2f} cells")


if __name__ == "__main__":
    main()
