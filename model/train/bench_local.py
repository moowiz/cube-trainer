"""Training throughput benchmark - Windows-safe version of the pod's bench2.py.

MUST keep the __main__ guard: Windows spawns DataLoader workers by re-importing
this module, so top-level work would recurse into a process bomb.

    ../.venv/Scripts/python bench_local.py --data ../data --workers 4,6,8
"""
from __future__ import annotations

import argparse
import os
import sys
import time

import torch
from torch.utils.data import DataLoader

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__))))

from shapes import KP_WH, grid_hw

INPUT_WH = KP_WH
TRAIN_IMAGES = 51300      # a 54k set after the 5% val split
EPOCHS = 150


def run(ds, label, workers, batch=64, channels_last=False, compile_model=False, steps=300, dev='cuda'):
    """steps=300 (19k images at batch 64) so the number is a SUSTAINED rate:
    the loader's prefetch queue (workers x prefetch_factor batches) is full
    after warm-up, and a 30-step window mostly drained it - that read 3774
    img/s where train.py sustained 2054 (2026-09-12)."""
    from dataset import normalize01, to_float01
    from gpu_augment import photometric_batch
    from model import build_model, center_loss
    from targets import build_center_targets

    model = build_model('center', pretrained=True, input_hw=(INPUT_WH[1], INPUT_WH[0])).to(dev)
    if channels_last:
        model = model.to(memory_format=torch.channels_last)
    if compile_model:
        # what train.py --compile does: graphs for the model, fusion for the
        # augmentation stages (gpu_augment.enable_compile has the why)
        from gpu_augment import enable_compile
        model = torch.compile(model, mode='reduce-overhead', dynamic=False)
        enable_compile()
    opt = torch.optim.AdamW(model.parameters(), lr=3e-4, weight_decay=1e-4, fused=(dev == 'cuda'))
    scaler = torch.amp.GradScaler(enabled=(dev == 'cuda'))
    dl = DataLoader(ds, batch_size=batch, shuffle=True, num_workers=workers,
                    pin_memory=(dev == 'cuda'), persistent_workers=workers > 0,
                    prefetch_factor=4 if workers else None)   # same as train.py
    it = iter(dl)

    def nxt():
        nonlocal it
        try:
            return next(it)
        except StopIteration:
            it = iter(dl)
            return next(it)

    def step():
        if compile_model:
            torch.compiler.cudagraph_mark_step_begin()
        x, c, co, v = (t.to(dev, non_blocking=True) for t in nxt())   # same as train.py
        x = normalize01(photometric_batch(to_float01(x)))
        if channels_last:
            x = x.to(memory_format=torch.channels_last)
        tg = build_center_targets(c, co, v, grid_hw(INPUT_WH))
        opt.zero_grad(set_to_none=True)
        with torch.amp.autocast('cuda', enabled=(dev == 'cuda')):
            loss = center_loss(model(x), tg)[0]
        scaler.scale(loss).backward()
        scaler.step(opt)
        scaler.update()
        return x.size(0)

    for _ in range(40 if compile_model else 30):   # past the prefetch burst
        step()
    if dev == 'cuda':
        torch.cuda.synchronize()

    n, t0 = 0, time.time()
    for _ in range(steps):
        n += step()
    if dev == 'cuda':
        torch.cuda.synchronize()
    dt = time.time() - t0
    ips = n / dt
    print(f'RESULT {label:34s} {ips:7.1f} img/s   epoch {TRAIN_IMAGES / ips:5.1f}s   '
          f'150ep {EPOCHS * TRAIN_IMAGES / ips / 3600:4.2f} h', flush=True)
    del dl, it, model, opt
    if dev == 'cuda':
        torch.cuda.empty_cache()
    return ips


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--data', default='../data_v5')
    ap.add_argument('--workers', default='4,6,8')
    ap.add_argument('--compile', action='store_true', help='run the worker sweep compiled (train.py --compile)')
    args = ap.parse_args()

    import functools

    from augment import augment_sample
    from dataset import CubeKeypointDataset
    from model import build_model, count_params

    dev = 'cuda' if torch.cuda.is_available() else 'cpu'
    print('gpu:', torch.cuda.get_device_name(0) if dev == 'cuda' else 'CPU only', flush=True)
    print('cpu threads:', os.cpu_count(), flush=True)
    print('params: %.2fM' % (count_params(build_model('center', pretrained=False)) / 1e6), flush=True)

    ds = CubeKeypointDataset(args.data, split='all', input_size=INPUT_WH,
                             augment=functools.partial(augment_sample, photometric=False), raw_uint8=True)
    print('dataset:', len(ds), 'images from', args.data, flush=True)

    print('--- data pipeline: how many workers to feed the GPU? ---', flush=True)
    base = {}
    for w in [int(x) for x in args.workers.split(',')]:
        base[w] = run(ds, f'workers={w}' + (' compiled' if args.compile else ''), w,
                      compile_model=args.compile, dev=dev)

    best_w = max(base, key=base.get)
    print(f'--- best workers = {best_w}; GPU-side levers ---', flush=True)
    run(ds, f'workers={best_w} + channels_last', best_w, channels_last=True, dev=dev)
    run(ds, f'workers={best_w} batch=128', best_w, batch=128, dev=dev)
    run(ds, f'workers={best_w} batch=256', best_w, batch=256, dev=dev)
    if not args.compile:
        try:
            run(ds, f'workers={best_w} + compile', best_w, compile_model=True, dev=dev)
        except Exception as e:
            print('RESULT compile FAILED:', str(e)[:160], flush=True)
    print('BENCH_DONE', flush=True)


if __name__ == '__main__':
    main()
