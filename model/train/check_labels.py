"""Consistency-check hand labels (M5) before importing them.

Corner labels are order-free up to rotation (click around the face from any
starting corner, either direction), so instead of checking index-level order
this verifies what still must hold geometrically:

  - each quad is simple and convex (a zigzag click order makes a bowtie);
  - two labeled faces that share a cube edge share exactly two corner
    positions, and those two corners are consecutive in BOTH quads (a real
    edge, not a diagonal);
  - two opposite faces are never both visible.

    python check_labels.py --labels path/to/labels-all.json
"""
from __future__ import annotations

import argparse
import json
from itertools import combinations
from pathlib import Path

import numpy as np

# Cube-space corner coordinates per face (from model/gen/scene.mjs FACE_DATA).
# Only used to decide which faces are adjacent (share 2 cube corners) versus
# opposite (share none) - index order no longer matters for checking.
FACE_CORNERS = {
    "U": [(-1, 1, -1), (1, 1, -1), (1, 1, 1), (-1, 1, 1)],
    "R": [(1, 1, 1), (1, 1, -1), (1, -1, -1), (1, -1, 1)],
    "F": [(-1, 1, 1), (1, 1, 1), (1, -1, 1), (-1, -1, 1)],
    "D": [(-1, -1, 1), (1, -1, 1), (1, -1, -1), (-1, -1, -1)],
    "L": [(-1, 1, -1), (-1, 1, 1), (-1, -1, 1), (-1, -1, -1)],
    "B": [(1, 1, -1), (-1, 1, -1), (-1, -1, -1), (1, -1, -1)],
}


def face_size(c):
    c = np.asarray(c, dtype=float)
    return float(np.sqrt(abs(
        0.5 * ((c[:, 0] * np.roll(c[:, 1], -1) - np.roll(c[:, 0], -1) * c[:, 1]).sum()))))


def is_convex_simple(c) -> bool:
    """All cross products of consecutive edges share one sign. A projected
    cube face is always convex; mixed signs mean a zigzag/bowtie click order."""
    c = np.asarray(c, dtype=float)
    e = np.roll(c, -1, axis=0) - c
    cross = e[:, 0] * np.roll(e, -1, axis=0)[:, 1] - e[:, 1] * np.roll(e, -1, axis=0)[:, 0]
    return bool(np.all(cross > 0) or np.all(cross < 0))


def adjacent(a: str, b: str) -> bool:
    return len(set(FACE_CORNERS[a]) & set(FACE_CORNERS[b])) == 2


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--labels", required=True)
    ap.add_argument("--tol", type=float, default=0.06, help="shared-corner tolerance as fraction of face size")
    args = ap.parse_args()
    entries = json.loads(Path(args.labels).read_text())
    if isinstance(entries, dict):
        entries = [entries]

    checked = bad = 0
    for e in entries:
        vis = {f: fd["corners"] for f, fd in e["faces"].items() if fd["visible"] and fd.get("corners")}
        for f, c in vis.items():
            checked += 1
            if not is_convex_simple(c):
                bad += 1
                print(f"{e['image']}: {f} quad is not convex - corners were "
                      f"clicked in a zigzag, go around the face instead")
        for a, b in combinations(vis, 2):
            if not adjacent(a, b):
                print(f"{e['image']}: {a} and {b} are OPPOSITE faces - both visible is impossible")
                bad += 1
                continue
            size = (face_size(vis[a]) + face_size(vis[b])) / 2
            ca, cb = np.asarray(vis[a], float), np.asarray(vis[b], float)
            d = np.linalg.norm(ca[:, None, :] - cb[None, :, :], axis=-1)
            matches = [(i, j) for i in range(4) for j in range(4) if d[i, j] <= args.tol * size]
            checked += 1
            if len(matches) != 2:
                bad += 1
                near = sorted(((d[i, j], i, j) for i in range(4) for j in range(4)))[:2]
                gaps = ", ".join(f"{a}[{i}]~{b}[{j}] {dd:.0f}px" for dd, i, j in near)
                print(f"{e['image']}: {a} and {b} share a cube edge but have "
                      f"{len(matches)} coincident corner(s) instead of 2 "
                      f"(tol {args.tol * size:.0f} px; closest: {gaps}) - check placement/snapping")
                continue
            (i1, j1), (i2, j2) = matches
            if (i2 - i1) % 4 not in (1, 3) or (j2 - j1) % 4 not in (1, 3):
                bad += 1
                print(f"{e['image']}: shared corners of {a} and {b} are diagonal "
                      f"within a quad ({a}[{i1},{i2}] / {b}[{j1},{j2}]) - a quad's "
                      f"corners are out of order")
    print(f"\n{checked} checks, {bad} problems")
    if bad:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
