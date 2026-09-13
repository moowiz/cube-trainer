"""Dataset over the synthetic set produced by model/gen (M3) and the hand-labelled
real photos (M5).

Each sample: an image (480x640 render, 3000x4000 photo) + label JSON with, per
face (U R F D L B), four corner pixel coordinates in cubejs sticker-layout
order and a visibility flag. Corner targets are normalized to [0,1] by the
model-input canvas, so they survive resize.

Two VIEWS of the same labels (model/PORTRAIT-DESIGN.md section 1), each with
its own pre-decoded cache (memory-mapped uint8 images + label tensors, built
lazily on first use, rebuilt when the labels change):

  view="frame"  the whole image letterboxed into `input_size` - the stage-1
                localizer's view (cache_240x320: a 480x640 phone frame fills
                it exactly, landscape webcams get top/bottom bars).
  view="crop"   ONE padded-silhouette crop per image, cut from the NATIVE
                image (not from a thumbnail), per-side padding U(CACHE_PAD)
                deterministic by index, letterboxed square into
                CROP_CACHE_WH (cache_crop320). At sample time the cached
                canvas is re-cropped around the cube hull with per-side
                padding U(PAD_TRAIN) (train) or exactly PAD_VAL (val - the
                app's padBox) and letterboxed to `input_size`. Cube-less
                images get a random square window (a stage-1 false positive
                on a hand or a mug), all faces conf 0.

Why the crop is cut from the native image: the app cuts ~215 px out of the
480x640 source at the range floor and SHRINKS it to 256; cutting a 60 px
window out of a 320x240 thumbnail and blowing it up 5x is the train/inference
mismatch that capped the old two-stage attempt (BBOX-HANDOFF section 1c).

Train/val split hashes the file stem (crc32 % 20 == 0 -> val). Never split on
a periodic index: the generator draws some per-sample choices from the sample
counter, and an every-Nth split aliased with the old style cycle badly enough
to make val 100% stickered.

Target tensors per sample:
    conf:    (6,)    1.0 where the face is visible
    corners: (6,4,2) normalized (u,v); defined for ALL faces (hidden faces'
             corners are still deterministic geometry - they share vertices
             with visible ones)
    valid:   (6,)    0 for hand labels with no corners (unknown geometry)
"""
from __future__ import annotations

import json
import multiprocessing as mp
import os
import zlib
from pathlib import Path

import numpy as np
import torch
from PIL import Image
from torch.utils.data import Dataset

from shapes import CACHE_PAD, CROP_CACHE_WH, PAD_TRAIN, PAD_VAL

FACE_ORDER = "URFDLB"
# ImageNet stats: the backbone is initialized from ImageNet weights.
NORM_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
NORM_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)
PAD_RGB = (114, 114, 114)


def normalize_batch(x: torch.Tensor) -> torch.Tensor:
    """(B,H,W,3) uint8 (as produced by raw_uint8=True) -> (B,3,H,W) float32,
    pixel/255 then (x-mean)/std - the same math as the per-sample path in
    __getitem__, just done once per batch on whatever device `x` is on.

    Exists so training can ship uint8 out of the DataLoader workers: the
    float32 tensor is 4x the bytes, and on Windows every one of those bytes
    crosses a worker->main-process shared-memory copy, gets pinned, then goes
    over PCIe. Measured 0.63 ms of CPU per sample for the normalize alone, on
    top of the transfer cost.
    """
    return normalize01(to_float01(x))


def to_float01(x: torch.Tensor) -> torch.Tensor:
    """(B,H,W,3) uint8 -> (B,3,H,W) float32 in [0,1]. The layout the GPU
    photometric augmentation (gpu_augment.py) operates on."""
    # .to(dtype, memory_format) converts and re-lays out in one pass; the
    # old .float().div_().contiguous() was three passes over ~60 MB a batch.
    return x.permute(0, 3, 1, 2).to(torch.float32, memory_format=torch.contiguous_format).div_(255.0)


def normalize01(x: torch.Tensor) -> torch.Tensor:
    """(B,3,H,W) float in [0,1] -> ImageNet-normalized, IN PLACE."""
    # Cached constants: as_tensor(ndarray, device="cuda") is a synchronizing
    # host->device copy, and this runs once per training step.
    from gpu_augment import const
    mean = const(NORM_MEAN.tolist(), x.device, x.dtype).view(1, 3, 1, 1)
    std = const(NORM_STD.tolist(), x.device, x.dtype).view(1, 3, 1, 1)
    return x.sub_(mean).div_(std)


