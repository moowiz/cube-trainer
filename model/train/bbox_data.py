"""Datasets for the stage-1 cube localizer (bbox at BOX_WH = 120x160 portrait).

Two sources, one sample contract: (image CHW normalized like FaceKP,
objectness float, bbox [cx, cy, w, h] normalized to [0,1], box_valid float).

- SynthBBox wraps CubeKeypointDataset(view="frame"): bbox = hull of the
  visible faces' corner labels (free supervision from the corner data, incl.
  real photos in data_real). Hard negatives (no cube) come through as
  objectness 0. box_valid is always 1: these labels ARE the silhouette
  convention.
- CocoBBox reads a Roboflow COCO export dir (all its classes mean "a cube";
  largest box wins if several). Real-world variety stage 2 can't use -
  other people's cubes, rooms, and lighting.
  **box_valid defaults to 0**: audited 2026-09-12 against the stage-2
  keypoint silhouette on 393 of its images, those human boxes sit at median
  IoU 0.756 with the silhouette and run 16% wide, 71% of them below IoU 0.8.
  They are a different labelling convention, and at --coco-rep 8 they were
  ~29% of the mixture, i.e. the regressor was fit to a blend of two
  conventions. Keep them for objectness ("a cube exists, in a real room"),
  which is what they were actually good for, and take extent from the
  silhouette labels only. `--coco-box` puts their box loss back.
- NegDir: a flat directory of no-cube photos (COCO val2017), objectness 0.

Geometry (PORTRAIT-DESIGN.md section 1): the input is the phone's 480x640
frame at scale 0.25, no bars - a portrait render fills the 240x320 frame
cache edge to edge and `reduce_to_box_input` pools it by 2. The only bars
the model ever sees at runtime are the desktop case (a 640x480 webcam
letterboxed into 120x160 gets 35 px top/bottom bars), which `_bars`
simulates at p 0.15; the 10 landscape real photos arrive barred already.
COCO negatives get a random 3:4 crop at p 0.6 so they look like empty phone
frames instead of barred landscape ones. Batch-7 real frames are 720x1280
video (16:9 from the same sensor width as the app's 4:3), so the frame cache
pillarboxes them: 90 px of content between 15 px grey side bands at BOX_WH.
Nothing at runtime has side bands, but 96% of the barred samples hold a cube,
so `_side_bars` puts the same bands on synthetic positives AND negatives at
p 0.10 to keep "side bands" from becoming an objectness shortcut.

Train-time augmentation (all of it lives here): isotropic zoom + translate,
`_bars`, hflip, brightness/contrast, noise.

DECISION 2026-09-12: the frame cache is reduced to BOX_WH with a 2x2 average
(`avg_pool2d`), not `[::2, ::2]`. Nearest-neighbour decimation aliases
sticker edges; the browser's `drawImage` downscale does not. Feeding the
deployed model a `::2`-decimated input instead of a smooth one moved median
IoU on data_real_val from 0.888 to 0.959 - the model was trained on a
sharper, aliased image than it is ever shown at runtime.
"""
from __future__ import annotations

import json
import math
import random
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image
from torch.utils.data import Dataset

from dataset import NORM_MEAN, NORM_STD, CubeKeypointDataset, letterbox_image, letterbox_params
from shapes import BOX_WH, FRAME_CACHE_WH

# rgb(114,114,114) in the normalized space the model sees - the letterbox pad.
PAD = torch.tensor((114.0 / 255.0 - NORM_MEAN) / NORM_STD, dtype=torch.float32).view(3, 1, 1)
# desktop geometry: 640x480 -> 120x160 letterbox is a 120x90 window centred at y=35
BARS_H = round(BOX_WH[0] * 3 / 4)
BARS_Y = (BOX_WH[1] - BARS_H) // 2
P_BARS = 0.15
# 720x1280 video letterboxed into 120x160: a 90x160 window centred at x=15
SIDE_W = round(BOX_WH[1] * 9 / 16)
SIDE_X = (BOX_WH[0] - SIDE_W) // 2
P_SIDE_BARS = 0.10
P_NEG_PORTRAIT_CROP = 0.6


