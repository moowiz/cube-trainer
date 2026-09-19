"""Round-trip check for the center head's targets, loss, decode and metrics.

    python check_targets.py            # synthetic quads
    python check_targets.py --data ../data --n 512   # real labels too

The invariant: build dense targets from labels, fabricate the maps a PERFECT
model would emit for those targets, and decode them back. The quads must
return exactly, the losses must be ~0, and every positive face must match
itself. Anything else means targets and decode disagree about the grid, the
half-cell offset, the channel order, or the cyclic corner convention — which
is exactly the class of bug that shows up later as "training won't go below
4 px" with no other symptom (PLAN section 1.6 gate 1).

Cheap and offline: no checkpoint, no GPU, a second or two. Run it after
touching targets.py, decode_maps, or center_metrics.

Both point counts are checked (4 corners and the 16-point seam grid), plus
the grid geometry itself: the homography returns the corners and the
diagonal centre, and `cyclic_perms(16)` agrees with rebuilding the grid from
rolled corners - the loss's rotation invariance depends on exactly that.
"""
from __future__ import annotations

import argparse

import numpy as np
import torch

from model import (
    TWIST_CH,
    TWIST_CLASSES,
    POINT_COUNTS,
    center_loss,
    center_metrics,
    decode_maps,
    f1_from_counts,
    twist_counts_zero,
    twist_summary,
)
from shapes import KP_WH, grid_hw
from targets import (
    GRID_CORNER_IDX,
    build_center_targets,
    cyclic_perms,
    quad_areas,
    quad_centers,
    quad_grid_points,
)

INPUT_WH = KP_WH
GRID_HW = grid_hw(KP_WH)


def perfect_maps(t, b: int):
    """The maps a model with zero training error would produce."""
    P = t.off.shape[1]
    maps = torch.zeros(b, 1 + 2 * P, *GRID_HW)
    maps[:, 0] = torch.where(t.heat >= 1.0, torch.full_like(t.heat, 10.0),
                             torch.full_like(t.heat, -10.0))
    maps[:, 1:] = t.off.reshape(b, 2 * P, *GRID_HW)
    return maps


def random_labels(b: int, rng: np.random.Generator):
    conf = torch.zeros(b, 6)
    valid = torch.zeros(b, 6)
    corners = torch.zeros(b, 6, 4, 2)
    for i in range(b):
        placed: list[tuple[float, float, float]] = []
        for f in range(rng.integers(1, 4)):
            # Faces of one cube never overlap: two visible faces' centres sit
            # about one edge apart. decode_maps deduplicates candidates within
            # CENTER_DEDUPE_FRAC (0.5) of a kept quad's mean edge, so random
            # quads dropped on top of each other would be merged by design,
            # not by a bug - keep centres >= 0.75 edge apart.
            for _ in range(50):
                cx, cy = rng.uniform(0.12, 0.88), rng.uniform(0.12, 0.88)
                s = rng.uniform(0.05, 0.32)
                if all(np.hypot(cx - px, cy - py) >= 0.75 * 2 * max(s, ps) for px, py, ps in placed):
                    break
            else:
                continue
            placed.append((cx, cy, s))
            # a random projective-ish quad, not an axis-aligned square: the
            # diagonal-intersection center and the cyclic corner minimum both
            # have to survive shear and rotation
            ang = rng.uniform(0, 2 * np.pi)
            base = np.array([[-s, -s], [s, -s * rng.uniform(0.6, 1.4)],
                             [s * rng.uniform(0.6, 1.4), s], [-s, s]])
            rot = np.array([[np.cos(ang), -np.sin(ang)], [np.sin(ang), np.cos(ang)]])
            corners[i, f] = torch.tensor(base @ rot.T + [cx, cy], dtype=torch.float32)
            conf[i, f] = 1.0
            valid[i, f] = 1.0
    return conf, corners, valid


