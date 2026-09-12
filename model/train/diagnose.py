"""Break down validation corner error so the mean can't hide anything.

    python diagnose.py --ckpt runs/base/best.pt --data ../data
    python diagnose.py --ckpt runs/ft/best.pt   --data ../data_real_val --split all

Per visible face: corner error in input pixels, face size (sqrt of quad area),
cube style. Prints percentiles, error by face-size bin, and error by style -
the difference between "uniformly sloppy" and "wrecked tail of tiny cubes"
decides whether the fix is training longer or changing the generator/model.

Center head (anonymous quads) additionally prints:
  - detection accounting (matched / missed GT faces / false positives), since
    an unmatched face is a miss, not a large error, and must not silently
    leave the pixel mean;
  - a ROTATION column. A "diamond" (the old FC head's 45-degree hedge on
    near-face-on views) shows up as a matched quad whose corners are rotated
    about the face center relative to the ground truth. rot20% is the share
    of matched faces off by more than 20 degrees - the number the plan's
    ">100 px close-up class has no diamond quads" gate reads.
  - a per-batch split on real photos: photo batches are separate capture
    sessions (lighting, cube, framing), and the deploy gate is per batch.
    Batches come from which stephens_photos/<batch>/ holds the source photo,
    so this only prints on a machine that has those (they are gitignored on
    purpose - personal photos, public repo).
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import torch

from dataset import FACE_ORDER, CubeKeypointDataset
from model import MATCH_CENTROID_FRAC, build_model, decode_maps, f1_from_counts
from targets import MIN_FACE_EDGE_PX, quad_centers

INPUT_WH = (320, 240)
DIAMOND_DEG = 20.0  # a matched quad rotated more than this is a hedge/diamond


def quad_area(c):  # shoelace, c: (4,2)
    x, y = c[:, 0], c[:, 1]
    return 0.5 * abs(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1)))


def rotation_deg(pred, gt):
    """Mean rotation of `pred` about the face center relative to `gt`, degrees.

    Corner vectors from each quad's own centroid; the mean angle between
    corresponding pairs, taken as a circular mean so +170/-170 don't cancel.
    """
    pv = pred - pred.mean(axis=0)
    gv = gt - gt.mean(axis=0)
    ang = np.arctan2(pv[:, 1], pv[:, 0]) - np.arctan2(gv[:, 1], gv[:, 0])
    return float(np.degrees(np.arctan2(np.sin(ang).mean(), np.cos(ang).mean())))


def batch_index(photo_root: Path) -> dict[str, str]:
    """source filename -> batch name, from the local photo directories."""
    idx: dict[str, str] = {}
    if not photo_root.is_dir():
        return idx
    for f in photo_root.iterdir():
        if f.is_file() and f.suffix.lower() in (".jpg", ".jpeg", ".png"):
            idx[f.name] = "batch1"
        elif f.is_dir():
            for g in f.iterdir():
                if g.is_file() and g.suffix.lower() in (".jpg", ".jpeg", ".png"):
                    idx[g.name] = f.name
    return idx


def group_table(rows, key, label, width=11):
    groups = sorted({r[key] for r in rows})
    for gname in groups:
        sel = [r for r in rows if r[key] == gname]
        hit = [r for r in sel if r["err"] is not None]
        errs = np.array([r["err"] for r in hit]) if hit else np.array([])
        miss = len(sel) - len(hit)
        print(f"  {str(gname):{width}s}: n={len(sel):5d}  "
              + (f"mean {errs.mean():6.2f} px  median {np.median(errs):6.2f} px  " if hit
                 else f"{'(no matches)':30s}")
              + f"missed {miss}")
    print(f"  ({label})")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt", default="runs/base/best.pt")
    ap.add_argument("--data", default="../data")
    ap.add_argument("--split", default="val", choices=["train", "val", "all"])
    ap.add_argument("--thresh", type=float, default=0.5,
                    help="center head: detection score counted as a detection")
    ap.add_argument("--photos", default="../../stephens_photos",
                    help="root holding the original photo batches, for the per-batch split")
    ap.add_argument("--min-edge", type=float, default=MIN_FACE_EDGE_PX,
                    help="faces whose longest edge is below this (input px) are out of "
                         "scanning range and are ignored entirely; 0 scores everything")
    args = ap.parse_args()

    device = "cuda" if torch.cuda.is_available() else "cpu"
    ckpt = torch.load(args.ckpt, map_location="cpu", weights_only=True)
    head = ckpt.get("head", "legacy")
    model = build_model(head, pretrained=False, input_hw=(INPUT_WH[1], INPUT_WH[0])).to(device)
    model.load_state_dict(ckpt["model"])
    model.eval()
    print(f"head={head}  ckpt={args.ckpt}  data={args.data} ({args.split})")

    ds = CubeKeypointDataset(args.data, split=args.split, input_size=INPUT_WH)
    batches = batch_index(Path(args.photos))
    rows = []          # one per ground-truth visible face
    false_pos = 0
    wh = np.array(INPUT_WH, dtype=np.float32)
    with torch.no_grad():
        for start in range(0, len(ds), 64):
            idxs = range(start, min(start + 64, len(ds)))
            batch = [ds[i] for i in idxs]
            x = torch.stack([b[0] for b in batch]).to(device)
            pred = model(x)
            if head == "center":
                scores, quads = decode_maps(pred, input_wh=INPUT_WH, thresh=args.thresh)
                scores = scores.cpu().numpy()
                quads_px = (quads.cpu() * torch.from_numpy(wh))
                det_c = quad_centers(quads_px).numpy()
                quads_px = quads_px.numpy()
            else:
                p = pred.cpu().numpy()
            for j, i in enumerate(idxs):
                meta = json.loads(ds.files[i].read_text())
                style = meta.get("style", "?")
                batch_name = batches.get(meta.get("source", ""), "-")
                _, conf, corners, valid = batch[j]
                gts = [f for f in range(6) if conf[f] >= 0.5 and valid[f] >= 0.5]
                gt_q = {f: corners[f].numpy() * wh for f in gts}
                if head == "center":
                    dets = [d for d in range(scores.shape[1]) if scores[j, d] > 0]
                    gt_c = {f: quad_centers(torch.from_numpy(gt_q[f])).numpy() for f in gts}
                    pairs = sorted(((float(np.linalg.norm(det_c[j, d] - gt_c[f])), d, f)
                                    for d in dets for f in gts), key=lambda t: t[0])
                    used_d: set[int] = set()
                    used_g: dict[int, int] = {}
                    for dist, d, f in pairs:
                        if d in used_d or f in used_g:
                            continue
                        edge = float(np.linalg.norm(gt_q[f] - np.roll(gt_q[f], -1, axis=0), axis=1).mean())
                        if dist > MATCH_CENTROID_FRAC * edge:
                            continue
                        used_d.add(d)
                        used_g[f] = d
                    false_pos += len(dets) - len(used_d)
                    for f in gts:
                        e = np.linalg.norm(gt_q[f] - np.roll(gt_q[f], -1, axis=0), axis=1)
                        base = {"size": float(np.sqrt(quad_area(gt_q[f]))), "style": style,
                                "face": FACE_ORDER[f], "batch": batch_name,
                                "maxEdge": float(e.max()),
                                "squash": float(e.min() / max(e.max(), 1e-9)),
                                "far": bool(e.max() < args.min_edge)}
                        if f not in used_g:
                            rows.append({**base, "err": None, "rot": None, "score": None})
                            continue
                        d = used_g[f]
                        shifts = [np.roll(gt_q[f], r, axis=0) for r in range(4)]
                        errs = [float(np.linalg.norm(quads_px[j, d] - s, axis=1).mean()) for s in shifts]
                        r = int(np.argmin(errs))
                        rows.append({**base, "err": errs[r],
                                     "rot": abs(rotation_deg(quads_px[j, d], shifts[r])),
                                     "score": float(scores[j, d])})
                else:
                    for f in gts:
                        pd = p[j, f, 1:].reshape(4, 2) * wh
                        errs = [float(np.linalg.norm(pd - np.roll(gt_q[f], r, axis=0), axis=1).mean())
                                for r in range(4)]
                        e = np.linalg.norm(gt_q[f] - np.roll(gt_q[f], -1, axis=0), axis=1)
                        rows.append({"err": min(errs), "rot": None, "score": None,
                                     "size": float(np.sqrt(quad_area(gt_q[f]))), "style": style,
                                     "face": FACE_ORDER[f], "batch": batch_name,
                                     "maxEdge": float(e.max()),
                                     "squash": float(e.min() / max(e.max(), 1e-9)),
                                     "far": bool(e.max() < args.min_edge)})

    out_of_range = [r for r in rows if r["far"]]
    if out_of_range:
        seen = len([r for r in out_of_range if r["err"] is not None])
        print(f"\nignored {len(out_of_range)} of {len(rows)} ground-truth faces as out of "
              f"scanning range (longest edge < {args.min_edge:.0f} px at 320x240 - further "
              f"than a person can hold a cube); the model happened to find {seen} of them")
    rows = [r for r in rows if not r["far"]]
    hit = [r for r in rows if r["err"] is not None]
    errs = np.array([r["err"] for r in hit])
    sizes = np.array([r["size"] for r in hit])
    print(f"\nground-truth visible faces: {len(rows)}")
    if head == "center":
        tp, fn = len(hit), len(rows) - len(hit)
        print(f"matched {tp}   missed {fn}   false positives {false_pos}   "
              f"F1 {f1_from_counts(tp, false_pos, fn):.3f}   (score >= {args.thresh})")
    if not hit:
        raise SystemExit("nothing matched - the checkpoint detects nothing at this threshold")
    print(f"corner error over matched faces: mean {errs.mean():.2f} px  median {np.median(errs):.2f} px")
    qs = [10, 25, 50, 75, 90, 95, 99]
    print("percentiles:", "  ".join(f"p{q} {np.percentile(errs, q):.2f}" for q in qs))

    print("\nerror by face size (sqrt of quad area, input px):")
    bins = [(0, 40), (40, 70), (70, 100), (100, 1e9)]
    for lo, hi in bins:
        sel = [r for r in rows if lo <= r["size"] < hi]
        h = [r for r in sel if r["err"] is not None]
        if not sel:
            continue
        e = np.array([r["err"] for r in h]) if h else np.array([np.nan])
        s = np.array([r["size"] for r in h]) if h else np.array([1.0])
        rel = e / np.maximum(s, 1)
        extra = ""
        if head == "center":
            rot = np.array([r["rot"] for r in h]) if h else np.array([np.nan])
            extra = (f"  rot med {np.nanmedian(rot):5.1f}deg  rot{DIAMOND_DEG:.0f}% "
                     f"{100 * np.mean(rot > DIAMOND_DEG) if h else float('nan'):5.1f}%"
                     f"  missed {len(sel) - len(h):4d}")
        print(f"  {lo:>3.0f}-{'inf' if hi > 1e8 else f'{hi:.0f}':>4} px: n={len(sel):5d}  "
              f"mean {np.nanmean(e):6.2f} px  median {np.nanmedian(e):6.2f} px  "
              f"rel {100 * np.nanmean(rel):5.1f}% of face size{extra}")

    if head == "center":
        rot_all = np.array([r["rot"] for r in hit])
        print(f"\nrotation vs ground truth: median {np.median(rot_all):.1f}deg   "
              f"over {DIAMOND_DEG:.0f}deg: {100 * np.mean(rot_all > DIAMOND_DEG):.1f}% of matched faces")

    if head == "center":
        print("\nerror by foreshortening (shortest edge / longest edge; low = glancing angle):")
        for lo, hi in [(0, 0.25), (0.25, 0.40), (0.40, 0.60), (0.60, 1.01)]:
            sel = [r for r in rows if lo <= r["squash"] < hi]
            h = [r for r in sel if r["err"] is not None]
            if not sel:
                continue
            e = np.array([r["err"] for r in h]) if h else np.array([np.nan])
            print(f"  {lo:.2f}-{hi:.2f}: n={len(sel):5d}  mean {np.nanmean(e):6.2f} px  "
                  f"missed {len(sel) - len(h):4d} ({100 * (len(sel) - len(h)) / len(sel):4.1f}%)")
        print("  (the third face of a corner-on view lands in the lowest bin - the pose")
        print("   the generator's --cornerBias exists to supply, and now the weakest class)")

    print("\nerror by style:")
    group_table(rows, "style", "a face with no match is 'missed', not a large error")
    if any(r["batch"] != "-" for r in rows):
        print("\nerror by photo batch:")
        group_table(rows, "batch", "the deploy gate is per batch, not on the mean")
    if head != "center":
        print("\nerror by face:")
        group_table(rows, "face", "named slots exist only for the legacy head", width=1)


if __name__ == "__main__":
    main()
