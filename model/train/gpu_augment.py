"""Photometric train-time augmentation, batched on the device (2026-09-12).

The second half of augment.augment_sample. Profiling after the pre-decoded
cache showed the DataLoader workers spending ~6 ms/sample, most of it in
pixel-wise photometric ops that PIL/numpy run one image at a time: noise,
blur, color jitter, white balance. On a (64,3,240,320) batch those are a
handful of fused CUDA kernels costing well under a millisecond, so they
moved here and the workers keep only what genuinely needs per-image code
(crop/affine geometry with label updates, the JPEG codec, erasing).

Every op reproduces the PIL/numpy behaviour it replaced, with the same
per-sample probability and parameter range:

    ImageEnhance.Brightness(f)  blend(black,      img, f) = img*f
    ImageEnhance.Contrast(f)    blend(mean-gray,  img, f)   mean of L = luma
    ImageEnhance.Color(f)       blend(grayscale,  img, f)   L = ITU-R 601
    white balance               per-channel gain
    GaussianBlur(r)             separable Gaussian, sigma = r
    _motion_blur                mean of `length` wrapped shifts along a line
    noise                       N(0, sigma) per pixel per channel

PIL rounds to uint8 after every op; here values stay float and are clamped
to [0,1] at the same points, so results agree to ~1/255. check_gpu_augment.py
verifies that against PIL on cached frames.

Pixels that are exactly (114,114,114) - the letterbox/pillarbox padding from
_zoom_crop and _portrait_sim - are restored after the ops. In the app the
padding is added AFTER the camera frame, so it never carries sensor noise or
white-balance error; the old CPU ordering kept the portrait bars pristine by
running _portrait_sim last, and this keeps that guarantee (and extends it to
the zoom letterbox, which the old path did jitter).

DECISION: op order vs the CPU path. The worker still runs JPEG and erasing,
so they now precede noise/blur instead of following them. Live, noise is
compressed by the video codec rather than added on top of it, so this is a
small step away from the camera; erased "finger" patches now pick up the
same blur and noise as the rest of the frame, which is a small step toward
it. Accepted for the ~2.5 ms/sample of worker time it buys.
"""
from __future__ import annotations

import math

import torch
from torch import nn

PAD_GRAY = 114.0 / 255.0
_LUMA = (0.299, 0.587, 0.114)   # ITU-R 601-2, what PIL's convert("L") uses

# Probabilities and ranges: identical to the block they replaced in
# augment.augment_sample - keep the two in sync if either changes.
P_COLOR, BRIGHT, CONTRAST, SATURATION = 0.8, (0.6, 1.4), (0.7, 1.3), (0.6, 1.5)
P_WB, WB_GAIN = 0.4, (0.8, 1.2)
P_BLUR, BLUR_SIGMA = 0.25, (0.5, 2.0)
P_MOTION, MOTION_LEN = 0.18, (2, 7)
P_NOISE, NOISE_SIGMA = 0.5, (2.0, 10.0)


def _u(n: int, lo: float, hi: float, device) -> torch.Tensor:
    """n uniform draws in [lo,hi) on `device`, shaped (n,1,1,1)."""
    return (torch.rand(n, device=device) * (hi - lo) + lo).view(n, 1, 1, 1)


def _luma(x: torch.Tensor) -> torch.Tensor:
    """(B,3,H,W) -> (B,1,H,W)."""
    w = x.new_tensor(_LUMA).view(1, 3, 1, 1)
    return (x * w).sum(dim=1, keepdim=True)


def color_jitter(x: torch.Tensor, bright: torch.Tensor, contrast: torch.Tensor,
                 sat: torch.Tensor, pil_truncate: bool = False) -> torch.Tensor:
    """PIL Brightness -> Contrast -> Color with per-sample factors (B,1,1,1).

    pil_truncate=True reproduces PIL bit-for-bit (check_gpu_augment.py uses
    it to prove the formulas): Image.blend's C loop stores (int)(a + f*(b-a)),
    i.e. it TRUNCATES to uint8 after every stage, a ~0.5/255 darkening each
    time. That is a PIL artifact, not a designed augmentation, so the
    training path leaves it out and stays in float. Net effect vs the old CPU
    path: images ~0.7/255 brighter on average - noise next to the 0.6-1.4
    brightness jitter.
    """
    def q(t):
        if not pil_truncate:
            return t.clamp_(0, 1)
        # +1e-3 before the floor: k/255*255 lands on k-eps in float32
        return t.clamp_(0, 1).mul_(255).add_(1e-3).floor_().div_(255)

    # Memory-bound: every elementwise op is a full pass over ~60 MB at batch
    # 64, so blends go through torch.lerp (one fused kernel each) and results
    # are clamped in place.
    x = q(x.mul(bright))
    # PIL: mean of the L image, rounded to an integer gray level
    mean = (_luma(x).mean(dim=(1, 2, 3), keepdim=True) * 255).round() / 255
    x = q(torch.lerp(mean.expand_as(x), x, contrast))
    gray = _luma(x)
    if pil_truncate:
        gray = gray.mul_(255).round_().div_(255)   # PIL's L image is uint8 too
    return q(torch.lerp(gray.expand_as(x), x, sat))


