"""Break down validation corner error so the mean can't hide anything.

    python diagnose.py --ckpt runs/kp1/best.pt --data ../data_v5
    python diagnose.py --ckpt runs/kpft1/best.pt --data ../data_real_val --split all
    python diagnose.py --ckpt runs/kpft1/best.pt --data ../data_real_val --split all --jitter 0.15

The view (crop/frame) and input size come from the checkpoint. On the crop
view every image is re-cropped around the cube hull with the app's padding
(PAD_VAL per side); `--jitter J` draws the padding U(PAD_VAL-J, PAD_VAL+J)
per side instead, which is what stage 2 sees under localizer error. Errors
are reported in INPUT px and, via the crop scale, in SOURCE px; face-size
bins are fractions of the SOURCE frame height (the range floor's units):
far 0.133-0.188, mid 0.188-0.25, near > 0.25 (PORTRAIT-DESIGN.md 5).

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
  - the CELL-CENTRE error: the 9 sticker centres the colour sampler reads,
    placed through a homography least-squares-fitted to every point the
    model regressed (exact for a 4-corner model, overdetermined for the
    16-point grid), against the same centres from the ground-truth corners.
    This is the number the colour pipeline actually feels; corner error is
    the comparable one. Grid checkpoints also print the raw 16-point error.
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

from dataset import FACE_ORDER, NORM_MEAN, NORM_STD, CubeKeypointDataset
from PIL import Image
from model import MATCH_CENTROID_FRAC, build_model, decode_maps, f1_from_counts
from shapes import KP_WH, MIN_FACE_EDGE_FRAC, PAD_VAL, min_face_edge_px
from targets import GRID_N, cyclic_perms, quad_centers, quad_grid_points

INPUT_WH = KP_WH   # overwritten from the checkpoint
DIAMOND_DEG = 20.0  # a matched quad rotated more than this is a hedge/diamond
# fractions of the source frame height, longest visible edge
RANGE_BINS = [("far", MIN_FACE_EDGE_FRAC, 0.188), ("mid", 0.188, 0.25), ("near", 0.25, 1e9)]


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


def unit_points(npts: int) -> np.ndarray:
    """(P,2) face-plane (u,v) of the model's P points: the unit-square corners
    for 4, the (i/3, j/3) grid for 16 (targets.quad_grid_points order)."""
    if npts == 4:
        return np.array([[0, 0], [1, 0], [1, 1], [0, 1]], dtype=np.float64)
    t = np.arange(GRID_N) / (GRID_N - 1)
    v, u = np.meshgrid(t, t, indexing="ij")
    return np.stack([u.ravel(), v.ravel()], axis=1)


CELL_UV = np.array([[(i + 0.5) / 3, (j + 0.5) / 3] for j in range(3) for i in range(3)])


def fit_homography(src: np.ndarray, dst: np.ndarray) -> np.ndarray:
    """Least-squares DLT, src (N,2) -> dst (N,2), N >= 4. What the app would do
    with a redundant point set: every point votes for the plane."""
    rows = []
    for (u, v), (x, y) in zip(src, dst):
        rows.append([-u, -v, -1, 0, 0, 0, u * x, v * x, x])
        rows.append([0, 0, 0, -u, -v, -1, u * y, v * y, y])
    _, _, vt = np.linalg.svd(np.asarray(rows, dtype=np.float64))
    H = vt[-1].reshape(3, 3)
    return H / (H[2, 2] if abs(H[2, 2]) > 1e-12 else 1.0)


def apply_h(H: np.ndarray, uv: np.ndarray) -> np.ndarray:
    p = np.concatenate([uv, np.ones((len(uv), 1))], axis=1) @ H.T
    w = np.where(np.abs(p[:, 2:3]) > 1e-9, p[:, 2:3], 1e-9)
    return p[:, :2] / w


# Which of the grid's points the cell-centre homography is fitted to
# (`--fit`): all 16, the 12 interior (non-corner) ones, or the 4 innermost.
FIT_SUBSETS = {"all": list(range(16)), "interior": [p for p in range(16) if p not in (0, 3, 12, 15)],
               "inner": [5, 6, 9, 10]}
FIT_SUBSET = "all"


def cell_centre_error(pred_pts: np.ndarray, gt_corners: np.ndarray, npts: int) -> float:
    """Mean distance between the 9 sticker centres placed by a homography fitted
    to the predicted points (all of them, or the `--fit` subset for a grid
    model) and those from the ground-truth corners (px)."""
    sel = FIT_SUBSETS[FIT_SUBSET] if npts == 16 else list(range(npts))
    Hp = fit_homography(unit_points(npts)[sel], pred_pts[sel])
    Hg = fit_homography(unit_points(4), gt_corners)
    return float(np.linalg.norm(apply_h(Hp, CELL_UV) - apply_h(Hg, CELL_UV), axis=1).mean())


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
                    # sources are "<batch>/<file>" since batch 8 (clip batches
                    # all number stills v00000.jpg..); older ones are bare
                    # names, which belong to the first batch that used them
                    idx[f"{f.name}/{g.name}"] = f.name
                    idx.setdefault(g.name, f.name)
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


def dump_native_window(photo: Path, meta: dict, sample, input_wh, k: int, out: Path) -> None:
    """The model's input window, cut from the native photo at k x the input size.
    The input is a uniform scale + offset of the photo (letterbox), so the map is
    fitted from one visible face's corners in both frames - no dataset internals."""
    _, conf, corners, valid, _ = sample
    wh = np.array(input_wh, dtype=np.float32)
    for f in range(6):
        if conf[f] < 0.5 or valid[f] < 0.5:
            continue
        nat = meta["faces"][FACE_ORDER[f]].get("corners")
        if not nat:
            continue
        a = corners[f].numpy() * wh          # input px
        b = np.array(nat, dtype=np.float64)  # native px (any cyclic order - centroid/scale suffice)
        scale = np.linalg.norm(b - b.mean(0), axis=1).mean() / max(np.linalg.norm(a - a.mean(0), axis=1).mean(), 1e-9)
        off = b.mean(0) - a.mean(0) * scale  # native = input * scale + off
        img = Image.open(photo).convert("RGB")
        x0, y0 = off
        x1, y1 = off + wh * scale
        # PIL crops outside the image with black; the letterbox pads grey
        canvas = Image.new("RGB", (int(round(x1 - x0)), int(round(y1 - y0))), (114, 114, 114))
        bx0, by0 = max(0, int(round(x0))), max(0, int(round(y0)))
        bx1, by1 = min(img.width, int(round(x1))), min(img.height, int(round(y1)))
        if bx1 > bx0 and by1 > by0:
            canvas.paste(img.crop((bx0, by0, bx1, by1)), (bx0 - int(round(x0)), by0 - int(round(y0))))
        canvas.resize((int(input_wh[0]) * k, int(input_wh[1]) * k), Image.BILINEAR).save(out)
        return


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt", default="runs/base/best.pt")
    ap.add_argument("--data", default="../data")
    ap.add_argument("--split", default="val", choices=["train", "val", "all"])
    ap.add_argument("--thresh", type=float, default=0.5,
                    help="center head: detection score counted as a detection")
    ap.add_argument("--photos", default="../../stephens_photos",
                    help="root holding the original photo batches, for the per-batch split")
    ap.add_argument("--min-edge", type=float, default=None,
                    help="faces whose longest edge is below this (input px) are out of "
                         "scanning range and are ignored entirely; default = the range floor "
                         "(MIN_FACE_EDGE_FRAC of the input height); 0 scores everything")
    ap.add_argument("--jitter", type=float, default=0.0,
                    help="crop view: per-side padding U(PAD_VAL-J, PAD_VAL+J) instead of exactly "
                         "PAD_VAL, simulating localizer error")
    ap.add_argument("--seed", type=int, default=0, help="for --jitter")
    ap.add_argument("--dump", default=None,
                    help="write every model input as PNG plus dump.json (pred/gt quads in input px, "
                         "corner-aligned) to this dir - the web refine bench reads it")
    ap.add_argument("--dump-scale", type=int, default=1,
                    help="with --dump, also write the same window cut from the NATIVE photo at this "
                         "multiple of the input size (the phone frame shows a face 1.5-2.5x bigger than "
                         "the 256 input does) as NNNNxK.png; quads scale by K")
    ap.add_argument("--fit", choices=list(FIT_SUBSETS), default="all",
                    help="grid checkpoints: which points the cell-centre homography is fitted to")
    args = ap.parse_args()
    global FIT_SUBSET
    FIT_SUBSET = args.fit

    device = "cuda" if torch.cuda.is_available() else "cpu"
    ckpt = torch.load(args.ckpt, map_location="cpu", weights_only=True)
    head = ckpt.get("head", "legacy")
    global INPUT_WH
    INPUT_WH = tuple(ckpt.get("input_wh", KP_WH))
    view = ckpt.get("view", "frame")
    if args.min_edge is None:
        args.min_edge = min_face_edge_px(INPUT_WH[1])
    model = build_model(head, pretrained=False, input_hw=(INPUT_WH[1], INPUT_WH[0]),
                        npts=ckpt.get("npts", 4)).to(device)
    model.load_state_dict(ckpt["model"])
    model.eval()
    npts = ckpt.get("npts", 4)
    perms = cyclic_perms(npts).numpy()
    pad = (PAD_VAL - args.jitter, PAD_VAL + args.jitter) if args.jitter else PAD_VAL
    print(f"head={head}  view={view} {INPUT_WH[0]}x{INPUT_WH[1]}  points={npts}  ckpt={args.ckpt}  "
          f"data={args.data} ({args.split})" + (f"  crop pad {pad}" if view == "crop" else ""))

    ds = CubeKeypointDataset(args.data, split=args.split, input_size=INPUT_WH, view=view, crop_pad=pad)
    if args.jitter:
        ds._rng = (__import__("os").getpid(), np.random.default_rng(args.seed))
    batches = batch_index(Path(args.photos))
    rows = []          # one per ground-truth visible face
    false_pos = 0
    dump_dir = Path(args.dump) if args.dump else None
    dump_rows = []
    if dump_dir:
        dump_dir.mkdir(parents=True, exist_ok=True)
    wh = np.array(INPUT_WH, dtype=np.float32)
    with torch.no_grad():
        for start in range(0, len(ds), 64):
            idxs = range(start, min(start + 64, len(ds)))
            batch = [ds.sample(i) for i in idxs]
            x = torch.stack([b[0] for b in batch]).to(device)
            pred = model(x)
            if head == "center":
                scores, pts = decode_maps(pred, input_wh=INPUT_WH, thresh=args.thresh, points=True)
                _, quads = decode_maps(pred, input_wh=INPUT_WH, thresh=args.thresh)
                scores = scores.cpu().numpy()
                quads_px = (quads.cpu() * torch.from_numpy(wh))
                det_c = quad_centers(quads_px).numpy()
                quads_px = quads_px.numpy()
                pts_px = (pts.cpu() * torch.from_numpy(wh)).numpy()
            else:
                p = pred.cpu().numpy()
            for j, i in enumerate(idxs):
                meta = json.loads(ds.files[i].read_text())
                if dump_dir:
                    arr = (x[j].cpu().numpy().transpose(1, 2, 0) * NORM_STD + NORM_MEAN) * 255
                    Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8)).save(dump_dir / f"{i:04d}.png")
                    if args.dump_scale > 1:
                        dump_native_window(ds.files[i].parent.parent / meta["image"], meta, batch[j], INPUT_WH,
                                           args.dump_scale, dump_dir / f"{i:04d}x{args.dump_scale}.png")
                style = meta.get("style", "?")
                batch_name = batches.get(meta.get("source", ""), "-")
                _, conf, corners, valid, geom = batch[j]
                # input px -> source px, and a face's long edge as a fraction
                # of the source frame height (orientation-free range bins)
                src = 1.0 / geom["scale"]
                src_h = geom["src_h"]
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
                        frac = float(e.max()) * src / src_h
                        base = {"size": float(np.sqrt(quad_area(gt_q[f]))), "style": style,
                                "face": FACE_ORDER[f], "batch": batch_name,
                                "maxEdge": float(e.max()), "src": src, "frac": frac,
                                "range": next((n for n, lo, hi in RANGE_BINS if lo <= frac < hi), "out"),
                                "squash": float(e.min() / max(e.max(), 1e-9)),
                                "far": bool(e.max() < args.min_edge)}
                        if f not in used_g:
                            rows.append({**base, "err": None, "rot": None, "score": None})
                            continue
                        d = used_g[f]
                        shifts = [np.roll(gt_q[f], r, axis=0) for r in range(4)]
                        errs = [float(np.linalg.norm(quads_px[j, d] - s, axis=1).mean()) for s in shifts]
                        r = int(np.argmin(errs))
                        # the full point set, in the rotation the corners picked
                        gt_pts = quad_grid_points(torch.from_numpy(gt_q[f]).double()).numpy() \
                            if npts != 4 else gt_q[f]
                        # np.roll(corners, r) == corners[cyclic_perms(4)[4-r]], and
                        # the grid perms are built from the same corner roll
                        gt_pts_r = gt_pts[perms[(4 - r) % 4]]
                        grid_err = float(np.linalg.norm(pts_px[j, d] - gt_pts_r, axis=1).mean())
                        cell_err = cell_centre_error(pts_px[j, d], shifts[r], npts)
                        rows.append({**base, "err": errs[r], "gridErr": grid_err, "cellErr": cell_err,
                                     "rot": abs(rotation_deg(quads_px[j, d], shifts[r])),
                                     "score": float(scores[j, d])})
                        if dump_dir:
                            dump_rows.append({"image": f"{i:04d}.png", "face": FACE_ORDER[f], "range": base["range"],
                                              "far": base["far"], "src": src, "err": errs[r],
                                              "pred": quads_px[j, d].tolist(), "gt": shifts[r].tolist()})
                else:
                    for f in gts:
                        pd = p[j, f, 1:].reshape(4, 2) * wh
                        errs = [float(np.linalg.norm(pd - np.roll(gt_q[f], r, axis=0), axis=1).mean())
                                for r in range(4)]
                        e = np.linalg.norm(gt_q[f] - np.roll(gt_q[f], -1, axis=0), axis=1)
                        frac = float(e.max()) * src / src_h
                        rows.append({"err": min(errs), "rot": None, "score": None,
                                     "size": float(np.sqrt(quad_area(gt_q[f]))), "style": style,
                                     "face": FACE_ORDER[f], "batch": batch_name,
                                     "maxEdge": float(e.max()), "src": src, "frac": frac,
                                     "range": next((n for n, lo, hi in RANGE_BINS if lo <= frac < hi), "out"),
                                     "squash": float(e.min() / max(e.max(), 1e-9)),
                                     "far": bool(e.max() < args.min_edge)})

    if dump_dir:
        (dump_dir / "dump.json").write_text(json.dumps({"inputWh": list(INPUT_WH), "faces": dump_rows}))
        print(f"dumped {len(dump_rows)} faces to {dump_dir}")

    out_of_range = [r for r in rows if r["far"]]
    if out_of_range:
        seen = len([r for r in out_of_range if r["err"] is not None])
        print(f"\nignored {len(out_of_range)} of {len(rows)} ground-truth faces as out of "
              f"scanning range (longest edge < {args.min_edge:.0f} px at {INPUT_WH[0]}x{INPUT_WH[1]} - "
              f"further than a person can hold a cube); the model happened to find {seen} of them")
    rows = [r for r in rows if not r["far"]]
    hit = [r for r in rows if r["err"] is not None]
    errs = np.array([r["err"] for r in hit])
    print(f"\nground-truth visible faces: {len(rows)}")
    if head == "center":
        tp, fn = len(hit), len(rows) - len(hit)
        print(f"matched {tp}   missed {fn}   false positives {false_pos}   "
              f"F1 {f1_from_counts(tp, false_pos, fn):.3f}   (score >= {args.thresh})")
    if not hit:
        raise SystemExit("nothing matched - the checkpoint detects nothing at this threshold")
    print(f"corner error over matched faces: mean {errs.mean():.2f} px  median {np.median(errs):.2f} px"
          f"  (input px at {INPUT_WH[0]}x{INPUT_WH[1]})")
    qs = [10, 25, 50, 75, 90, 95, 99]
    print("percentiles:", "  ".join(f"p{q} {np.percentile(errs, q):.2f}" for q in qs))
    src_errs = np.array([r["err"] * r["src"] for r in hit])
    print(f"in SOURCE px: mean {src_errs.mean():.2f}  median {np.median(src_errs):.2f}  "
          f"p90 {np.percentile(src_errs, 90):.2f}")
    if head == "center":
        ce = np.array([r["cellErr"] for r in hit])
        cs = np.array([r["cellErr"] * r["src"] for r in hit])
        fitted = f"{FIT_SUBSET} {len(FIT_SUBSETS[FIT_SUBSET])}" if npts == 16 else f"all {npts}"
        print(f"CELL-CENTRE error (9 sticker centres via a homography fitted to {fitted} points): "
              f"mean {ce.mean():.2f} px  median {np.median(ce):.2f} px  p90 {np.percentile(ce, 90):.2f} px"
              f"  | source px: mean {cs.mean():.2f}  median {np.median(cs):.2f}  p90 {np.percentile(cs, 90):.2f}")
        if npts != 4:
            ge = np.array([r["gridErr"] for r in hit])
            print(f"raw {npts}-point error: mean {ge.mean():.2f} px  median {np.median(ge):.2f} px  "
                  f"p90 {np.percentile(ge, 90):.2f} px  (corners alone: {errs.mean():.2f})")

    print("\nby range (longest edge / source frame height; the floor is "
          f"{MIN_FACE_EDGE_FRAC}):")
    for name, lo, hi in RANGE_BINS + [("out", -1, MIN_FACE_EDGE_FRAC)]:
        sel = [r for r in rows if r["range"] == name]
        if not sel:
            continue
        h = [r for r in sel if r["err"] is not None]
        e = np.array([r["err"] for r in h]) if h else np.array([np.nan])
        se = np.array([r["err"] * r["src"] for r in h]) if h else np.array([np.nan])
        cell = ""
        if head == "center" and h:
            cse = np.array([r["cellErr"] * r["src"] for r in h])
            cell = f"  cell-centre {np.nanmean(cse):6.2f} src px"
        print(f"  {name:4s} {lo:5.3f}-{min(hi, 9.999):5.3f}: n={len(sel):5d}  "
              f"mean {np.nanmean(e):6.2f} px ({np.nanmean(se):6.2f} src px)  "
              f"median {np.nanmedian(e):6.2f} px  missed {len(sel) - len(h)}{cell}")

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
