"""Datasets for the stage-1 cube localizer (bbox at 160x120).

Two sources, one sample contract: (image CHW normalized like FaceKP,
objectness float, bbox [cx, cy, w, h] normalized to [0,1]).

- SynthBBox wraps CubeKeypointDataset: bbox = hull of the visible faces'
  corner labels (free supervision from the corner data, incl. real photos
  in data_real). Hard negatives (no cube) come through as objectness 0.
- CocoBBox reads a Roboflow COCO export dir (all its classes mean "a cube";
  largest box wins if several). Real-world variety stage 2 can't use -
  other people's cubes, rooms, and lighting.

Light train-time augmentation lives here (hflip, brightness/contrast
jitter, noise) - geometric variety beyond flips comes from the sources
themselves; keep stage 1 simple until measurement says otherwise.
"""
from __future__ import annotations

import json
import random
from pathlib import Path

import numpy as np
import torch
from PIL import Image
from torch.utils.data import Dataset

from dataset import CubeKeypointDataset, NORM_MEAN, NORM_STD, letterbox_image, letterbox_params

BOX_WH = (160, 120)


def _augment(x: torch.Tensor, obj: float, box: torch.Tensor):
    if random.random() < 0.5:  # hflip
        x = torch.flip(x, dims=[2])
        if obj > 0:
            box = box.clone()
            box[0] = 1.0 - box[0]
    if random.random() < 0.7:  # brightness/contrast in normalized space
        x = x * random.uniform(0.8, 1.25) + random.uniform(-0.3, 0.3)
    if random.random() < 0.4:
        x = x + torch.randn_like(x) * random.uniform(0.01, 0.06)
    return x, obj, box


class SynthBBox(Dataset):
    def __init__(self, root: str, split: str, augment: bool):
        # keypoint augment stays off; bbox-level augment is done here
        self.inner = CubeKeypointDataset(root, split=split, input_size=(320, 240), augment=None)
        self.augment = augment

    def __len__(self) -> int:
        return len(self.inner)

    def __getitem__(self, i: int):
        x, conf, corners, valid = self.inner[i]
        x = x[:, ::2, ::2]  # 320x240 cache -> 160x120, same normalized coords
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
        return x.contiguous(), torch.tensor(obj, dtype=torch.float32), box.to(torch.float32)


class CocoBBox(Dataset):
    def __init__(self, split_dir: str | Path, augment: bool):
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

    def __len__(self) -> int:
        return len(self.items)

    def __getitem__(self, i: int):
        name, w, h, b = self.items[i]
        img = Image.open(self.dir / name).convert("RGB")
        scale, dx, dy = letterbox_params(w, h, *BOX_WH)
        arr = np.asarray(letterbox_image(img, *BOX_WH), dtype=np.float32) / 255.0
        x = torch.from_numpy(((arr - NORM_MEAN) / NORM_STD).transpose(2, 0, 1).copy())
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
            x, obj, box = _augment(x, obj, box)
        return x.contiguous(), torch.tensor(obj, dtype=torch.float32), box.to(torch.float32)
