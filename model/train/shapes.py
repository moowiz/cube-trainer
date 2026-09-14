"""The one place the model input shapes and the scanning-range floor live.

Design: model/PORTRAIT-DESIGN.md (decisions final 2026-09-12). Two models,
always two stages, no full-frame stage 2 anywhere:

    cubebox (stage 1)  120x160 portrait - the whole 480x640 phone frame at
                       scale 0.25, no bars; desktop 640x480 webcams get
                       top/bottom bars (that is the `_bars` augmentation).
    facekp  (stage 2)  256x256 square - the padded silhouette crop stage 1
                       hands over. Cube silhouettes have aspect ~1.00, so the
                       crop is square and so is the input; on a 480x640 frame
                       the padded crop is ~215 px at the range floor and
                       260 / 488 / 689 px at p5 / p50 / p95, so 256 takes the
                       far end without upscaling and downsamples the rest.

Every script imports these instead of carrying its own INPUT_WH; eval and
export read `ckpt["input_wh"]` / `ckpt["view"]` so a checkpoint is
self-describing. All tuples are (w, h).
"""
from __future__ import annotations

BOX_WH = (120, 160)          # stage-1 input, portrait
KP_WH = (256, 256)           # stage-2 input, square crop
FRAME_CACHE_WH = (240, 320)  # stage-1 cache: 480x640 letterboxed exactly, pooled by 2 -> BOX_WH
CROP_CACHE_WH = (320, 320)   # stage-2 cache: one padded silhouette crop per image, from the native image
STRIDE = 16

# The scanning-range floor, as a fraction of the SOURCE FRAME HEIGHT and so
# orientation-free: arm's-reach longest face edge measured 0.153 of the
# frame height on the calibration photos (98 px on 480x640); the floor sits
# ~13% under it so nothing a person can actually reach is thrown away.
# Applied as an ignore band in targets.py (in model px, derived from the
# input height), as the stage-1 in-range test on the silhouette's long side,
# and in web/src/color.ts MIN_FACE_EDGE_FRAC compared in source px.
MIN_FACE_EDGE_FRAC = 0.133

# Stage-2 crop geometry. The app pads stage 1's box by PAD_VAL per side
# (web twostage.ts CROP_PAD - keep them equal, val is scored at this pad);
# 0.45 -> 0.20 on 2026-09-13: same model px, 18% fewer source px, +F1
# (diagnose.py --pad). Training re-crops the cached loose crop with
# per-side padding U(PAD_TRAIN) - negative = the localizer clipped the cube,
# which its per-edge sd of 0.08-0.14 says happens. The cache itself holds a
# looser crop, U(CACHE_PAD) per side, so the same image can be re-cropped
# differently every epoch and the far end of the range keeps native pixels.
PAD_VAL = 0.20
PAD_TRAIN = (-0.10, 0.45)
CACHE_PAD = (0.20, 0.70)


def grid_hw(wh: tuple[int, int], stride: int = STRIDE) -> tuple[int, int]:
    """Stride-`stride` feature grid (H, W) for a (w, h) input."""
    return (wh[1] // stride, wh[0] // stride)


def min_face_edge_px(input_h: float) -> float:
    """The range floor in the pixels of an input `input_h` tall: 34 px at
    256 (crops: only masks the sliver of a third face at the edge of a loose
    crop), 42.6 px at 320, 85 px on a 480x640 phone frame."""
    return MIN_FACE_EDGE_FRAC * input_h
