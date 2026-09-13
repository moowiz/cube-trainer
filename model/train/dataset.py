"""Dataset over the synthetic set produced by model/gen (M3).

Each sample: 640x480 PNG + label JSON with, per face (U R F D L B), four
corner pixel coordinates in cubejs sticker-layout order and a visibility flag.
Corner targets are normalized to [0,1] by image size, so they survive resize.

Loading goes through a pre-decoded cache (built lazily on first use): every
image decoded + resized once to the model input size into one memory-mapped
uint8 array, labels into a companion .npz. The first 20k run decoded full
PNGs per epoch and left the GPU ~90% idle; the cache is the fix prescribed in
model/README "Training performance".

Train/val split hashes the file stem (crc32 % 20 == 0 -> val). Never split on
a periodic index: the generator draws some per-sample choices from the sample
counter, and an every-Nth split aliased with the old style cycle badly enough
to make val 100% stickered.

Target tensors per sample:
    conf:    (6,)    1.0 where the face is visible
    corners: (6,4,2) normalized (u,v); defined for ALL faces (hidden faces'
             corners are still deterministic geometry - they share vertices
             with visible ones - and get a small loss weight in training)
"""
from __future__ import annotations

import json
import zlib
from pathlib import Path

import numpy as np
import torch
from PIL import Image
from torch.utils.data import Dataset

FACE_ORDER = "URFDLB"
# ImageNet stats: the backbone is initialized from ImageNet weights.
NORM_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
NORM_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)


def normalize_batch(x: torch.Tensor) -> torch.Tensor:
    """(B,H,W,3) uint8 (as produced by raw_uint8=True) -> (B,3,H,W) float32,
    pixel/255 then (x-mean)/std - the same math as the per-sample path in
    __getitem__, just done once per batch on whatever device `x` is on.

    Exists so training can ship uint8 out of the DataLoader workers: the
    float32 tensor is 4x the bytes (921 KB vs 230 KB per 320x240 sample),
    and on Windows every one of those bytes crosses a worker->main-process
    shared-memory copy, gets pinned, then goes over PCIe. Measured 0.63 ms of
    CPU per sample for the normalize alone, on top of the transfer cost.
    """
    mean = torch.as_tensor(NORM_MEAN, device=x.device).view(1, 3, 1, 1)
    std = torch.as_tensor(NORM_STD, device=x.device).view(1, 3, 1, 1)
    x = x.permute(0, 3, 1, 2).float().div_(255.0)
    return x.sub_(mean).div_(std).contiguous()


CACHE_VERSION = 2  # bump when the cached schema changes; triggers rebuild


def load_label(path: Path):
    """Returns (image_rel, (w,h), conf, corners, valid).

    Synthetic labels carry corners for all six faces. Hand labels (M5, the
    label.html tool) have corners: null for unlabeled faces — those get
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

    Phones capture portrait (480x640); squashing it into the 4:3 model input
    would teach corner geometry at the wrong aspect ratio. Letterbox instead:
    scale to fit, center, pad. Corner transform: p' = p * scale + (dx, dy).
    """
    scale = min(iw / w, ih / h)
    dx = (iw - w * scale) / 2
    dy = (ih - h * scale) / 2
    return scale, dx, dy


def letterbox_image(img: Image.Image, iw: int, ih: int) -> Image.Image:
    scale, dx, dy = letterbox_params(img.width, img.height, iw, ih)
    out = Image.new("RGB", (iw, ih), (114, 114, 114))
    out.paste(img.resize((round(img.width * scale), round(img.height * scale)), Image.BILINEAR),
              (round(dx), round(dy)))
    return out


def _label_fingerprint(files: list[Path]) -> int:
    """Detect edited-in-place labels (import_labels.py updates keep the file
    count constant). Stats only - never reads content - so it stays cheap for
    the 38k synthetic labels that never change."""
    h = 0
    for f in files:
        st = f.stat()
        h = zlib.crc32(f"{f.name}:{st.st_size}:{st.st_mtime_ns}".encode(), h)
    return h


