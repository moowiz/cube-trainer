"""gpu_augment.py vs the PIL/numpy ops it replaced, on real cached frames.

Each op is driven with FIXED parameters through both implementations and
compared in 8-bit units. PIL rounds to uint8 after every stage and the GPU
path stays float, so the bar is "within a couple of gray levels", not
bit-exact; anything larger means a formula is wrong. Also checks the
padding-restore guarantee and times photometric_batch on a real batch.

    ../.venv/Scripts/python check_gpu_augment.py --data ../data_real_val [--compile]
"""
from __future__ import annotations

import argparse
import math
import sys
import time

import numpy as np
import torch
from PIL import Image, ImageEnhance, ImageFilter

import gpu_augment as G
from dataset import CubeKeypointDataset, to_float01

from shapes import KP_WH
INPUT_WH = KP_WH


def to_pil(x: torch.Tensor) -> np.ndarray:
    """(3,H,W) float [0,1] -> (H,W,3) uint8 the way PIL would store it."""
    return (x.clamp(0, 1) * 255).round().to(torch.uint8).permute(1, 2, 0).cpu().numpy()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="../data_real_val")
    ap.add_argument("--n", type=int, default=8)
    ap.add_argument("--compile", action="store_true",
                    help="run photometric_batch with its torch.compile'd stages (what train.py "
                         "--compile uses): the identity, padding and timing checks then cover them")
    args = ap.parse_args()
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    if args.compile:
        G.enable_compile()
        print("photometric stages: torch.compile(mode='reduce-overhead')")

    ds = CubeKeypointDataset(args.data, split="all", input_size=INPUT_WH, augment=None, raw_uint8=True)
    n = min(args.n, len(ds))
    raw = torch.stack([ds[i][0] for i in range(n)])
    x = to_float01(raw.to(dev))
    pils = [Image.fromarray(raw[i].numpy()) for i in range(n)]
    ok = True

    def report(name, diffs, tol):
        nonlocal ok
        worst = max(diffs)
        good = worst <= tol
        ok &= good
        print(f"{name:34s} max |diff| {worst:5.2f}/255 (tol {tol})  {'OK' if good else 'FAIL'}")

    # --- color jitter: Brightness -> Contrast -> Color, fixed factors.
    # pil_truncate=True mimics Image.blend's (int) store so the comparison
    # proves the formulas (>=95% of pixels exact, rest 1-2 levels from float
    # vs PIL arithmetic at integer boundaries). The training path runs with
    # pil_truncate=False - see color_jitter's docstring for the ~0.7/255 why.
    for bf, cf, sf in [(0.6, 0.7, 0.6), (1.4, 1.3, 1.5), (1.0, 1.0, 1.0), (0.8, 1.2, 1.3)]:
        g = G.color_jitter(x.clone(), torch.full((n, 1, 1, 1), bf, device=dev),
                           torch.full((n, 1, 1, 1), cf, device=dev),
                           torch.full((n, 1, 1, 1), sf, device=dev), pil_truncate=True)
        diffs, exact = [], []
        for i, im in enumerate(pils):
            im = ImageEnhance.Brightness(im).enhance(bf)
            im = ImageEnhance.Contrast(im).enhance(cf)
            im = ImageEnhance.Color(im).enhance(sf)
            d = np.abs(np.asarray(im).astype(int) - to_pil(g[i]).astype(int))
            diffs.append(d.max())
            exact.append((d == 0).mean())
        report(f"color jitter b={bf} c={cf} s={sf}", diffs, 2)
        good = min(exact) >= 0.95
        ok &= good
        print(f"{'':34s} exact pixels {100 * min(exact):.1f}%  {'OK' if good else 'FAIL'}")

    # --- white balance
    gain = torch.tensor([1.2, 0.8, 1.05], device=dev).view(1, 3, 1, 1)
    g = (x.clone() * gain).clamp(0, 1)
    diffs = []
    for i, im in enumerate(pils):
        a = np.asarray(im, dtype=np.float32) * np.array([1.2, 0.8, 1.05], np.float32)
        diffs.append(np.abs(np.clip(a, 0, 255).astype(np.uint8).astype(int) - to_pil(g[i]).astype(int)).max())
    report("white balance", diffs, 1)

    # --- gaussian blur: PIL's kernel is an extended-box approximation, so
    # compare the mean error, not the max, and only away from the border.
    for sigma in (0.5, 1.2, 2.0):
        g = G.gaussian_blur(x.clone(), torch.full((n,), sigma, device=dev))
        diffs = []
        for i, im in enumerate(pils):
            ref = np.asarray(im.filter(ImageFilter.GaussianBlur(sigma))).astype(float)
            got = to_pil(g[i]).astype(float)
            diffs.append(np.abs(ref - got)[8:-8, 8:-8].mean())
        report(f"gaussian blur sigma={sigma} (mean err)", diffs, 1.0)

    # --- motion blur vs augment._motion_blur's roll-and-average
    # angles off exact .5 ties: at pi/3, cos*t = 0.5 rounds differently in
    # float64 math.cos (the reference) and float32 torch.cos
    for length, ang in [(2, 0.0), (7, 1.0), (4, math.pi / 2), (6, 2.5)]:
        diffs = []
        for i, im in enumerate(pils):
            arr = np.asarray(im, dtype=np.float32)
            acc = np.zeros_like(arr)
            for t in range(length):
                acc += np.roll(np.roll(arr, int(round(math.sin(ang) * t)), axis=0),
                               int(round(math.cos(ang) * t)), axis=1)
            ref = np.clip(acc / length, 0, 255).astype(np.uint8).astype(int)
            got = to_pil(G.motion_blur(x[i:i + 1].clone(), torch.tensor([length], device=dev),
                                       torch.tensor([ang], device=dev))[0]).astype(int)
            # np.roll wrapped at the border, the conv zero-pads: skip 7 px
            diffs.append(np.abs(ref - got)[7:-7, 7:-7].max())
        report(f"motion blur len={length} ang={ang:.2f}", diffs, 1)

    # --- padding restore: paint pillar bars, run the full random pipeline
    # many times, bars must come back exactly 114 every time
    xb = x.clone()
    xb[:, :, :, :40] = G.PAD_GRAY
    xb[:, :, :, -40:] = G.PAD_GRAY
    bad = 0
    for _ in range(20):
        y = G.photometric_batch(xb.clone())
        bars = torch.cat([y[:, :, :, :40], y[:, :, :, -40:]], dim=3)
        bad += int((bars != G.PAD_GRAY).sum())
        assert y.min() >= 0 and y.max() <= 1
    good = bad == 0
    ok &= good
    print(f"{'padding restore (20 random passes)':34s} {bad} bad pixels  {'OK' if good else 'FAIL'}")

    # --- neutral parameters: with every op "off" the batch must come back
    # bit-identical (photometric_batch runs the elementwise ops on all samples
    # with factor 1 / gain 1 / sigma 0 instead of skipping them)
    saved = (G.P_COLOR, G.P_WB, G.P_BLUR, G.P_MOTION, G.P_NOISE)
    G.P_COLOR = G.P_WB = G.P_BLUR = G.P_MOTION = G.P_NOISE = 0.0
    try:
        same = all(torch.equal(G.photometric_batch(x.clone()), x) for _ in range(10))
    finally:
        G.P_COLOR, G.P_WB, G.P_BLUR, G.P_MOTION, G.P_NOISE = saved
    ok &= same
    print(f"{'all ops off -> identity (10 passes)':34s} {'bit-exact' if same else 'DIFFERS'}  "
          f"{'OK' if same else 'FAIL'}")

    # --- timing on a real-size batch
    xb = x.repeat(math.ceil(64 / n), 1, 1, 1)[:64]
    for _ in range(3):
        G.photometric_batch(xb.clone())
    if dev == "cuda":
        torch.cuda.synchronize()
    t = time.perf_counter()
    reps = 20
    for _ in range(reps):
        G.photometric_batch(xb.clone())
    if dev == "cuda":
        torch.cuda.synchronize()
    ms = (time.perf_counter() - t) / reps * 1000
    print(f"photometric_batch on (64,3,{INPUT_WH[1]},{INPUT_WH[0]}) [{dev}]: {ms:.2f} ms/batch = {ms / 64:.3f} ms/sample")

    print("PASS" if ok else "FAIL")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
