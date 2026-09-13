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

_const_cache: dict = {}


def const(values, device, dtype=torch.float32) -> torch.Tensor:
    """A small constant tensor on `device`, built once per (values, device,
    dtype) and reused. `torch.tensor(..., device="cuda")` is a host->device
    copy that SYNCHRONIZES the stream every call, so a constant rebuilt per
    step stalls the CPU behind all queued GPU work (see photometric_batch)."""
    key = (tuple(values), str(device), dtype)
    t = _const_cache.get(key)
    if t is None:
        t = _const_cache[key] = torch.tensor(values, device=device, dtype=dtype)
    return t

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
    w = const(_LUMA, x.device, x.dtype).view(1, 3, 1, 1)
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


def gaussian_blur(x: torch.Tensor, sigma: torch.Tensor, ksize: int | None = None) -> torch.Tensor:
    """Separable Gaussian with a per-sample sigma (B,), via grouped conv.
    ksize: odd kernel width; None derives it from sigma.max() (a device sync
    - photometric_batch passes it from the CPU-side draw instead)."""
    b, c, h, w = x.shape
    k = ksize if ksize is not None else 2 * int(math.ceil(3 * float(sigma.max()))) + 1
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
    zero-padded where np.roll wrapped around - irrelevant 7 px from the edge.

    The kernels are built where `lengths` lives: motion_kernels indexes with
    a bool mask (a nonzero() sync on the device), so photometric_batch passes
    CPU tensors and the n x 13 x 13 result is uploaded instead."""
    n, c, h, w = x.shape
    k = motion_kernels(lengths, angles)                              # (n,S,S)
    if k.device != x.device:
        k = k.pin_memory().to(x.device, non_blocking=True)
    size = k.shape[-1]
    k = k.repeat_interleave(c, dim=0).view(n * c, 1, size, size)
    y = nn.functional.conv2d(x.reshape(1, n * c, h, w), k, padding=size // 2, groups=n * c)
    return y.view(n, c, h, w)


PARAM_COLS = 7   # bright, contrast, sat, gain r/g/b, noise sigma


def _draw_params(b: int):
    """All per-sample coin flips and parameters for one batch, drawn on the
    CPU: (params (b,PARAM_COLS) float32 pinned, blur_idx (nb,) long,
    blur_sigma (nb,) float32, motion_idx (nm,) long, lengths (nm,) long,
    angles (nm,) float32) - all CPU tensors.

    Samples that are "off" for an op get its NEUTRAL parameter (factor 1,
    gain 1, noise sigma 0) rather than being skipped: torch.lerp at weight 1
    and clamp on in-range values are exact identities, so their pixels come
    back bit-identical, and running the elementwise ops over the whole batch
    is cheaper than gathering the on-samples and scattering them back (80%
    are on for color anyway). The two convolutions (blur, motion) stay
    indexed - they are the only ops heavy enough for the gather to pay.
    """
    r = torch.rand(b, 9)
    p = torch.ones(b, PARAM_COLS, pin_memory=torch.cuda.is_available())

    def u(col, lo, hi):
        return r[:, col] * (hi - lo) + lo

    on = r[:, 0] < P_COLOR
    p[:, 0] = torch.where(on, u(1, *BRIGHT), 1.0)
    p[:, 1] = torch.where(on, u(2, *CONTRAST), 1.0)
    p[:, 2] = torch.where(on, u(3, *SATURATION), 1.0)
    on = r[:, 4] < P_WB
    p[:, 3:6] = torch.where(on.view(b, 1), torch.rand(b, 3) * (WB_GAIN[1] - WB_GAIN[0]) + WB_GAIN[0], 1.0)
    on = r[:, 5] < P_NOISE
    p[:, 6] = torch.where(on, u(6, *NOISE_SIGMA) / 255.0, 0.0)
    blur_idx = (r[:, 7] < P_BLUR).nonzero(as_tuple=True)[0]
    blur_sigma = torch.rand(blur_idx.numel()) * (BLUR_SIGMA[1] - BLUR_SIGMA[0]) + BLUR_SIGMA[0]
    motion_idx = (r[:, 8] < P_MOTION).nonzero(as_tuple=True)[0]
    lengths = torch.randint(MOTION_LEN[0], MOTION_LEN[1] + 1, (motion_idx.numel(),))
    angles = torch.rand(motion_idx.numel()) * math.pi
    return p, blur_idx, blur_sigma, motion_idx, lengths, angles


def _stage_a(x: torch.Tensor, p: torch.Tensor):
    """Pad mask, color jitter, white balance - the elementwise chain before
    the indexed convolutions. (B,3,H,W) float, params (B,PARAM_COLS)."""
    b = x.shape[0]
    pad = (x == PAD_GRAY).all(dim=1, keepdim=True)   # (B,1,H,W) letterbox/pillar pixels
    x = color_jitter(x, p[:, 0].view(b, 1, 1, 1), p[:, 1].view(b, 1, 1, 1), p[:, 2].view(b, 1, 1, 1))
    x = x.mul_(p[:, 3:6].view(b, 3, 1, 1)).clamp_(0, 1)          # white balance (gain 1 where off)
    return x, pad


def _stage_b(x: torch.Tensor, p: torch.Tensor, pad: torch.Tensor) -> torch.Tensor:
    """Noise (one fused kernel, sigma 0 where off) and the padding restore."""
    b = x.shape[0]
    x = x.addcmul_(torch.randn_like(x), p[:, 6].view(b, 1, 1, 1)).clamp_(0, 1)
    return torch.where(pad, PAD_GRAY, x)


# The two elementwise stages are what torch.compile fuses well (a dozen
# memory-bound passes become ~3 kernels); the convolutions in between are
# cuDNN either way and their index sets change size every batch, which
# would mean a recompile per size. enable_compile() swaps the stages for
# compiled versions; the CPU-side _draw_params is never traced (Inductor's
# CPU backend needs a C++ toolchain the GPU path does not).
_stage_a_impl = _stage_a
_stage_b_impl = _stage_b


def enable_compile(mode: str = "default") -> None:
    """Compile the elementwise stages. dynamic=False: the batch shape is
    static except for the last partial batch, which gets its own graph.

    mode "default", not "reduce-overhead": the stages mutate their inputs
    and hand tensors to each other and to eager convolutions in between,
    and CUDA-graph outputs are static buffers the next replay overwrites -
    check_gpu_augment.py --compile hit exactly that. Kernel fusion is the
    whole gain here (two launches instead of ~15 passes), graphs add
    nothing to it."""
    global _stage_a_impl, _stage_b_impl
    _stage_a_impl = torch.compile(_stage_a, mode=mode, dynamic=False)
    _stage_b_impl = torch.compile(_stage_b, mode=mode, dynamic=False)


def disable_compile() -> None:
    global _stage_a_impl, _stage_b_impl
    _stage_a_impl, _stage_b_impl = _stage_a, _stage_b


@torch.no_grad()
def photometric_batch(x: torch.Tensor) -> torch.Tensor:
    """(B,3,H,W) float in [0,1] on any device -> same shape/range, augmented.

    Issues NO device synchronization (2026-09-12). The first version drew the
    coin flips on the GPU and picked samples with `.any()` / `nonzero()`:
    ten syncs per batch, each of which parks the CPU until every queued
    kernel - the previous step's whole backward pass - has finished, so CPU
    launch time and GPU time added up instead of overlapping. Now the
    randomness is drawn on the CPU (_draw_params), shipped in one pinned
    copy, and the device only ever runs kernels. check_fast_path.py asserts
    this with torch.cuda.set_sync_debug_mode.
    """
    dev = x.device
    p, blur_idx, blur_sigma, motion_idx, lengths, angles = _draw_params(x.shape[0])
    p = p.to(dev, non_blocking=True)
    x, pad = _stage_a_impl(x, p)

    if blur_idx.numel():
        k = 2 * int(math.ceil(3 * float(blur_sigma.max()))) + 1  # CPU tensor: no sync
        idx = blur_idx.to(dev, non_blocking=True)
        x[idx] = gaussian_blur(x[idx], blur_sigma.to(dev, non_blocking=True), ksize=k)

    if motion_idx.numel():
        idx = motion_idx.to(dev, non_blocking=True)
        x[idx] = motion_blur(x[idx], lengths, angles).clamp_(0, 1)   # conv sums can land at 1+eps

    return _stage_b_impl(x, p, pad)