def _build_cache(root: Path, files: list[Path], iw: int, ih: int, cdir: Path):
    cdir.mkdir(parents=True, exist_ok=True)
    n = len(files)
    print(f"building cache for {n} images at {iw}x{ih} -> {cdir} (one-time)", flush=True)
    imgs = np.lib.format.open_memmap(cdir / "imgs.npy", mode="w+", dtype=np.uint8, shape=(n, ih, iw, 3))
    confs = np.zeros((n, 6), dtype=np.float32)
    corns = np.zeros((n, 6, 4, 2), dtype=np.float32)
    valids = np.zeros((n, 6), dtype=np.float32)
    for i, f in enumerate(files):
        img_rel, (w, h), conf, corners, valid = load_label(f)
        img = Image.open(root / img_rel).convert("RGB")
        scale, dx, dy = letterbox_params(w, h, iw, ih)
        imgs[i] = np.asarray(letterbox_image(img, iw, ih))
        confs[i] = conf
        corns[i] = (corners * scale + [dx, dy]) / np.array([iw, ih], dtype=np.float32)
        valids[i] = valid
        if (i + 1) % 2500 == 0:
            print(f"  cache {i + 1}/{n}", flush=True)
    imgs.flush()
    del imgs
    np.savez(cdir / "targets.npz", conf=confs, corners=corns, valid=valids)
    (cdir / "meta.json").write_text(json.dumps(
        {"count": n, "version": CACHE_VERSION, "fingerprint": _label_fingerprint(files)}))


class CubeKeypointDataset(Dataset):
    def __init__(self, root: str | Path, split: str = "train", input_size=(320, 240), augment=None,
                 raw_uint8: bool = False):
        """split: 'train' | 'val' | 'all' (crc32-hash split, ~5% val).

        raw_uint8: return the image as (H,W,3) uint8 instead of a normalized
        (3,H,W) float32 - the caller must run `normalize_batch` on the batch.
        Off by default so every tool that indexes the dataset directly
        (export parity check, diagnose, fixture dumps, bbox) keeps getting
        model-ready tensors; train.py turns it on for throughput.
        """
        self.root = Path(root)
        self.raw_uint8 = raw_uint8
        all_files = sorted((self.root / "labels").glob("img_*.json"))
        if not all_files:
            raise FileNotFoundError(f"no labels under {self.root} - run the M3 generator first")
        iw, ih = input_size
        self.input_size = input_size  # (w, h)
        self.augment = augment  # callable(img, corners_px, conf) or None

        cdir = self.root / f"cache_{iw}x{ih}"
        meta = cdir / "meta.json"
        stale = True
        if meta.exists():
            m = json.loads(meta.read_text())
            stale = (m["count"] != len(all_files) or m.get("version") != CACHE_VERSION
                     or m.get("fingerprint") != _label_fingerprint(all_files))
        if stale:
            _build_cache(self.root, all_files, iw, ih, cdir)
        self._imgs_path = cdir / "imgs.npy"
        self._imgs = None  # opened lazily per process (a pickled memmap would ship the whole array)
        targets = np.load(cdir / "targets.npz")
        conf_all, corners_all, valid_all = targets["conf"], targets["corners"], targets["valid"]

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

    def __len__(self):
        return len(self.indices)

    def __getitem__(self, idx):
        if self._imgs is None:
            self._imgs = np.load(self._imgs_path, mmap_mode="r")
        arr = np.asarray(self._imgs[self.indices[idx]])
        conf = self.conf[idx].copy()
        norm = self.corners[idx].copy()
        iw, ih = self.input_size
        if self.augment is not None:
            img = Image.fromarray(arr)
            wh = np.array([iw, ih], dtype=np.float32)
            img, corners_px, conf = self.augment(img, norm * wh, conf)
            norm = (corners_px / wh).astype(np.float32)
            arr = np.asarray(img)
        if self.raw_uint8:
            x = torch.from_numpy(arr.copy())  # memmap/PIL views are read-only; own the bytes
        else:
            x = arr.astype(np.float32) / 255.0
            x = (x - NORM_MEAN) / NORM_STD
            x = torch.from_numpy(x.transpose(2, 0, 1).copy())
        return (
            x,
            torch.from_numpy(conf),
            torch.from_numpy(norm),
            torch.from_numpy(self.valid[idx].copy()),
        )
