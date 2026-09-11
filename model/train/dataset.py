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


def load_label(path: Path):
    lbl = json.loads(path.read_text())
    w, h = lbl["width"], lbl["height"]
    conf = np.zeros(6, dtype=np.float32)
    corners = np.zeros((6, 4, 2), dtype=np.float32)
    for i, f in enumerate(FACE_ORDER):
        fd = lbl["faces"][f]
        conf[i] = 1.0 if fd["visible"] else 0.0
        corners[i] = np.asarray(fd["corners"], dtype=np.float32)
    return lbl["image"], (w, h), conf, corners


def is_val(path: Path) -> bool:
    return zlib.crc32(path.stem.encode()) % 20 == 0


def _build_cache(root: Path, files: list[Path], iw: int, ih: int, cdir: Path):
    cdir.mkdir(parents=True, exist_ok=True)
    n = len(files)
    print(f"building cache for {n} images at {iw}x{ih} -> {cdir} (one-time)", flush=True)
    imgs = np.lib.format.open_memmap(cdir / "imgs.npy", mode="w+", dtype=np.uint8, shape=(n, ih, iw, 3))
    confs = np.zeros((n, 6), dtype=np.float32)
    corns = np.zeros((n, 6, 4, 2), dtype=np.float32)
    for i, f in enumerate(files):
        img_rel, (w, h), conf, corners = load_label(f)
        img = Image.open(root / img_rel).convert("RGB")
        if img.size != (iw, ih):
            img = img.resize((iw, ih), Image.BILINEAR)
        imgs[i] = np.asarray(img)
        confs[i] = conf
        corns[i] = corners / np.array([w, h], dtype=np.float32)
        if (i + 1) % 2500 == 0:
            print(f"  cache {i + 1}/{n}", flush=True)
    imgs.flush()
    del imgs
    np.savez(cdir / "targets.npz", conf=confs, corners=corns)
    (cdir / "meta.json").write_text(json.dumps({"count": n}))


class CubeKeypointDataset(Dataset):
    def __init__(self, root: str | Path, split: str = "train", input_size=(320, 240), augment=None):
        """split: 'train' | 'val' | 'all' (crc32-hash split, ~5% val)."""
        self.root = Path(root)
        all_files = sorted((self.root / "labels").glob("img_*.json"))
        if not all_files:
            raise FileNotFoundError(f"no labels under {self.root} - run the M3 generator first")
        iw, ih = input_size
        self.input_size = input_size  # (w, h)
        self.augment = augment  # callable(img, corners_px, conf) or None

        cdir = self.root / f"cache_{iw}x{ih}"
        meta = cdir / "meta.json"
        if not meta.exists() or json.loads(meta.read_text())["count"] != len(all_files):
            _build_cache(self.root, all_files, iw, ih, cdir)
        self._imgs_path = cdir / "imgs.npy"
        self._imgs = None  # opened lazily per process (a pickled memmap would ship the whole array)
        targets = np.load(cdir / "targets.npz")
        conf_all, corners_all = targets["conf"], targets["corners"]

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
        x = arr.astype(np.float32) / 255.0
        x = (x - NORM_MEAN) / NORM_STD
        return (
            torch.from_numpy(x.transpose(2, 0, 1).copy()),
            torch.from_numpy(conf),
            torch.from_numpy(norm),
        )