def reduce_to_box_input(x: torch.Tensor) -> torch.Tensor:
    """(3,320,240) frame cache -> (3,160,120) with a 2x2 box filter (see module docstring)."""
    assert x.shape[1] == 2 * BOX_WH[1] and x.shape[2] == 2 * BOX_WH[0], x.shape
    return F.avg_pool2d(x.unsqueeze(0), 2).squeeze(0)


def _has_bars(x: torch.Tensor) -> bool:
    """True if this sample is already letterboxed (a landscape real photo:
    the top row is all pad)."""
    return bool(torch.allclose(x[:, 0, :], PAD.view(3, 1).expand(3, x.shape[2]), atol=1e-3))


def _has_side_bars(x: torch.Tensor) -> bool:
    """True if this sample is pillarboxed (a 16:9 video frame: the left
    column is all pad)."""
    return bool(torch.allclose(x[:, :, 0], PAD.view(3, 1).expand(3, x.shape[1]), atol=1e-3))


def _xyxy(box: torch.Tensor, w: int, h: int):
    return (float(box[0] - box[2] / 2) * w, float(box[1] - box[3] / 2) * h,
            float(box[0] + box[2] / 2) * w, float(box[1] + box[3] / 2) * h)


def _from_xyxy(x0, y0, x1, y1, w: int, h: int) -> torch.Tensor:
    return torch.tensor([(x0 + x1) / 2 / w, (y0 + y1) / 2 / h, (x1 - x0) / w, (y1 - y0) / h],
                        dtype=torch.float32)


def _paste(canvas_wh, content: torch.Tensor, ox: int, oy: int) -> torch.Tensor:
    """content (3,h,w) onto a PAD-filled canvas at (ox,oy), cropping overhang."""
    W, H = canvas_wh
    out = PAD.expand(3, H, W).clone()
    ch, cw = content.shape[1], content.shape[2]
    sx0, sy0 = max(0, -ox), max(0, -oy)
    dx0, dy0 = max(0, ox), max(0, oy)
    ww = min(cw - sx0, W - dx0)
    hh = min(ch - sy0, H - dy0)
    if ww > 0 and hh > 0:
        out[:, dy0:dy0 + hh, dx0:dx0 + ww] = content[:, sy0:sy0 + hh, sx0:sx0 + ww]
    return out


def _zoom_translate(x: torch.Tensor, box: torch.Tensor, lo=0.72, hi=1.3):
    """Isotropic resample + random placement. Rejects placements that would
    push the cube off the canvas - a clipped cube would be a wrong target."""
    W, H = BOX_WH
    s = random.uniform(lo, hi)
    nh, nw = max(8, round(H * s)), max(8, round(W * s))
    content = F.interpolate(x.unsqueeze(0), size=(nh, nw), mode="bilinear",
                            align_corners=False, antialias=True).squeeze(0)
    x0, y0, x1, y1 = _xyxy(box, nw, nh)
    for _ in range(6):
        ox = random.randint(min(0, W - nw), max(0, W - nw))
        oy = random.randint(min(0, H - nh), max(0, H - nh))
        if x0 + ox >= 0 and y0 + oy >= 0 and x1 + ox <= W and y1 + oy <= H:
            return _paste(BOX_WH, content, ox, oy), _from_xyxy(x0 + ox, y0 + oy, x1 + ox, y1 + oy, W, H)
    return x, box


def _bars(x: torch.Tensor, box: torch.Tensor | None):
    """Cut a 4:3 window out of the portrait canvas and re-centre it between
    grey top/bottom bars: the geometry a landscape desktop webcam frame gets.
    The window is chosen to keep the box (if any) inside it."""
    W, H = BOX_WH
    if box is not None:
        _, y0, _, y1 = _xyxy(box, W, H)
        lo = max(0, math.ceil(y1) - BARS_H)
        hi = min(math.floor(y0), H - BARS_H)
        if lo > hi:
            return x, box  # cube taller than the window; leave it alone
        top = random.randint(lo, hi)
        window = x[:, top:top + BARS_H, :]
        return (_paste(BOX_WH, window, 0, BARS_Y),
                _from_xyxy(_xyxy(box, W, H)[0], y0 - top + BARS_Y, _xyxy(box, W, H)[2], y1 - top + BARS_Y, W, H))
    top = random.randint(0, H - BARS_H)
    return _paste(BOX_WH, x[:, top:top + BARS_H, :], 0, BARS_Y), None


