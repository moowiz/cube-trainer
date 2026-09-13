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
"""
from __future__ import annotations

import argparse

import numpy as np
import torch

from model import center_loss, center_metrics, decode_maps, f1_from_counts
from targets import build_center_targets, quad_areas, quad_centers

from shapes import KP_WH, grid_hw
INPUT_WH = KP_WH
GRID_HW = grid_hw(KP_WH)


def perfect_maps(t, b: int):
    """The maps a model with zero training error would produce."""
    maps = torch.zeros(b, 9, *GRID_HW)
    maps[:, 0] = torch.where(t.heat >= 1.0, torch.full_like(t.heat, 10.0),
                             torch.full_like(t.heat, -10.0))
    maps[:, 1:] = t.off.reshape(b, 8, *GRID_HW)
    return maps


def random_labels(b: int, rng: np.random.Generator):
    conf = torch.zeros(b, 6)
    valid = torch.zeros(b, 6)
    corners = torch.zeros(b, 6, 4, 2)
    for i in range(b):
        for f in range(rng.integers(1, 4)):
            cx, cy = rng.uniform(0.12, 0.88), rng.uniform(0.12, 0.88)
            s = rng.uniform(0.05, 0.32)
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


def check(conf, corners, valid, label: str) -> bool:
    b = conf.shape[0]
    t = build_center_targets(conf, corners, valid, GRID_HW, stats=True)
    npos = int(t.npos.item())
    maps = perfect_maps(t, b)

    loss, heat_loss, off_loss = center_loss(maps, t)
    err, matched, tp, fp, fn = center_metrics(maps, conf, corners, valid, INPUT_WH)
    mean_err = err / matched if matched else float("nan")
    f1 = f1_from_counts(tp, fp, fn)

    # every positive that did not collide with another face's cell must match
    expected = npos - t.collisions
    ok = (loss.item() < 1e-4 and matched >= expected and fp == 0
          and (matched == 0 or mean_err < 1e-3))
    print(f"[{label}] images {b}  positives {npos}  collisions {t.collisions}")
    print(f"  loss {loss.item():.2e} (heat {heat_loss.item():.2e}  off {off_loss.item():.2e})")
    print(f"  matched {matched}/{expected}  fp {fp}  fn {fn}  F1 {f1:.3f}  "
          f"mean corner err {mean_err:.2e} px")
    print("  " + ("OK" if ok else "FAIL"))
    return ok


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=None, help="also round-trip real labels from this root")
    ap.add_argument("--n", type=int, default=512, help="how many real samples to check")
    ap.add_argument("--trials", type=int, default=8)
    args = ap.parse_args()

    rng = np.random.default_rng(0)
    ok = True
    for i in range(args.trials):
        conf, corners, valid = random_labels(32, rng)
        ok &= check(conf, corners, valid, f"synthetic {i + 1}/{args.trials}")

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
        ok &= check(torch.from_numpy(ds.conf[:n]), torch.from_numpy(ds.corners[:n]),
                    torch.from_numpy(ds.valid[:n]), f"real labels from {args.data}")

    print("\nALL OK" if ok else "\nFAILED - fix targets/decode before training")
    raise SystemExit(0 if ok else 1)


if __name__ == "__main__":
    main()
