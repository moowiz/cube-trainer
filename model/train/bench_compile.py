"""Is torch.compile worth it on this machine? fwd+bwd+opt at batch 64,
eager vs the Inductor modes, plus the compiled photometric stages. Synthetic
input, no DataLoader. Compare every row against `eager`. README "Training
performance" step 6 has the 2026-09-12 numbers (eager 20.2 ms, default
16.7, reduce-overhead 13.8) and the prerequisites (`triton-windows<3.3`
for torch 2.6, Python >= 3.13.5).

    ../.venv/Scripts/python -u bench_compile.py [--modes eager,default,reduce-overhead]

Run with -u: the first compile of each mode takes ~10 s cold and prints
nothing meanwhile. max-autotune modes take far longer - opt in explicitly.
"""
from __future__ import annotations

import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import torch

from dataset import normalize01, to_float01
from gpu_augment import photometric_batch
from model import build_model, center_loss
from shapes import KP_WH
from targets import build_center_targets

torch.backends.cudnn.benchmark = True
DEV = "cuda"
B = 64


def timeit(fn, reps=30, warm=8):
    for _ in range(warm):
        fn()
    torch.cuda.synchronize()
    t = time.perf_counter()
    for _ in range(reps):
        fn()
    torch.cuda.synchronize()
    return (time.perf_counter() - t) / reps * 1000


def main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--modes", default="eager,default,reduce-overhead")
    modes = ap.parse_args().modes.split(",")
    raw = torch.randint(0, 256, (B, KP_WH[1], KP_WH[0], 3), dtype=torch.uint8, device=DEV)
    conf = torch.zeros(B, 6, device=DEV)
    conf[:, :3] = 1
    corners = torch.rand(B, 6, 4, 2, device=DEV) * 0.5 + 0.25
    valid = torch.ones(B, 6, device=DEV)
    x = normalize01(to_float01(raw))
    t = build_center_targets(conf, corners, valid, (15, 20))

    for mode in modes:
        model = build_model("center", pretrained=True, input_hw=(KP_WH[1], KP_WH[0])).to(DEV).train()
        opt = torch.optim.AdamW(model.parameters(), lr=3e-4, weight_decay=1e-4, fused=True)
        scaler = torch.amp.GradScaler()
        m = model if mode == "eager" else torch.compile(model, mode=mode)

        def step():
            opt.zero_grad(set_to_none=True)
            with torch.amp.autocast("cuda"):
                loss = center_loss(m(x), t)[0]
            scaler.scale(loss).backward()
            scaler.step(opt)
            scaler.update()

        t0 = time.perf_counter()
        try:
            step()
            torch.cuda.synchronize()
            print(f"  {mode:30s} first step {time.perf_counter() - t0:6.1f}s", flush=True)
            print(f"  {mode:30s} {timeit(step):7.2f} ms/step", flush=True)
        except Exception as e:
            print(f"  {mode:30s} FAILED: {str(e)[:400]}", flush=True)

    try:
        from gpu_augment import enable_compile
        enable_compile()   # the two GPU stages; the CPU-side draw is never traced

        def aug():
            return normalize01(photometric_batch(to_float01(raw)))

        aug()
        torch.cuda.synchronize()
        print(f"  {'photometric compiled':30s} {timeit(aug):7.2f} ms", flush=True)
    except Exception as e:
        print("  photometric compile FAILED:", str(e)[:300])


if __name__ == "__main__":
    main()