def _side_bars(x: torch.Tensor, box: torch.Tensor | None):
    """Cut a 9:16 window out of the canvas and re-centre it between grey
    left/right bands: the geometry a 720x1280 video frame gets. The window
    keeps the box (if any) inside it."""
    W, H = BOX_WH
    if box is not None:
        x0, _, x1, _ = _xyxy(box, W, H)
        lo = max(0, math.ceil(x1) - SIDE_W)
        hi = min(math.floor(x0), W - SIDE_W)
        if lo > hi:
            return x, box  # cube wider than the window; leave it alone
        left = random.randint(lo, hi)
        _, y0, _, y1 = _xyxy(box, W, H)
        return (_paste(BOX_WH, x[:, :, left:left + SIDE_W], SIDE_X, 0),
                _from_xyxy(x0 - left + SIDE_X, y0, x1 - left + SIDE_X, y1, W, H))
    left = random.randint(0, W - SIDE_W)
    return _paste(BOX_WH, x[:, :, left:left + SIDE_W], SIDE_X, 0), None


def _augment(x: torch.Tensor, obj: float, box: torch.Tensor, geometry: bool = True):
    if random.random() < 0.5:  # hflip
        x = torch.flip(x, dims=[2])
        if obj > 0:
            box = box.clone()
            box[0] = 1.0 - box[0]
    if geometry and obj > 0:
        barred = _has_bars(x)
        if random.random() < 0.6:
            x, box = _zoom_translate(x, box)
        if not barred and random.random() < P_BARS:
            x, box = _bars(x, box)
        elif not barred and not _has_side_bars(x) and random.random() < P_SIDE_BARS:
            x, box = _side_bars(x, box)
    elif geometry and not _has_bars(x) and not _has_side_bars(x):
        # negatives see the desktop and video bars too
        r = random.random()
        if r < P_BARS:
            x, _ = _bars(x, None)
        elif r < P_BARS + P_SIDE_BARS:
            x, _ = _side_bars(x, None)
    if random.random() < 0.7:  # brightness/contrast in normalized space
        # The downward reach matters: data_v4's auto-exposure floor re-renders
        # near-black scenes brighter (5.4% of them), so the synthetic set has
        # almost no genuinely dim frames left, and the one dim photo in
        # data_real_val (cube luminance 64 against a median of 108) fell from
        # objectness 0.99 under box3 to 0.07 - a flat detection miss. Reaching
        # to 0.45x puts dim frames back in the mixture.
        x = x * random.uniform(0.45, 1.25) + random.uniform(-0.35, 0.3)
    if random.random() < 0.4:
        x = x + torch.randn_like(x) * random.uniform(0.01, 0.06)
    return x, obj, box


def _portrait_crop(img: Image.Image) -> Image.Image:
    """A random 3:4 window of a (usually landscape) photo, so it letterboxes
    into BOX_WH with no bars - an empty phone frame."""
    w, h = img.size
    if w * 4 <= h * 3:
        return img  # already at least as tall as 3:4
    nw = round(h * 3 / 4)
    x0 = random.randint(0, w - nw)
    return img.crop((x0, 0, x0 + nw, h))


def _to_model(img: Image.Image) -> torch.Tensor:
    arr = np.asarray(letterbox_image(img, *BOX_WH), dtype=np.float32) / 255.0
    return torch.from_numpy(((arr - NORM_MEAN) / NORM_STD).transpose(2, 0, 1).copy())


