"""Dataset over the synthetic set produced by model/gen (M3).

Each sample: 640x480 PNG + label JSON with, per face (U R F D L B), four
corner pixel coordinates in cubejs sticker-layout order and a visibility flag.
Images are resized to the model input (320x240 by default); corner targets are
normalized to [0,1] by image size, so they survive any resize.

Target tensors per sample:
    conf:    (6,)    1.0 where the face is visible
    corners: (6,4,2) normalized (u,v); defined for ALL faces (hidden faces'
             corners are still deterministic geometry - they share vertices
             with visible ones - and get a small loss weight in training)
"""
from __future__ import annotations

import json
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


class CubeKeypointDataset(Dataset):
    def __init__(self, root: str | Path, split: str = "train", input_size=(320, 240), augment=None):
        """split: 'train' | 'val' | 'all'. Every 20th sample is val (5%)."""
        self.root = Path(root)
        files = sorted((self.root / "labels").glob("img_*.json"))
        if not files:
            raise FileNotFoundError(f"no labels under {self.root} - run the M3 generator first")
        if split == "train":
            files = [f for i, f in enumerate(files) if i % 20 != 0]
        elif split == "val":
            files = [f for i, f in enumerate(files) if i % 20 == 0]
        self.files = files
        self.input_size = input_size  # (w, h)
        self.augment = augment  # callable(img, corners_px, conf) or None

    def __len__(self):
        return len(self.files)

    def __getitem__(self, idx):
        img_rel, (w, h), conf, corners = load_label(self.files[idx])
        img = Image.open(self.root / img_rel).convert("RGB")
        if self.augment is not None:
            img, corners, conf = self.augment(img, corners, conf)
        iw, ih = self.input_size
        if img.size != (iw, ih):
            img = img.resize((iw, ih), Image.BILINEAR)
        # normalize coords by the ORIGINAL size (corners are in original px)
        norm = corners / np.array([w, h], dtype=np.float32)
        x = np.asarray(img, dtype=np.float32) / 255.0
        x = (x - NORM_MEAN) / NORM_STD
        return (
            torch.from_numpy(x.transpose(2, 0, 1).copy()),
            torch.from_numpy(conf.copy()),
            torch.from_numpy(norm.astype(np.float32)),
        )