def check(conf, corners, valid, label: str, npts: int = 4) -> bool:
    b = conf.shape[0]
    t = build_center_targets(conf, corners, valid, GRID_HW, stats=True, npts=npts)
    npos = int(t.npos.item())
    maps = perfect_maps(t, b)

    loss, heat_loss, off_loss, _, _ = center_loss(maps, t)
    err, matched, tp, fp, fn = center_metrics(maps, conf, corners, valid, INPUT_WH)
    mean_err = err / matched if matched else float("nan")
    f1 = f1_from_counts(tp, fp, fn)

    # every positive that did not collide with another face's cell must match
    expected = npos - t.collisions
    ok = (loss.item() < 1e-4 and matched >= expected and fp == 0
          and (matched == 0 or mean_err < 1e-3))
    # the full point set must come back too, up to the cyclic rotation the
    # target was stored in (decode has no way to know the labeled start)
    grid_err = float("nan")
    if npts != 4 and matched:
        scores, pts = decode_maps(maps, input_wh=INPUT_WH, thresh=0.5, points=True)
        gt_pts = quad_grid_points(corners)                           # (B,6,16,2) normalized
        perms = cyclic_perms(npts)
        gt_c = quad_centers(corners)
        worst = 0.0
        for i in range(b):
            for d in range(scores.shape[1]):
                if scores[i, d] <= 0:
                    continue
                c = quad_centers(pts[i, d][list(GRID_CORNER_IDX)])
                f = int((gt_c[i] - c).norm(dim=-1).argmin())
                e = min(float(((pts[i, d] - gt_pts[i, f][perms[k]]) * torch.tensor(INPUT_WH))
                              .norm(dim=-1).mean()) for k in range(4))
                worst = max(worst, e)
        grid_err = worst
        ok &= worst < 1e-3
    print(f"[{label}] npts {npts}  images {b}  positives {npos}  collisions {t.collisions}")
    print(f"  loss {loss.item():.2e} (heat {heat_loss.item():.2e}  off {off_loss.item():.2e})")
    print(f"  matched {matched}/{expected}  fp {fp}  fn {fn}  F1 {f1:.3f}  "
          f"mean corner err {mean_err:.2e} px"
          + (f"  worst grid-point err {grid_err:.2e} px" if npts != 4 else ""))
    print("  " + ("OK" if ok else "FAIL"))
    return ok


def check_grid_geometry(rng: np.random.Generator) -> bool:
    """quad_grid_points returns the corners and the diagonal centre, and the
    cyclic permutation of the grid equals the grid of the rolled quad."""
    _, corners, _ = random_labels(64, rng)
    q = corners.reshape(-1, 4, 2)
    q = q[(q.abs().sum(dim=(1, 2)) > 0)]
    g = quad_grid_points(q)                                          # (N,16,2)
    ok = torch.allclose(g[:, list(GRID_CORNER_IDX)], q, atol=1e-5)
    # centre of the unit square is (1.5, 1.5) in grid index space; sample it
    # directly through the homography via a 3x3 grid instead
    g3 = quad_grid_points(q, n=3)
    ok &= torch.allclose(g3[:, 4], quad_centers(q), atol=1e-5)
    perms = cyclic_perms(16)
    worst = 0.0
    for k in range(4):
        rolled = quad_grid_points(q.roll(-k, dims=1))
        worst = max(worst, float((rolled - g[:, perms[k]]).abs().max()))
    ok &= worst < 1e-5
    # the four permutations are distinct and each is a bijection
    ok &= len({tuple(p.tolist()) for p in perms}) == 4
    ok &= all(sorted(p.tolist()) == list(range(16)) for p in perms)
    print(f"[grid geometry] {q.shape[0]} quads: corners/centre round-trip {'OK' if ok else 'FAIL'}, "
          f"perm-vs-rolled worst {worst:.1e}")
    return bool(ok)


def random_twists(b: int, rng: np.random.Generator) -> torch.Tensor:
    """(b,2) twist labels: a third flush, a few unknown, the rest a random
    face at a random angle, some with the angle unknown."""
    tw = torch.zeros(b, 2)
    for i in range(b):
        r = rng.random()
        if r < 0.3:
            tw[i] = torch.tensor([-1.0, float("nan")])
        elif r < 0.35:
            tw[i] = torch.tensor([-2.0, float("nan")])
        else:
            deg = float(rng.uniform(-90, 90))
            tw[i] = torch.tensor([float(rng.integers(0, 6)), float("nan") if rng.random() < 0.15 else deg])
    return tw


