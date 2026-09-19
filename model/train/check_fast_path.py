"""Equivalence check for the training fast path (2026-09-12).

train.py ships uint8 HWC out of the DataLoader workers and normalizes on the
GPU (`raw_uint8=True` + `normalize_batch`); every other tool still takes the
per-sample float32 path from `CubeKeypointDataset.__getitem__`. The two must
produce the same model input, or train and export/diagnose would silently
disagree about what the network sees.

Also pins the float32 Gaussian-noise RNG in augment.py to the distribution
the old float64 `np.random.normal` call produced, and proves that one full
training step (H2D copy, GPU augmentation, targets, forward, backward, fused
AdamW through GradScaler) issues no device synchronization: every sync
parks the CPU until the previous step's kernels drain, so CPU launch time
and GPU time add up instead of overlapping (2026-09-12: ~12 syncs/step).

    ../.venv/Scripts/python check_fast_path.py --data ../data_real_val
"""
from __future__ import annotations

import argparse
import random
import sys

import numpy as np
import torch

from dataset import CubeKeypointDataset, normalize_batch
from shapes import KP_WH

INPUT_WH = KP_WH


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="../data_real_val")
    ap.add_argument("--n", type=int, default=16)
    args = ap.parse_args()

    ok = True
    slow = CubeKeypointDataset(args.data, split="all", input_size=INPUT_WH, augment=None)
    fast = CubeKeypointDataset(args.data, split="all", input_size=INPUT_WH, augment=None, raw_uint8=True)
    n = min(args.n, len(slow))
    x_slow = torch.stack([slow[i][0] for i in range(n)])
    raw = torch.stack([fast[i][0] for i in range(n)])
    assert raw.dtype == torch.uint8 and raw.shape == (n, INPUT_WH[1], INPUT_WH[0], 3), raw.shape
    for i in range(n):
        for a, b in zip(slow[i][1:], fast[i][1:]):
            assert torch.equal(a, b), "labels differ between the two paths"

    devices = ["cpu"] + (["cuda"] if torch.cuda.is_available() else [])
    for dev in devices:
        x_fast = normalize_batch(raw.to(dev)).cpu()
        assert x_fast.shape == x_slow.shape and x_fast.dtype == torch.float32
        diff = (x_fast - x_slow).abs().max().item()
        # Both are float32 pixel/255 then (x-mean)/std; the only slack is
        # summation order inside the CUDA kernels, i.e. a couple of ulps.
        good = diff < 1e-5
        ok &= good
        print(f"normalize_batch[{dev}] vs __getitem__ float path: max |diff| {diff:.2e}  "
              f"{'OK' if good else 'FAIL'}")

    # Noise RNG: the float32 Generator draw must be N(0, sigma) like the
    # float64 legacy call was. 1M samples: std within 0.5%, mean within 0.01.
    from augment import _rng
    sigma = random.uniform(2, 10)
    z = _rng().standard_normal((1000, 1000), dtype=np.float32) * sigma
    m, s = float(z.mean()), float(z.std())
    good = abs(m) < 0.01 * sigma and abs(s - sigma) / sigma < 0.005
    ok &= good
    print(f"noise rng: sigma {sigma:.3f} -> mean {m:+.4f} std {s:.4f} dtype {z.dtype}  "
          f"{'OK' if good else 'FAIL'}")

    if torch.cuda.is_available():
        ok &= step_has_no_sync()

    print("PASS" if ok else "FAIL")
    sys.exit(0 if ok else 1)


def step_has_no_sync() -> bool:
    """One train.py step with torch's sync debug mode set to raise."""
    from dataset import normalize01, to_float01
    from gpu_augment import photometric_batch
    from model import build_model, center_loss
    from targets import build_center_targets

    torch.backends.cudnn.benchmark = True
    dev = "cuda"
    model = build_model("center", pretrained=False, input_hw=(INPUT_WH[1], INPUT_WH[0])).to(dev)
    opt = torch.optim.AdamW(model.parameters(), lr=3e-4, weight_decay=1e-4, fused=True)
    scaler = torch.amp.GradScaler()
    b = 8
    raw = torch.randint(0, 256, (b, INPUT_WH[1], INPUT_WH[0], 3), dtype=torch.uint8).pin_memory()
    conf = torch.zeros(b, 6)
    conf[:, :2] = 1
    corners = (torch.rand(b, 6, 4, 2) * 0.5 + 0.25)
    corners[0, 0] *= 0.02      # one face below the range floor: exercises the ignore path
    valid = torch.ones(b, 6)
    conf, corners, valid = (t.pin_memory() for t in (conf, corners, valid))

    def step():
        x, c, co, v = (t.to(dev, non_blocking=True) for t in (raw, conf, corners, valid))
        x = normalize01(photometric_batch(to_float01(x)))
        t = build_center_targets(c, co, v, model.grid_hw)
        opt.zero_grad(set_to_none=True)
        with torch.amp.autocast("cuda"):
            loss, lh, lo, _, _ = center_loss(model(x), t)
        scaler.scale(loss).backward()
        scaler.step(opt)
        scaler.update()
        return loss.detach() * b + lh.detach() + lo.detach()

    for _ in range(3):     # warm-up: cudnn autotune, constant caches, allocator
        step()
    torch.cuda.synchronize()
    torch.cuda.set_sync_debug_mode("error")
    try:
        for _ in range(5):
            step()
        good = True
        msg = "no device sync in a full training step"
    except RuntimeError as e:
        good = False
        msg = f"training step SYNCHRONIZES: {str(e).splitlines()[0][:120]}"
    finally:
        torch.cuda.set_sync_debug_mode("default")
        torch.cuda.synchronize()
    print(f"{msg}  {'OK' if good else 'FAIL'}")
    return good


if __name__ == "__main__":
    main()