class SynthBBox(Dataset):
    def __init__(self, root: str, split: str, augment: bool):
        # keypoint augment stays off; bbox-level augment is done here
        self.inner = CubeKeypointDataset(root, split=split, input_size=FRAME_CACHE_WH, augment=None,
                                         view="frame")
        self.augment = augment

    def __len__(self) -> int:
        return len(self.inner)

    def __getitem__(self, i: int):
        x, conf, corners, valid = self.inner[i]
        x = reduce_to_box_input(x)  # frame cache -> BOX_WH, same normalized coords
        vis = (conf > 0.5) & (valid > 0.5)
        if vis.any():
            pts = corners[vis].reshape(-1, 2)
            lo = pts.min(dim=0).values.clamp(0, 1)
            hi = pts.max(dim=0).values.clamp(0, 1)
            box = torch.tensor([(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, hi[0] - lo[0], hi[1] - lo[1]])
            obj = 1.0
        else:
            box = torch.zeros(4)
            obj = 0.0
        if self.augment:
            x, obj, box = _augment(x, obj, box)
        return (x.contiguous(), torch.tensor(obj, dtype=torch.float32), box.to(torch.float32),
                torch.tensor(1.0, dtype=torch.float32))


class NegDir(Dataset):
    """A flat directory of photos with no cube in them (e.g. COCO val2017 via
    fetch_negatives.py): objectness 0, box unused. Teaches "no cube anywhere"
    on real-world scenes the renderer never produces - people, rooms, hands,
    keyboards, tiled floors."""

    EXTS = {".jpg", ".jpeg", ".png", ".webp"}

    def __init__(self, root: str | Path, augment: bool, frac: float = 1.0):
        self.files = sorted(p for p in Path(root).iterdir() if p.suffix.lower() in self.EXTS)
        if frac < 1.0:  # deterministic subset: a smaller pool, not a re-weighting
            self.files = self.files[: max(1, round(len(self.files) * frac))]
        self.augment = augment

    def __len__(self) -> int:
        return len(self.files)

    def __getitem__(self, i: int):
        img = Image.open(self.files[i]).convert("RGB")
        if self.augment and random.random() < P_NEG_PORTRAIT_CROP:
            img = _portrait_crop(img)
        x = _to_model(img)
        box = torch.zeros(4)
        obj = 0.0
        if self.augment:
            x, obj, box = _augment(x, obj, box)
        return (x.contiguous(), torch.tensor(obj, dtype=torch.float32), box.to(torch.float32),
                torch.tensor(1.0, dtype=torch.float32))


class CocoBBox(Dataset):
    def __init__(self, split_dir: str | Path, augment: bool, box_valid: float = 0.0):
        self.dir = Path(split_dir)
        d = json.loads((self.dir / "_annotations.coco.json").read_text())
        boxes: dict[int, list] = {}
        for a in d["annotations"]:
            boxes.setdefault(a["image_id"], []).append(a["bbox"])
        self.items = []
        for im in d["images"]:
            bs = boxes.get(im["id"], [])
            best = max(bs, key=lambda b: b[2] * b[3]) if bs else None
            self.items.append((im["file_name"], im["width"], im["height"], best))
        self.augment = augment
        self.box_valid = box_valid

    def __len__(self) -> int:
        return len(self.items)

    def __getitem__(self, i: int):
        name, w, h, b = self.items[i]
        img = Image.open(self.dir / name).convert("RGB")
        scale, dx, dy = letterbox_params(w, h, *BOX_WH)
        x = _to_model(img)
        if b is not None:
            bx, by, bw, bh = b
            x0 = (bx * scale + dx) / BOX_WH[0]
            y0 = (by * scale + dy) / BOX_WH[1]
            x1 = ((bx + bw) * scale + dx) / BOX_WH[0]
            y1 = ((by + bh) * scale + dy) / BOX_WH[1]
            box = torch.tensor([(x0 + x1) / 2, (y0 + y1) / 2, x1 - x0, y1 - y0]).clamp(0, 1)
            obj = 1.0
        else:
            box = torch.zeros(4)
            obj = 0.0
        if self.augment:
            # geometry off: these boxes don't follow our convention, so there is
            # nothing to keep consistent - and photometric/flip still help objectness.
            x, obj, box = _augment(x, obj, box, geometry=False)
        return (x.contiguous(), torch.tensor(obj, dtype=torch.float32), box.to(torch.float32),
                torch.tensor(self.box_valid if b is not None else 1.0, dtype=torch.float32))
