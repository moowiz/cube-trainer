"""Train-time augmentation for the synthetic set.

Geometric: random rotate/scale/translate applied identically to the image and
the corner labels (the synthetic camera already randomizes pose, so this
mostly teaches tolerance to framing, not new poses). The crop itself - the
padded silhouette window stage 2 is fed at runtime - is drawn by
dataset.recrop from the crop cache, not here (model/PORTRAIT-DESIGN.md).
Photometric: color jitter, blur, sensor noise. Random erasing simulates
fingers over the cube - the single most common real-world occluder.
"""
from __future__ import annotations

import io
import math
import os
import random

import numpy as np
from PIL import Image, ImageEnhance, ImageFilter

# One float32-capable Generator per PROCESS, created on first use. PyTorch
# reseeds `random` and the legacy np.random global in every DataLoader
# worker, but knows nothing about a Generator we make ourselves - and on
# Linux (the cloud box) workers are forked, so a module-level instance would
# be cloned into all of them with an identical stream. Keying on the pid
# gives every worker its own OS-entropy seed on either platform.
_rng_cache: dict[int, np.random.Generator] = {}


def _rng() -> np.random.Generator:
    pid = os.getpid()
    g = _rng_cache.get(pid)
    if g is None:
        _rng_cache.clear()
        g = _rng_cache[pid] = np.random.default_rng()
    return g


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


def _motion_blur(img: Image.Image) -> Image.Image:
    """Directional smear: a turning cube in a video frame, not lens defocus."""
    arr = np.asarray(img, dtype=np.float32)
    length = random.randint(2, 7)
    ang = random.uniform(0, math.pi)
    dx, dy = math.cos(ang), math.sin(ang)
    acc = np.zeros_like(arr)
    for t in range(length):
        acc += np.roll(np.roll(arr, int(round(dy * t)), axis=0), int(round(dx * t)), axis=1)
    return Image.fromarray(np.clip(acc / length, 0, 255).astype(np.uint8))


def augment_sample(img: Image.Image, corners: np.ndarray, conf: np.ndarray,
                   photometric: bool = True):
    """photometric=False skips the pixel-wise block (color jitter, white
    balance, blur, motion blur, noise) - train.py applies the identical ops
    batched on the GPU via gpu_augment.photometric_batch instead. The
    geometry, JPEG and erasing always run here."""
    w, h = img.size
    # The crop geometry (what stage 2 sees: a padded silhouette crop) is the
    # dataset's job - dataset.recrop draws it per sample from the cached loose
    # crop. Everything here is shape-agnostic.
    if random.random() < 0.9:
        img, corners = _affine(
            img,
            corners,
            angle_deg=random.uniform(-15, 15),
            scale=random.uniform(0.75, 1.25),
            tx=random.uniform(-0.12, 0.12) * w,
            ty=random.uniform(-0.12, 0.12) * h,
        )
        # a face shifted out of frame is no longer a detection target
        conf = conf.copy()
        for i in range(6):
            if conf[i] > 0 and not _center_in_frame(corners[i], w, h):
                conf[i] = 0.0

    if not photometric:
        return _codec_and_occlusion(img, corners, conf)
    if random.random() < 0.8:
        img = ImageEnhance.Brightness(img).enhance(random.uniform(0.6, 1.4))
        img = ImageEnhance.Contrast(img).enhance(random.uniform(0.7, 1.3))
        img = ImageEnhance.Color(img).enhance(random.uniform(0.6, 1.5))
    if random.random() < 0.4:
        # white-balance error: a global per-channel gain on the final image,
        # distinct from light color (the renders vary that already). This is
        # the red/orange and monitor-cast failure axis.
        arr = np.asarray(img, dtype=np.float32)
        arr *= np.array([random.uniform(0.8, 1.2) for _ in range(3)], dtype=np.float32)
        img = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))
    if random.random() < 0.25:
        img = img.filter(ImageFilter.GaussianBlur(random.uniform(0.5, 2.0)))
    if random.random() < 0.18:
        img = _motion_blur(img)
    if random.random() < 0.5:
        arr = np.asarray(img, dtype=np.float32)
        # Generator API with dtype=float32: the legacy np.random.normal
        # draws float64 and was 3.9 ms per 320x240 image, the single most
        # expensive op in this function (~1/3 of the whole per-sample cost).
        arr += _rng().standard_normal(arr.shape, dtype=np.float32) * random.uniform(2, 10)
        img = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))
    return _codec_and_occlusion(img, corners, conf)


def _codec_and_occlusion(img: Image.Image, corners: np.ndarray, conf: np.ndarray):
    """The tail of augment_sample: JPEG, erasing. Split out so the
    GPU-photometric path can run it without the block above."""
    w, h = img.size
    if random.random() < 0.35:
        # video/JPEG compression: blocky chroma like a phone camera stream
        buf = io.BytesIO()
        img.save(buf, "JPEG", quality=random.randint(30, 85))
        buf.seek(0)
        img = Image.open(buf).convert("RGB")
    if random.random() < 0.4:  # fingers / partial occlusion
        arr = np.asarray(img).copy()
        for _ in range(random.randint(1, 3)):
            ew, eh = random.randint(10, w // 6), random.randint(10, h // 6)
            ex, ey = random.randint(0, w - ew), random.randint(0, h - eh)
            arr[ey : ey + eh, ex : ex + ew] = [random.randint(0, 255) for _ in range(3)]
        img = Image.fromarray(arr)
    return img, corners, conf
