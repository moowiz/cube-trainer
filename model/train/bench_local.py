"""Training throughput benchmark - Windows-safe version of the pod's bench2.py.

MUST keep the __main__ guard: Windows spawns DataLoader workers by re-importing
this module, so top-level work would recurse into a process bomb.

    ..\.venv\Scripts\python bench_local.py --data ../data_v4
"""
from __future__ import annotations

import argparse
import os
import sys
import time

import torch
from torch.utils.data import DataLoader

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__))))

INPUT_WH = (320, 240)
TRAIN_IMAGES = 51300      # a 54k set after the 5% val split
EPOCHS = 150


def run(ds, label, workers, batch=64, channels_last=False, compile_model=False, steps=30, dev='cuda'):
    from dataset import normalize_batch
    from model import build_model, center_loss
    from targets import build_center_targets

    model = build_model('center', pretrained=True, input_hw=(240, 320)).to(dev)
    if channels_last:
        model = model.to(memory_format=torch.channels_last)
    if compile_model:
        model = torch.compile(model)
    opt = torch.optim.AdamW(model.parameters(), lr=3e-4)
    scaler = torch.amp.GradScaler(enabled=(dev == 'cuda'))
    dl = DataLoader(ds, batch_size=batch, shuffle=True, num_workers=workers,
                    pin_memory=(dev == 'cuda'), persistent_workers=workers > 0,
                    prefetch_factor=6 if workers else None)
    it = iter(dl)

    def nxt():
        nonlocal it
        try:
            return next(it)
        except StopIteration:
            it = iter(dl)
            return next(it)

    def step():
        x, c, co, v = nxt()
        x = normalize_batch(x.to(dev, non_blocking=True))
        if channels_last:
            x = x.to(memory_format=torch.channels_last)
        tg = build_center_targets(c.to(dev), co.to(dev), v.to(dev), (15, 20))
        opt.zero_grad(set_to_none=True)
        with torch.amp.autocast('cuda', enabled=(dev == 'cuda')):
            loss, _, _ = center_loss(model(x), tg)
        scaler.scale(loss).backward()
        scaler.step(opt)
        scaler.update()
        return x.size(0)

    for _ in range(12 if compile_model else 6):
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
    ap.add_argument('--data', default='../data_v4')
    ap.add_argument('--workers', default='4,8,12,16')
    args = ap.parse_args()

    from augment import augment_sample
    from dataset import CubeKeypointDataset
    from model import count_params, build_model

    dev = 'cuda' if torch.cuda.is_available() else 'cpu'
    print('gpu:', torch.cuda.get_device_name(0) if dev == 'cuda' else 'CPU only', flush=True)
    print('cpu threads:', os.cpu_count(), flush=True)
    print('params: %.2fM' % (count_params(build_model('center', pretrained=False)) / 1e6), flush=True)

    ds = CubeKeypointDataset(args.data, split='all', input_size=INPUT_WH, augment=augment_sample,
                             raw_uint8=True)
    print('dataset:', len(ds), 'images from', args.data, flush=True)

    print('--- data pipeline: how many workers to feed the GPU? ---', flush=True)
    base = {}
    for w in [int(x) for x in args.workers.split(',')]:
        base[w] = run(ds, f'workers={w}', w, dev=dev)

    best_w = max(base, key=base.get)
    print(f'--- best workers = {best_w}; GPU-side levers ---', flush=True)
    run(ds, f'workers={best_w} + channels_last', best_w, channels_last=True, dev=dev)
    run(ds, f'workers={best_w} batch=128', best_w, batch=128, dev=dev)
    run(ds, f'workers={best_w} batch=256', best_w, batch=256, dev=dev)
    try:
        run(ds, f'workers={best_w} + compile', best_w, compile_model=True, steps=20, dev=dev)
    except Exception as e:
        print('RESULT compile FAILED:', str(e)[:160], flush=True)
    print('BENCH_DONE', flush=True)


if __name__ == '__main__':
    main()