CACHE_VERSION = 3  # bump when the cached schema changes; triggers rebuild


def load_label(path: Path):
    """Returns (image_rel, (w,h), conf, corners, valid).

    Synthetic labels carry corners for all six faces. Hand labels (M5, the
    label.html tool) have corners: null for unlabeled faces - those get
    valid=0 so the loss never supervises unknown geometry.
    """
    lbl = json.loads(path.read_text())
    w, h = lbl["width"], lbl["height"]
    conf = np.zeros(6, dtype=np.float32)
    corners = np.zeros((6, 4, 2), dtype=np.float32)
    valid = np.zeros(6, dtype=np.float32)
    for i, f in enumerate(FACE_ORDER):
        fd = lbl["faces"][f]
        conf[i] = 1.0 if fd["visible"] else 0.0
        if fd.get("corners") is not None:
            corners[i] = np.asarray(fd["corners"], dtype=np.float32)
            valid[i] = 1.0
    return lbl["image"], (w, h), conf, corners, valid


def is_val(path: Path) -> bool:
    return zlib.crc32(path.stem.encode()) % 20 == 0


def letterbox_params(w: int, h: int, iw: int, ih: int):
    """Aspect-preserving fit of (w,h) into (iw,ih): returns (scale, dx, dy).

    Corner transform: p' = p * scale + (dx, dy). The web app's
    facekp.ts/cubebox.ts do exactly this and invert it for the corners.
    """
    scale = min(iw / w, ih / h)
    dx = (iw - w * scale) / 2
    dy = (ih - h * scale) / 2
    return scale, dx, dy


def letterbox_image(img: Image.Image, iw: int, ih: int) -> Image.Image:
    scale, dx, dy = letterbox_params(img.width, img.height, iw, ih)
    out = Image.new("RGB", (iw, ih), PAD_RGB)
    out.paste(img.resize((round(img.width * scale), round(img.height * scale)), Image.BILINEAR),
              (round(dx), round(dy)))
    return out


def silhouette(corners: np.ndarray, conf: np.ndarray, valid: np.ndarray):
    """Axis-aligned hull of the visible, labelled faces' corners, or None."""
    vis = (conf > 0.5) & (valid > 0.5)
    if not vis.any():
        return None
    pts = corners[vis].reshape(-1, 2)
    return float(pts[:, 0].min()), float(pts[:, 1].min()), float(pts[:, 0].max()), float(pts[:, 1].max())


def _center_of(quad: np.ndarray):
    """Projected face center = intersection of the quad's diagonals."""
    p0, p1, p2, p3 = quad
    d1, d2 = p2 - p0, p3 - p1
    den = d1[0] * d2[1] - d1[1] * d2[0]
    if abs(den) < 1e-9:
        return quad.mean(axis=0)
    t = ((p1[0] - p0[0]) * d2[1] - (p1[1] - p0[1]) * d2[0]) / den
    return p0 + t * d1


def crop_window(hull, pads, bounds):
    """The window a localizer box padded by `pads` = (left, top, right,
    bottom) fractions of the hull's own width/height would give, clamped to
    `bounds` = (x0, y0, x1, y1) exactly like the app's padBox clamps to the
    frame."""
    x0, y0, x1, y1 = hull
    bw, bh = x1 - x0, y1 - y0
    pl, pt, pr, pb = pads
    return (max(bounds[0], x0 - pl * bw), max(bounds[1], y0 - pt * bh),
            min(bounds[2], x1 + pr * bw), min(bounds[3], y1 + pb * bh))


def crop_letterbox(img: Image.Image, window, iw: int, ih: int):
    """Cut `window` (x0,y0,x1,y1, float px) out of `img` and letterbox it into
    (iw, ih). Returns (canvas, scale, dx, dy) with p' = (p - (x0,y0)) * scale
    + (dx, dy) - the same transform facekp.ts applies to a ROI."""
    x0, y0, x1, y1 = window
    cw, ch = x1 - x0, y1 - y0
    scale, dx, dy = letterbox_params(cw, ch, iw, ih)
    nw, nh = max(1, round(cw * scale)), max(1, round(ch * scale))
    # PIL's resize takes a float box: no rounding of the window edges, so the
    # label transform above is exact rather than off by up to half a pixel.
    crop = img.resize((nw, nh), Image.BILINEAR, box=(x0, y0, x1, y1))
    out = Image.new("RGB", (iw, ih), PAD_RGB)
    out.paste(crop, (round(dx), round(dy)))
    return out, scale, dx, dy


