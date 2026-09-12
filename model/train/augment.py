"""Train-time augmentation for the synthetic set.

Geometric: random rotate/scale/translate applied identically to the image and
the corner labels (the synthetic camera already randomizes pose, so this
mostly teaches tolerance to framing, not new poses).
Photometric: color jitter, blur, sensor noise. Random erasing simulates
fingers over the cube - the single most common real-world occluder.
"""
from __future__ import annotations

import io
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


def _zoom_crop(img: Image.Image, corners: np.ndarray, conf: np.ndarray):
    """Two-stage training distribution: crop a padded box around the cube and
    letterbox it back to full size - what stage 2 will see when a localizer
    (or the tracker's previous quads) crops the camera frame around the cube.
    The naive two-pass experiment failed precisely because the model never
    trained on this distribution (batch4: median 6% -> 11.7% on crops)."""
    vis = [i for i in range(6) if conf[i] > 0]
    if not vis:
        return img, corners, conf
    w, h = img.size
    pts = np.concatenate([corners[i] for i in vis])
    x0, y0 = pts.min(0)
    x1, y1 = pts.max(0)
    bw, bh = x1 - x0, y1 - y0
    if bw < 20 or bh < 20:
        return img, corners, conf
    # independent padding per side: the localizer's box won't be centered
    x0 = max(0.0, x0 - random.uniform(0.05, 0.45) * bw)
    x1 = min(float(w), x1 + random.uniform(0.05, 0.45) * bw)
    y0 = max(0.0, y0 - random.uniform(0.05, 0.45) * bh)
    y1 = min(float(h), y1 + random.uniform(0.05, 0.45) * bh)
    cw, ch = x1 - x0, y1 - y0
    scale = min(w / cw, h / ch)
    nw, nh = int(cw * scale), int(ch * scale)
    crop = img.crop((int(x0), int(y0), int(x1), int(y1))).resize((nw, nh), Image.BILINEAR)
    out = Image.new("RGB", (w, h), (114, 114, 114))
    dx, dy = (w - nw) // 2, (h - nh) // 2
    out.paste(crop, (dx, dy))
    new = (corners - [x0, y0]) * scale + [dx, dy]
    return out, new.astype(corners.dtype), conf


def _portrait_sim(img: Image.Image, corners: np.ndarray, conf: np.ndarray):
    """Simulate a portrait phone frame. The deployed model letterboxes
    480x640 video to 180x240 content between gray pillars; the synthetic set
    is all landscape, so without this no training image ever has bars.
    Crop a narrow full-height window (biased to keep the cube) and re-center
    it between (114,114,114) bars - the exact runtime geometry. Runs last so
    the bars stay pristine, as they do live (added after camera processing).
    """
    w, h = img.size
    new_w = int(w * random.uniform(0.5, 0.8))
    vis = [i for i in range(6) if conf[i] > 0]
    cx = float(np.mean([corners[i][:, 0].mean() for i in vis])) if vis else w / 2
    x0 = int(min(max(cx - new_w / 2 + random.uniform(-0.15, 0.15) * new_w, 0), w - new_w))
    crop = img.crop((x0, 0, x0 + new_w, h))
    out = Image.new("RGB", (w, h), (114, 114, 114))
    pad = (w - new_w) // 2
    out.paste(crop, (pad, 0))
    rel = corners - np.array([x0, 0], dtype=corners.dtype)
    conf = conf.copy()
    for i in range(6):
        if conf[i] > 0 and not _center_in_frame(rel[i], new_w, h):
            conf[i] = 0.0  # face center fell outside the simulated frame
    return out, rel + np.array([pad, 0], dtype=corners.dtype), conf


def augment_sample(img: Image.Image, corners: np.ndarray, conf: np.ndarray):
    w, h = img.size
    # Stage-2 (two-stage detector) mix: mostly crop-normalized views (what a
    # localizer or the tracker's previous quads will feed it), but keep a
    # full-frame minority so the app's no-stage-1 fallback path stays trained.
    if random.random() < 0.7:
        img, corners, conf = _zoom_crop(img, corners, conf)
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
        arr += np.random.normal(0, random.uniform(2, 10), arr.shape)
        img = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))
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
    if random.random() < 0.3:
        img, corners, conf = _portrait_sim(img, corners, conf)
    return img, corners, conf
