"""Conventions of the twist labels (M13), checked against the cube geometry.

    python check_twist.py                 # geometry only, a second
    python check_twist.py --data ../preview_twist   # plus a label audit

Three facts every consumer of `label.twist` leans on, derived here from the
face corner tables rather than trusted from a comment:

1. NEIGHBOUR[f][k] - the face across edge k (corner k -> corner k+1) of
   face f in the label's corner order (TL, TR, BR, BL of the cubejs sticker
   layout). targets.py turns "face X is turning" into per-quad classes with
   it; gen/visualize.mjs draws arrows with it.
2. The sign: the label's `deg` is clockwise seen from outside the turning
   face, and the generator derives it as -(layer * angle_about_+axis).
3. The direction claim behind the per-quad angle: when the turning layer
   turns clockwise (deg > 0), the bordering row on EVERY neighbour moves
   from corner k+1 toward corner k of that neighbour's own quad. By the
   cube's 4-fold symmetry about the turning axis it holds for all four
   neighbours if it holds for one; checked for all 6 x 4 anyway.

Same corner tables as gen/scene.mjs FACE_DATA (cube coordinates, +x = the
red face R, +y = white U, +z = green F).
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import numpy as np

from targets import NEIGHBOUR, TWIST_FACES

FACE_DATA = {
    "U": {"n": (0, 1, 0), "corners": [(-1, 1, -1), (1, 1, -1), (1, 1, 1), (-1, 1, 1)]},
    "R": {"n": (1, 0, 0), "corners": [(1, 1, 1), (1, 1, -1), (1, -1, -1), (1, -1, 1)]},
    "F": {"n": (0, 0, 1), "corners": [(-1, 1, 1), (1, 1, 1), (1, -1, 1), (-1, -1, 1)]},
    "D": {"n": (0, -1, 0), "corners": [(-1, -1, 1), (1, -1, 1), (1, -1, -1), (-1, -1, -1)]},
    "L": {"n": (-1, 0, 0), "corners": [(-1, 1, -1), (-1, 1, 1), (-1, -1, 1), (-1, -1, -1)]},
    "B": {"n": (0, 0, -1), "corners": [(1, 1, -1), (-1, 1, -1), (-1, -1, -1), (1, -1, -1)]},
}
AXES = {"x": 0, "y": 1, "z": 2}


def face_of_normal(n) -> str:
    return next(f for f, d in FACE_DATA.items() if tuple(d["n"]) == tuple(n))


def rotation(axis: np.ndarray, rad: float) -> np.ndarray:
    """Right-hand rotation matrix about unit `axis` (Rodrigues)."""
    x, y, z = axis
    c, s, C = math.cos(rad), math.sin(rad), 1 - math.cos(rad)
    return np.array([[c + x * x * C, x * y * C - z * s, x * z * C + y * s],
                     [y * x * C + z * s, c + y * y * C, y * z * C - x * s],
                     [z * x * C - y * s, z * y * C + x * s, c + z * z * C]])


def derived_neighbour() -> dict[str, list[str]]:
    """Across edge k lies the face whose normal both of the edge's corners
    share (a corner of face f touching face g has coordinate +-1 on g's
    axis with g's sign)."""
    out: dict[str, list[str]] = {}
    for f, d in FACE_DATA.items():
        n = np.array(d["n"])
        row = []
        for k in range(4):
            a, b = np.array(d["corners"][k]), np.array(d["corners"][(k + 1) % 4])
            shared = [(i, int(a[i])) for i in range(3) if a[i] == b[i] and n[i] == 0]
            assert len(shared) == 1, (f, k, shared)
            i, sgn = shared[0]
            g = [0, 0, 0]
            g[i] = sgn
            row.append(face_of_normal(g))
        out[f] = row
    return out


def check_geometry() -> int:
    bad = 0
    # 1. the adjacency table
    got = derived_neighbour()
    for f in FACE_DATA:
        if got[f] != NEIGHBOUR[f]:
            print(f"NEIGHBOUR[{f}] is {NEIGHBOUR[f]}, geometry says {got[f]}")
            bad += 1
    assert TWIST_FACES == "URFDLB"
    # 2 + 3. every (turning face, clockwise angle) moves every neighbour's
    # bordering row from corner k+1 toward corner k
    for axis, ai in AXES.items():
        for layer in (-1, 1):
            n = np.zeros(3)
            n[ai] = layer
            face = face_of_normal(n)
            for cw_deg in (20.0, 45.0, 70.0):
                # the generator: angle about +axis; label deg = -(layer * angle)
                angle = -cw_deg / layer
                R = rotation(np.eye(3)[ai], math.radians(angle))
                # (2) that rotation is clockwise from outside: a point on the
                # face at "12 o'clock" of an outside viewer moves toward 3
                # o'clock. Build the viewer's frame: looking along -n, with
                # `up` any perpendicular; right = up x (-n) ... clockwise from
                # the viewer means the rotation about the viewing direction
                # (-n) is right-handed, i.e. about n it is left-handed.
                up = np.eye(3)[(ai + 1) % 3]
                p = up.copy()
                q = R @ p
                # right-handed about n would give (n x p) . q > 0; clockwise
                # from outside is the opposite
                if np.dot(np.cross(n, p), q) >= 0:
                    print(f"{face}: deg {cw_deg} is not clockwise from outside")
                    bad += 1
                for g in FACE_DATA:
                    if g == face or NEIGHBOUR[g].count(face) == 0:
                        continue
                    k = NEIGHBOUR[g].index(face)
                    cg = [np.array(c, dtype=float) for c in FACE_DATA[g]["corners"]]
                    # the bordering row's middle sticker centre on face g
                    # (an edge cubie: 1 from centre along the shared axis, on
                    # g's surface), rotated with the layer
                    centre_g = np.array(FACE_DATA[g]["n"], dtype=float) * 1.5
                    row_mid = centre_g + n * 1.0
                    moved = R @ row_mid
                    to_k = cg[k] - row_mid
                    to_k1 = cg[(k + 1) % 4] - row_mid
                    disp = moved - row_mid
                    # projected onto the edge direction (k+1 -> k)
                    e = to_k - to_k1
                    e /= np.linalg.norm(e)
                    along = float(np.dot(disp, e))
                    if along <= 1e-6:
                        print(f"{face} cw {cw_deg}: {g}'s row along edge {k} moved {along:+.3f} "
                              f"(toward corner {k} expected)")
                        bad += 1
    print("geometry: " + ("OK" if not bad else f"{bad} problems"))
    return bad


def audit_labels(root: Path) -> None:
    files = sorted((root / "labels").glob("*.json"))
    modes: dict[str, int] = {}
    n_twist = n_blur = n_focus = n_neg = 0
    degs = []
    for f in files:
        lbl = json.loads(f.read_text())
        tw = lbl.get("twist")
        if lbl.get("meta", {}).get("negative"):
            n_neg += 1
            assert tw is None, f"{f.name}: a negative with a twist label"
        if not tw:
            continue
        assert tw["face"] in FACE_DATA, f
        assert -90 <= tw["deg"] <= 90, f
        modes[tw["mode"]] = modes.get(tw["mode"], 0) + 1
        n_twist += 1
        n_blur += tw.get("blurDeg", 0) > 0
        n_focus += lbl["meta"].get("handFocus") is not None
        degs.append(abs(tw["deg"]))
        # the turning face's quad is the rotated layer: its corners must not
        # coincide with the body-frame corners its neighbours still use
        vis = [g for g in FACE_DATA if lbl["faces"][g]["visible"]]
        if tw["face"] in vis and abs(tw["deg"]) > 5:
            tf = np.array(lbl["faces"][tw["face"]]["corners"])
            for g in vis:
                if g == tw["face"]:
                    continue
                ng = np.array(lbl["faces"][g]["corners"])
                d = min(np.linalg.norm(a - b) for a in tf for b in ng)
                if d < 0.5:
                    print(f"{f.name}: turning face {tw['face']} shares a corner with {g} at {tw['deg']} deg "
                          f"- body-frame convention broken?")
    print(f"labels: {len(files)} files, {n_neg} negatives, {n_twist} twisted {modes}, "
          f"{n_blur} blurred, {n_focus} with a hand on the layer"
          + (f", |deg| median {np.median(degs):.1f}" if degs else ""))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=None, help="a generated root to audit as well")
    args = ap.parse_args()
    bad = check_geometry()
    if args.data:
        audit_labels(Path(args.data))
    raise SystemExit(1 if bad else 0)