def gaussian_blur(x: torch.Tensor, sigma: torch.Tensor) -> torch.Tensor:
    """Separable Gaussian with a per-sample sigma (B,), via grouped conv."""
    b, c, h, w = x.shape
    k = 2 * int(math.ceil(3 * float(sigma.max()))) + 1
    r = torch.arange(k, device=x.device, dtype=x.dtype) - k // 2
    g = torch.exp(-0.5 * (r.view(1, -1) / sigma.view(-1, 1).to(x.dtype)) ** 2)
    g = g / g.sum(dim=1, keepdim=True)                            # (B,k)
    g = g.repeat_interleave(c, dim=0)                             # (B*c,k)
    y = x.reshape(1, b * c, h, w)
    y = nn.functional.pad(y, (k // 2, k // 2, 0, 0), mode="reflect")
    y = nn.functional.conv2d(y, g.view(b * c, 1, 1, k), groups=b * c)
    y = nn.functional.pad(y, (0, 0, k // 2, k // 2), mode="reflect")
    y = nn.functional.conv2d(y, g.view(b * c, 1, k, 1), groups=b * c)
    return y.view(b, c, h, w)


def motion_kernels(lengths: torch.Tensor, angles: torch.Tensor, size: int = 2 * (MOTION_LEN[1] - 1) + 1):
    """(n,) ints and (n,) radians -> (n,size,size) kernels: 1/length at one
    tap per t < length, the same taps augment._motion_blur summed with
    np.roll. roll(+s) is out[i] = in[i-s]; conv2d is cross-correlation,
    out[i] = sum_k K[k] in[i+k-c], so the tap for shift s sits at c - s."""
    n = lengths.numel()
    c = size // 2
    t = torch.arange(MOTION_LEN[1], device=lengths.device, dtype=torch.float32)   # (T,)
    dy = c - (angles.sin().view(n, 1) * t).round().long()                         # (n,T)
    dx = c - (angles.cos().view(n, 1) * t).round().long()
    on = t.view(1, -1) < lengths.view(n, 1).float()
    k = torch.zeros(n, size, size, device=lengths.device)
    ni = torch.arange(n, device=lengths.device).view(n, 1).expand_as(dy)
    k.index_put_((ni[on], dy[on], dx[on]), 1.0 / lengths.view(n, 1).float().expand_as(dy)[on],
                 accumulate=True)
    return k


def motion_blur(x: torch.Tensor, lengths: torch.Tensor, angles: torch.Tensor) -> torch.Tensor:
    """(n,3,H,W) with per-sample length/angle, one grouped conv. Borders are
    zero-padded where np.roll wrapped around - irrelevant 7 px from the edge."""
    n, c, h, w = x.shape
    k = motion_kernels(lengths, angles)                              # (n,S,S)
    size = k.shape[-1]
    k = k.repeat_interleave(c, dim=0).view(n * c, 1, size, size)
    y = nn.functional.conv2d(x.reshape(1, n * c, h, w), k, padding=size // 2, groups=n * c)
    return y.view(n, c, h, w)


@torch.no_grad()
def photometric_batch(x: torch.Tensor) -> torch.Tensor:
    """(B,3,H,W) float in [0,1] on any device -> same shape/range, augmented.
    Draws all per-sample randomness with torch on `x.device`."""
    b = x.shape[0]
    dev = x.device
    pad = (x == PAD_GRAY).all(dim=1, keepdim=True)   # (B,1,H,W) letterbox/pillar pixels

    on = torch.rand(b, device=dev) < P_COLOR
    if on.any():
        idx = on.nonzero(as_tuple=True)[0]
        n = idx.numel()
        x[idx] = color_jitter(x[idx], _u(n, *BRIGHT, dev), _u(n, *CONTRAST, dev),
                              _u(n, *SATURATION, dev))

    on = torch.rand(b, device=dev) < P_WB
    if on.any():
        idx = on.nonzero(as_tuple=True)[0]
        gain = torch.rand(idx.numel(), 3, 1, 1, device=dev) * (WB_GAIN[1] - WB_GAIN[0]) + WB_GAIN[0]
        x[idx] = (x[idx] * gain).clamp_(0, 1)

    on = torch.rand(b, device=dev) < P_BLUR
    if on.any():
        idx = on.nonzero(as_tuple=True)[0]
        sigma = torch.rand(idx.numel(), device=dev) * (BLUR_SIGMA[1] - BLUR_SIGMA[0]) + BLUR_SIGMA[0]
        x[idx] = gaussian_blur(x[idx], sigma)

    on = torch.rand(b, device=dev) < P_MOTION
    if on.any():
        idx = on.nonzero(as_tuple=True)[0]
        lens = torch.randint(MOTION_LEN[0], MOTION_LEN[1] + 1, (idx.numel(),), device=dev)
        angs = torch.rand(idx.numel(), device=dev) * math.pi
        x[idx] = motion_blur(x[idx], lens, angs).clamp_(0, 1)   # conv sums can land at 1+eps

    on = torch.rand(b, device=dev) < P_NOISE
    if on.any():
        # one fused kernel over the whole batch: sigma is 0 where noise is off
        sigma = _u(b, *NOISE_SIGMA, dev) / 255.0 * on.view(b, 1, 1, 1).to(x.dtype)
        x = (x + torch.randn_like(x) * sigma).clamp_(0, 1)

    return torch.where(pad, x.new_tensor(PAD_GRAY), x)