def _label_fingerprint(files: list[Path]) -> int:
    """Detect edited-in-place labels (import_labels.py updates keep the file
    count constant). Stats only - never reads content - so it stays cheap for
    the 54k synthetic labels that never change."""
    h = 0
    for f in files:
        st = f.stat()
        h = zlib.crc32(f"{f.name}:{st.st_size}:{st.st_mtime_ns}".encode(), h)
    return h


# --- cache building ---------------------------------------------------------
#
# One worker per chunk of files, each writing straight into the memory-mapped
# image array (opened r+ per process) and returning its label rows. Decoding
# 54k PNGs is ~7 min single-threaded and under a minute on 8 workers.

def _cache_chunk(args):
    root, files, start, view, iw, ih, imgs_path = args
    root = Path(root)
    imgs = np.load(imgs_path, mmap_mode="r+")
    n = len(files)
    confs = np.zeros((n, 6), dtype=np.float32)
    corns = np.zeros((n, 6, 4, 2), dtype=np.float32)
    valids = np.zeros((n, 6), dtype=np.float32)
    geoms = np.zeros((n, 7), dtype=np.float32)  # content x0,y0,x1,y1 (canvas px), scale, src_w, src_h
    for k, f in enumerate(files):
        img_rel, (w, h), conf, corners, valid = load_label(Path(f))
        img = Image.open(root / img_rel).convert("RGB")
        if view == "frame":
            scale, dx, dy = letterbox_params(w, h, iw, ih)
            canvas = letterbox_image(img, iw, ih)
            origin = (0.0, 0.0)
        else:
            rng = np.random.default_rng(zlib.crc32(Path(f).stem.encode()))
            hull = silhouette(corners, conf, valid)
            if hull is None:
                # negative: a stage-1 false positive somewhere in the frame
                side = rng.uniform(0.3, 0.8) * min(w, h)
                x0 = rng.uniform(0, w - side)
                y0 = rng.uniform(0, h - side)
                window = (x0, y0, x0 + side, y0 + side)
            else:
                window = crop_window(hull, rng.uniform(CACHE_PAD[0], CACHE_PAD[1], size=4), (0, 0, w, h))
            canvas, scale, dx, dy = crop_letterbox(img, window, iw, ih)
            origin = (window[0], window[1])
        imgs[start + k] = np.asarray(canvas)
        confs[k] = conf
        corns[k] = ((corners - origin) * scale + [dx, dy]) / np.array([iw, ih], dtype=np.float32)
        valids[k] = valid
        cw = (w if view == "frame" else window[2] - window[0]) * scale
        ch = (h if view == "frame" else window[3] - window[1]) * scale
        geoms[k] = (dx, dy, dx + cw, dy + ch, scale, w, h)
    imgs.flush()
    return start, confs, corns, valids, geoms


