"""Is torch.compile worth it on this machine? fwd+bwd+opt at batch 64,
eager vs the Inductor modes, plus the compiled photometric pass. Synthetic
input, no DataLoader. Compare every row against `eager`. See README
"Training performance" for the 2026-09-12 numbers and why it currently
fails on Windows (triton-windows' bundled TinyCC vs Python 3.13 headers;
needs MSVC Build Tools or a 3.12 venv, then `pip install "triton-windows<3.3"`
to pair with torch 2.6).

    ../.venv/Scripts/python bench_compile.py
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
    raw = torch.randint(0, 256, (B, 240, 320, 3), dtype=torch.uint8, device=DEV)
    conf = torch.zeros(B, 6, device=DEV)
    conf[:, :3] = 1
    corners = torch.rand(B, 6, 4, 2, device=DEV) * 0.5 + 0.25
    valid = torch.ones(B, 6, device=DEV)
    x = normalize01(to_float01(raw))
    t = build_center_targets(conf, corners, valid, (15, 20))

    for mode in ["eager", "default", "reduce-overhead", "max-autotune-no-cudagraphs"]:
        model = build_model("center", pretrained=True, input_hw=(240, 320)).to(DEV).train()
        opt = torch.optim.AdamW(model.parameters(), lr=3e-4, weight_decay=1e-4, fused=True)
        scaler = torch.amp.GradScaler()
        m = model if mode == "eager" else torch.compile(model, mode=mode)

        def step():
            opt.zero_grad(set_to_none=True)
            with torch.amp.autocast("cuda"):
                loss, _, _ = center_loss(m(x), t)
            scaler.scale(loss).backward()
            scaler.step(opt)
            scaler.update()

        t0 = time.perf_counter()
        try:
            step()
            torch.cuda.synchronize()
            print(f"  {mode:30s} first step {time.perf_counter() - t0:6.1f}s", flush=True)
            print(f"  {mode:30s} {timeit(step):7.2f} ms/step", flush=True)
        except Exception as e:  # noqa: BLE001 - report and keep going
            print(f"  {mode:30s} FAILED: {str(e)[:400]}", flush=True)

    try:
        paug = torch.compile(photometric_batch)

        def aug():
            return normalize01(paug(to_float01(raw)))

        aug()
        torch.cuda.synchronize()
        print(f"  {'photometric compiled':30s} {timeit(aug):7.2f} ms", flush=True)
    except Exception as e:  # noqa: BLE001
        print("  photometric compile FAILED:", str(e)[:300])


if __name__ == "__main__":
    main()
