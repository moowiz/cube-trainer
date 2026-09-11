"""Train-time augmentation for the synthetic set.

Geometric: random rotate/scale/translate applied identically to the image and
the corner labels (the synthetic camera already randomizes pose, so this
mostly teaches tolerance to framing, not new poses).
Photometric: color jitter, blur, sensor noise. Random erasing simulates
fingers over the cube - the single most common real-world occluder.
"""
from __future__ import annotations

import math
import random

import numpy as np
from PIL import Image, ImageEnhance, ImageFilter


def _affine(img: Image.Image, corners: np.ndarray, angle_deg, scale, tx, ty):
    w, h = img.size
    cx, cy = w / 2, h / 2
    th = math.radians(angle_deg)
    a, b = scale * math.cos(th), -scale * math.sin(th)
    c, d = scale * math.sin(th), scale * math.cos(th)
    # forward: p' = A(p - c) + c + t ; PIL wants the inverse map (out -> in)
    inv_s = 1.0 / scale
    ia, ib = inv_s * math.cos(th), inv_s * math.sin(th)
    ic, id_ = -inv_s * math.sin(th), inv_s * math.cos(th)
    fill = tuple(random.randint(0, 255) for _ in range(3))
    img = img.transform(
        (w, h),
        Image.AFFINE,
        (ia, ib, cx - ia * (cx + tx) - ib * (cy + ty), ic, id_, cy - ic * (cx + tx) - id_ * (cy + ty)),
        resample=Image.BILINEAR,
        fillcolor=fill,
    )
    p = corners - [cx, cy]
    out = np.empty_like(corners)
    out[..., 0] = a * p[..., 0] + b * p[..., 1] + cx + tx
    out[..., 1] = c * p[..., 0] + d * p[..., 1] + cy + ty
    return img, out


def _center_in_frame(quad: np.ndarray, w, h, margin=8):
    """Projected face center = intersection of the quad's diagonals."""
    p0, p1, p2, p3 = quad
    d1, d2 = p2 - p0, p3 - p1
    den = d1[0] * d2[1] - d1[1] * d2[0]
    if abs(den) < 1e-9:
        return False
    t = ((p1[0] - p0[0]) * d2[1] - (p1[1] - p0[1]) * d2[0]) / den
    cx, cy = p0 + t * d1
    return -margin < cx < w + margin and -margin < cy < h + margin


def augment_sample(img: Image.Image, corners: np.ndarray, conf: np.ndarray):
    w, h = img.size
    if random.random() < 0.9:
        img, corners = _affine(
            img,
            corners,
            angle_deg=random.uniform(-15, 15),
            scale=random.uniform(0.75, 1.25),
            tx=random.uniform(-0.08, 0.08) * w,
            ty=random.uniform(-0.08, 0.08) * h,
        )
        # a face shifted out of frame is no longer a detection target
        conf = conf.copy()
        for i in range(6):
            if conf[i] > 0 and not _center_in_frame(corners[i], w, h):
                conf[i] = 0.0

    if random.random() < 0.8:
        img = ImageEnhance.Brightness(img).enhance(random.uniform(0.6, 1.4))
        img = ImageEnhance.Contrast(img).enhance(random.uniform(0.7, 1.3))
        img = ImageEnhance.Color(img).enhance(random.uniform(0.6, 1.5))
    if random.random() < 0.25:
        img = img.filter(ImageFilter.GaussianBlur(random.uniform(0.5, 2.0)))
    if random.random() < 0.5:
        arr = np.asarray(img, dtype=np.float32)
        arr += np.random.normal(0, random.uniform(2, 10), arr.shape)
        img = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))
    if random.random() < 0.4:  # fingers / partial occlusion
        arr = np.asarray(img).copy()
        for _ in range(random.randint(1, 3)):
            ew, eh = random.randint(10, w // 6), random.randint(10, h // 6)
            ex, ey = random.randint(0, w - ew), random.randint(0, h - eh)
            arr[ey : ey + eh, ex : ex + ew] = [random.randint(0, 255) for _ in range(3)]
        img = Image.fromarray(arr)
    return img, corners, conf