def _build_cache(root: Path, files: list[Path], iw: int, ih: int, cdir: Path, view: str,
                 workers: int | None = None):
    cdir.mkdir(parents=True, exist_ok=True)
    n = len(files)
    workers = workers or min(8, max(1, (os.cpu_count() or 2) // 2))
    print(f"building {view} cache for {n} images at {iw}x{ih} -> {cdir} "
          f"(one-time, {workers} workers)", flush=True)
    imgs_path = cdir / "imgs.npy"
    imgs = np.lib.format.open_memmap(imgs_path, mode="w+", dtype=np.uint8, shape=(n, ih, iw, 3))
    imgs.flush()
    del imgs
    confs = np.zeros((n, 6), dtype=np.float32)
    corns = np.zeros((n, 6, 4, 2), dtype=np.float32)
    valids = np.zeros((n, 6), dtype=np.float32)
    geoms = np.zeros((n, 7), dtype=np.float32)
    chunk = max(1, min(500, n // max(1, workers * 4) + 1))
    tasks = [(str(root), [str(f) for f in files[s:s + chunk]], s, view, iw, ih, str(imgs_path))
             for s in range(0, n, chunk)]
    done = 0
    if workers > 1 and n > 200:
        with mp.get_context("spawn").Pool(workers) as pool:
            for start, c, k, v, g in pool.imap_unordered(_cache_chunk, tasks):
                m = len(c)
                confs[start:start + m], corns[start:start + m] = c, k
                valids[start:start + m], geoms[start:start + m] = v, g
                done += m
                if done % 5000 < m:
                    print(f"  cache {done}/{n}", flush=True)
    else:
        for t in tasks:
            start, c, k, v, g = _cache_chunk(t)
            m = len(c)
            confs[start:start + m], corns[start:start + m] = c, k
            valids[start:start + m], geoms[start:start + m] = v, g
    np.savez(cdir / "targets.npz", conf=confs, corners=corns, valid=valids, geom=geoms)
    (cdir / "meta.json").write_text(json.dumps(
        {"count": n, "version": CACHE_VERSION, "view": view, "fingerprint": _label_fingerprint(files)}))


def recrop(canvas: np.ndarray, corners_px: np.ndarray, conf: np.ndarray, valid: np.ndarray,
           content, pads, out_wh, rng=None):
    """Re-crop a cached crop-view canvas around the cube hull with per-side
    `pads` (fractions of the hull, may be negative) and letterbox to
    `out_wh`. The window is clamped to the cached CONTENT (not the grey
    letterbox), which is the app clamping its ROI to the frame.

    Returns (PIL image, corners_px in the output frame, conf with faces
    whose centre left the window demoted to 0, scale out-px per canvas-px).
    """
    img = Image.fromarray(canvas)
    hull = silhouette(corners_px, conf, valid)
    if hull is None:
        # negative: the whole cached window (val) or a random sub-window of it
        cx0, cy0, cx1, cy1 = content
        if rng is not None:
            s = rng.uniform(0.6, 1.0)
            side = s * min(cx1 - cx0, cy1 - cy0)
            x0 = rng.uniform(cx0, cx1 - side)
            y0 = rng.uniform(cy0, cy1 - side)
            window = (x0, y0, x0 + side, y0 + side)
        else:
            window = (cx0, cy0, cx1, cy1)
    else:
        window = crop_window(hull, pads, content)
    out, scale, dx, dy = crop_letterbox(img, window, *out_wh)
    new = (corners_px - [window[0], window[1]]) * scale + [dx, dy]
    conf = conf.copy()
    ow, oh = out_wh
    for i in range(6):
        if conf[i] > 0 and valid[i] > 0:
            cx, cy = _center_of(new[i])
            if not (-8 < cx < ow + 8 and -8 < cy < oh + 8):
                conf[i] = 0.0
    return out, new.astype(np.float32), conf, scale


class CubeKeypointDataset(Dataset):
    def __init__(self, root: str | Path, split: str = "train", input_size=(256, 256), augment=None,
                 raw_uint8: bool = False, view: str = "crop", crop_pad=None, cache_workers=None):
        """split: 'train' | 'val' | 'all' (crc32-hash split, ~5% val).

        view: 'crop' (stage 2, default) or 'frame' (stage 1). See module doc.
        crop_pad: crop view only - per-side padding of the sample-time
            re-crop. None = the split's default: U(PAD_TRAIN) when augmenting,
            PAD_VAL otherwise. A (lo, hi) tuple draws per side, a float is
            fixed. diagnose.py passes PAD_VAL +- a jitter to score the model
            under localizer error.
        raw_uint8: return the image as (H,W,3) uint8 instead of a normalized
            (3,H,W) float32 - the caller must run `normalize_batch` on the
            batch. Off by default so every tool that indexes the dataset
            directly keeps getting model-ready tensors; train.py turns it on.
        """
        self.root = Path(root)
        self.raw_uint8 = raw_uint8
        self.view = view
        all_files = sorted((self.root / "labels").glob("img_*.json"))
        if not all_files:
            raise FileNotFoundError(f"no labels under {self.root} - run the M3 generator first")
        iw, ih = input_size
        self.input_size = input_size  # (w, h)
        self.augment = augment  # callable(img, corners_px, conf) or None
        if view == "crop":
            cw, ch = CROP_CACHE_WH
            if cw != ch or iw != ih:
                raise ValueError("crop view is square: CROP_CACHE_WH and input_size must be (n, n)")
            cdir = self.root / f"cache_crop{cw}"
        elif view == "frame":
            cw, ch = iw, ih
            cdir = self.root / f"cache_{iw}x{ih}"
        else:
            raise ValueError(f"unknown view {view!r}")
        self.cache_wh = (cw, ch)
        if crop_pad is None:
            crop_pad = PAD_TRAIN if augment is not None else PAD_VAL
        self.crop_pad = crop_pad

        meta = cdir / "meta.json"
        stale = True
        if meta.exists():
            m = json.loads(meta.read_text())
            stale = (m["count"] != len(all_files) or m.get("version") != CACHE_VERSION
                     or m.get("view") != view or m.get("fingerprint") != _label_fingerprint(all_files))
        if stale:
            _build_cache(self.root, all_files, cw, ch, cdir, view, workers=cache_workers)
        self._imgs_path = cdir / "imgs.npy"
        self._imgs = None  # opened lazily per process (a pickled memmap would ship the whole array)
        targets = np.load(cdir / "targets.npz")
        conf_all, corners_all, valid_all = targets["conf"], targets["corners"], targets["valid"]
        geom_all = targets["geom"]

        if split == "train":
            idx = [i for i, f in enumerate(all_files) if not is_val(f)]
        elif split == "val":
            idx = [i for i, f in enumerate(all_files) if is_val(f)]
        else:
            idx = list(range(len(all_files)))
        self.indices = np.asarray(idx, dtype=np.int64)
        self.files = [all_files[i] for i in idx]
        self.conf = conf_all[self.indices]
        self.corners = corners_all[self.indices]
        self.valid = valid_all[self.indices]
        # per sample: content rect in cache-canvas px, canvas px per source px, source w, h
        self.geom = geom_all[self.indices]
        self._rng = None

    def __len__(self):
        return len(self.indices)

    def _pads(self, rng):
        p = self.crop_pad
        if isinstance(p, (tuple, list)):
            return rng.uniform(p[0], p[1], size=4)
        return np.full(4, float(p), dtype=np.float32)

    def sample(self, idx):
        """__getitem__ plus the geometry: (x, conf, corners, valid, geom) with
        geom = {'scale': input px per SOURCE px, 'src_w', 'src_h'} so an error
        in input pixels can be reported in source pixels and a face's size
        as a fraction of the source frame height (the range floor's units).
        Randomness (re-crop pads, augmentation) is per call."""
        if self._imgs is None:
            self._imgs = np.load(self._imgs_path, mmap_mode="r")
        if self._rng is None or self._rng[0] != os.getpid():
            # keyed on the pid: a Generator made in the main process before
            # the DataLoader spawned would be pickled into every worker with
            # an identical stream (see augment._rng)
            self._rng = (os.getpid(), np.random.default_rng())
        arr = np.asarray(self._imgs[self.indices[idx]])
        conf = self.conf[idx].copy()
        valid = self.valid[idx].copy()
        cw, ch = self.cache_wh
        corners_px = self.corners[idx] * np.array([cw, ch], dtype=np.float32)
        g = self.geom[idx]
        scale = float(g[4])
        iw, ih = self.input_size
        if self.view == "crop":
            rng = self._rng[1]
            img, corners_px, conf, s = recrop(arr, corners_px, conf, valid, tuple(g[:4]),
                                              self._pads(rng), (iw, ih),
                                              rng if self.augment is not None else None)
            scale *= s
        else:
            img = None
        if self.augment is not None:
            if img is None:
                img = Image.fromarray(arr)
            img, corners_px, conf = self.augment(img, corners_px, conf)
        arr = np.asarray(img) if img is not None else arr
        norm = (corners_px / np.array([iw, ih], dtype=np.float32)).astype(np.float32)
        if self.raw_uint8:
            x = torch.from_numpy(arr.copy())  # memmap/PIL views are read-only; own the bytes
        else:
            x = arr.astype(np.float32) / 255.0
            x = (x - NORM_MEAN) / NORM_STD
            x = torch.from_numpy(x.transpose(2, 0, 1).copy())
        geom = {"scale": scale, "src_w": float(g[5]), "src_h": float(g[6])}
        return x, torch.from_numpy(conf), torch.from_numpy(norm), torch.from_numpy(valid), geom

    def __getitem__(self, idx):
        return self.sample(idx)[:4]
