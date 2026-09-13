"""Grid-prior verification of a labeled/predicted face quad (M5 tooling).

A correct quad, homography-warped to a square, puts the dark seams between
cubies at exactly 1/3 and 2/3 in both directions, and its center cell is the
face's center sticker. This module scores both facts:

  - seam alignment: gradient-energy profiles of the warped face should peak
    near 30 and 60 (of 90). Catches quads that clip into a neighboring face,
    off-by-one-sticker placements, and generally sloppy corners.
  - center color: the median color of the center cell (sampled off-center to
    dodge the GAN logo cap on white) should match the face letter. Catches
    identity errors like a red-center face labeled U.

Seams can be unresolvable (deep shadow, blowout): the checker reports
"unverifiable" rather than guessing - it is a validator, not an oracle.
"""
from __future__ import annotations

import numpy as np
from PIL import Image

WARP = 90  # px, matches the pipeline's rectified face size

# hue centers per face letter; U is the low-saturation case
_HUES = {"R": 355, "L": 25, "D": 55, "F": 130, "B": 220}


def warp_face(img: Image.Image, corners) -> np.ndarray:
    """Warp the quad to WARPxWARP RGB float array. Corner order only needs to
    go around the face (PIL QUAD maps NW,SW,SE,NE of output to the given
    source points; any consistent rotation just rotates the grid, which the
    thirds-prior is invariant to)."""
    c = list(corners)
    quad = [c[0][0], c[0][1], c[3][0], c[3][1], c[2][0], c[2][1], c[1][0], c[1][1]]
    w = img.transform((WARP, WARP), Image.Transform.QUAD, quad, resample=Image.Resampling.BILINEAR)
    return np.asarray(w.convert("RGB"), dtype=np.float32)


def seam_score(face: np.ndarray) -> tuple[float, float]:
    """(score, strength). score >1 means gradient energy concentrates at the
    thirds; strength is the absolute seam contrast (low = unverifiable)."""
    gray = face.mean(axis=2)
    scores = []
    strengths = []
    for axis in (0, 1):
        grad = np.abs(np.diff(gray, axis=axis)).mean(axis=1 - axis)  # profile along `axis`
        prof = grad[4:-4]
        idx = np.arange(len(prof)) + 4
        at_thirds = prof[(np.abs(idx - 30) <= 4) | (np.abs(idx - 60) <= 4)]
        elsewhere = prof[(np.abs(idx - 30) > 7) & (np.abs(idx - 60) > 7)]
        scores.append(float(at_thirds.mean() / max(elsewhere.mean(), 1e-6)))
        strengths.append(float(at_thirds.mean()))
    return min(scores), min(strengths)


def center_color(face: np.ndarray) -> str:
    """Classify the center cell from 5 patches (4 off-center to dodge the
    GAN logo cap, plus dead-center). Conservative by design: a chromatic
    verdict needs >=3 agreeing chromatic votes - shadows and warm casts must
    produce 'white'/'dark' (no verdict), never a false identity flag."""
    pts = [(38, 38), (52, 38), (38, 52), (52, 52), (45, 45)]
    votes = []
    for x, y in pts:
        r, g, b = face[y - 2:y + 3, x - 2:x + 3].reshape(-1, 3).mean(axis=0) / 255
        mx, mn = max(r, g, b), min(r, g, b)
        if mx < 0.13:
            votes.append("dark")
        elif (mx - mn) / mx < 0.30:
            votes.append("white")
        else:
            if mx == r:
                h = 60 * (((g - b) / (mx - mn)) % 6)
            elif mx == g:
                h = 60 * ((b - r) / (mx - mn) + 2)
            else:
                h = 60 * ((r - g) / (mx - mn) + 4)
            votes.append(min(_HUES, key=lambda f: min(abs(h - _HUES[f]), 360 - abs(h - _HUES[f]))))
    vals, counts = np.unique(votes, return_counts=True)
    top = str(vals[np.argmax(counts)])
    if top not in ("white", "dark") and counts.max() < 3:
        return "white"  # chromatic but not confidently agreed: no verdict
    return top


def check_face(img: Image.Image, letter: str, corners,
               seam_min: float = 1.25, strength_min: float = 4.0):
    """Returns (ok: bool | None, reason). None = unverifiable (don't block)."""
    face = warp_face(img, corners)
    score, strength = seam_score(face)
    col = center_color(face)
    expect = "white" if letter == "U" else letter
    ident_ok = (col == expect) or (letter == "U" and col == "B") or col == "dark"
    #                     (logo cap can read blue)      (shadow: no verdict)
    if strength < strength_min:
        return None, f"seams unverifiable (contrast {strength:.1f})"
    if score < seam_min:
        return False, f"seams misaligned (score {score:.2f} < {seam_min}) - quad likely clips a neighbor or is offset"
    if col == "dark":
        return None, "center too dark to classify"
    if not ident_ok:
        return False, f"center cell reads {col}, but face is labeled {letter} ({expect})"
    return True, f"seams {score:.2f}, center {col}"