def check_twist(b: int, rng: np.random.Generator, shift: int) -> int:
    """Perfect twist maps decode back to the labels - under every cyclic
    shift of the corner order: a quad decoded starting from corner `shift`
    must be scored against the class as seen from there (the loss's
    argmin-shift and the metric's best-roll must agree with targets'
    shift_twist_class)."""
    conf, corners, valid = random_labels(b, rng)
    twist = random_twists(b, rng)
    t = build_center_targets(conf, corners, valid, GRID_HW, twist=twist)
    P = t.off.shape[1]
    perms = cyclic_perms(P)
    maps = torch.zeros(b, 1 + 2 * P + TWIST_CH, *GRID_HW)
    maps[:, 0] = torch.where(t.heat >= 1.0, torch.full_like(t.heat, 10.0), torch.full_like(t.heat, -10.0))
    maps[:, 1:1 + 2 * P] = t.off[:, perms[shift]].reshape(b, 2 * P, *GRID_HW)
    c0 = 1 + 2 * P
    onehot = torch.nn.functional.one_hot(t.tw_cls[:, shift], TWIST_CLASSES).permute(0, 3, 1, 2).float()
    maps[:, c0:c0 + TWIST_CLASSES] = onehot * 12.0
    maps[:, c0 + TWIST_CLASSES:c0 + TWIST_CH] = t.tw_ang
    bad = 0
    loss, heat_loss, off_loss, cls_loss, ang_loss = center_loss(maps, t)
    if float(cls_loss) > 1e-3 or float(ang_loss) > 1e-6:
        print(f"  shift {shift}: twist losses on perfect maps: cls {float(cls_loss):.5f} ang {float(ang_loss):.6f}")
        bad += 1
    twc = twist_counts_zero()
    center_metrics(maps, conf, corners, valid, INPUT_WH, twist_t=twist, twist_counts=twc)
    summ = twist_summary(twc)
    known_faces = int(((conf > 0.5) & (valid > 0.5)).sum())
    if twc["n"] == 0 or summ["tw_f1"] < 1.0 or summ["tw_cls"] < 1.0 or summ["tw_deg"] > 0.05:
        print(f"  shift {shift}: twist metrics on perfect maps: {summ} counts {twc}")
        bad += 1
    print(f"  shift {shift}: {twc['n']} faces scored of {known_faces} labelled, {twc['twisted']} twisted, "
          f"{twc['n_ang']} with an angle: f1 {summ['tw_f1']:.3f} cls {summ['tw_cls']:.3f} "
          f"deg {summ['tw_deg']:.3f}, losses cls {float(cls_loss):.5f} ang {float(ang_loss):.6f}")
    return bad


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=None, help="also round-trip real labels from this root")
    ap.add_argument("--n", type=int, default=512, help="how many real samples to check")
    ap.add_argument("--trials", type=int, default=8)
    args = ap.parse_args()

    rng = np.random.default_rng(0)
    ok = check_grid_geometry(rng)
    print("[twist] perfect twist maps under each cyclic corner shift (M13)")
    for shift in range(4):
        ok &= check_twist(48, np.random.default_rng(100 + shift), shift) == 0
    for i in range(args.trials):
        conf, corners, valid = random_labels(32, rng)
        for npts in POINT_COUNTS:
            ok &= check(conf, corners, valid, f"synthetic {i + 1}/{args.trials}", npts=npts)

    # geometry sanity that does not depend on the maps at all
    q = torch.tensor([[[[0.0, 0.0], [4.0, 1.0], [5.0, 5.0], [1.0, 4.0]]]])
    c = quad_centers(q)[0, 0]
    a = quad_areas(q)[0, 0]
    print(f"[geometry] diagonal intersection {c.tolist()} (expect ~[2.5, 2.5]), area {a:.3f} (expect 15.0)")
    ok &= bool(torch.allclose(c, torch.tensor([2.5, 2.5]), atol=1e-5) and abs(a - 15.0) < 1e-4)

    if args.data:
        from dataset import CubeKeypointDataset
        ds = CubeKeypointDataset(args.data, split="val", input_size=INPUT_WH)
        n = min(args.n, len(ds))
        for npts in POINT_COUNTS:
            ok &= check(torch.from_numpy(ds.conf[:n]), torch.from_numpy(ds.corners[:n]),
                        torch.from_numpy(ds.valid[:n]), f"real labels from {args.data}", npts=npts)

    print("\nALL OK" if ok else "\nFAILED - fix targets/decode before training")
    raise SystemExit(0 if ok else 1)


if __name__ == "__main__":
    main()
