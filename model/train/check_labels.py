"""Consistency-check hand labels (M5) before importing them.

Two labeled faces that share a cube edge must share two corner positions,
and the corner ORDER convention dictates exactly which index of one face
coincides with which index of the other. A misordered face shows up here as
a huge distance on a supposedly-shared corner - much more reliable than
eyeballing overlays.

    python check_labels.py --labels path/to/labels-all.json
"""
from __future__ import annotations

import argparse
import json
from itertools import combinations
from pathlib import Path

import numpy as np

# Corner coordinates per face in cube space (TL,TR,BR,BL of each face's
# sticker layout) - copied from model/gen/scene.mjs FACE_DATA, the single
# source of truth for the labeling convention.
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
        for a, b in combinations(vis, 2):
            shared = [
                (i, j)
                for i, ca in enumerate(FACE_CORNERS[a])
                for j, cb in enumerate(FACE_CORNERS[b])
                if ca == cb
            ]
            if not shared:  # opposite faces - both visible would itself be odd
                print(f"{e['image']}: {a} and {b} are OPPOSITE faces - both visible is impossible")
                bad += 1
                continue
            size = (face_size(vis[a]) + face_size(vis[b])) / 2
            for i, j in shared:
                d = float(np.hypot(*(np.subtract(vis[a][i], vis[b][j]))))
                checked += 1
                if d > args.tol * size:
                    bad += 1
                    print(f"{e['image']}: {a}[{i}] and {b}[{j}] should be the same physical corner "
                          f"but are {d:.0f} px apart ({100 * d / size:.0f}% of face size) - check corner order")
    print(f"\n{checked} shared corners checked, {bad} problems")
    if bad:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
