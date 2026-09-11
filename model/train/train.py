"""Train the face keypoint model (M4).

    python train.py --data ../data --epochs 30 --batch 64 --out runs/base
    python train.py --data ../data --overfit 50 --epochs 150   # pipeline check

The overfit run is the correctness test: 50 images, no augmentation, val ==
train. If the pipeline is sound it drives corner error to ~1 px; if it can't,
something upstream (labels, loss, normalization) is broken - fix that before
burning a real run.
"""
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import torch
from torch.utils.data import DataLoader, Subset

from augment import augment_sample
from dataset import CubeKeypointDataset
from model import FaceKP, conf_accuracy, keypoint_loss, pixel_error

INPUT_WH = (320, 240)


def evaluate(model, loader, device):
    model.eval()
    tot = {"loss": 0.0, "px": 0.0, "acc": 0.0, "n": 0}
    with torch.no_grad():
        for x, conf, corners in loader:
            x, conf, corners = x.to(device), conf.to(device), corners.to(device)
            pred = model(x)
            loss, _, _ = keypoint_loss(pred, conf, corners)
            b = x.size(0)
            tot["loss"] += loss.item() * b
            tot["px"] += pixel_error(pred, conf, corners, INPUT_WH) * b
            tot["acc"] += conf_accuracy(pred, conf) * b
            tot["n"] += b
    n = tot["n"]
    return tot["loss"] / n, tot["px"] / n, tot["acc"] / n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="../data")
    ap.add_argument("--out", default="runs/base")
    ap.add_argument("--epochs", type=int, default=30)
    ap.add_argument("--batch", type=int, default=64)
    ap.add_argument("--lr", type=float, default=3e-4)
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--overfit", type=int, default=0, help="train+val on the first N samples, no augmentation")
    args = ap.parse_args()

    device = "cuda" if torch.cuda.is_available() else "cpu"
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    if args.overfit:
        ds = CubeKeypointDataset(args.data, split="all", input_size=INPUT_WH, augment=None)
        train_ds = val_ds = Subset(ds, range(min(args.overfit, len(ds))))
    else:
        train_ds = CubeKeypointDataset(args.data, split="train", input_size=INPUT_WH, augment=augment_sample)
        val_ds = CubeKeypointDataset(args.data, split="val", input_size=INPUT_WH, augment=None)
    train_dl = DataLoader(train_ds, batch_size=args.batch, shuffle=True, num_workers=args.workers,
                          pin_memory=(device == "cuda"), persistent_workers=args.workers > 0)
    val_dl = DataLoader(val_ds, batch_size=args.batch, shuffle=False, num_workers=0)
    print(f"device={device}  train={len(train_ds)}  val={len(val_ds)}")

    model = FaceKP(pretrained=True, input_hw=(INPUT_WH[1], INPUT_WH[0])).to(device)
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=args.lr, total_steps=args.epochs * max(1, len(train_dl)))
    scaler = torch.amp.GradScaler(enabled=device == "cuda")

    best_px = float("inf")
    log = []
    for epoch in range(1, args.epochs + 1):
        model.train()
        t0 = time.time()
        run_loss = 0.0
        n = 0
        for x, conf, corners in train_dl:
            x, conf, corners = x.to(device, non_blocking=True), conf.to(device), corners.to(device)
            opt.zero_grad(set_to_none=True)
            with torch.amp.autocast(device_type="cuda", enabled=device == "cuda"):
                pred = model(x)
                loss, _, _ = keypoint_loss(pred, conf, corners)
            scaler.scale(loss).backward()
            scaler.step(opt)
            scaler.update()
            sched.step()
            run_loss += loss.item() * x.size(0)
            n += x.size(0)
        vloss, vpx, vacc = evaluate(model, val_dl, device)
        line = (f"epoch {epoch:3d}  train_loss {run_loss / n:.4f}  val_loss {vloss:.4f}  "
                f"val_px {vpx:.2f}  val_conf_acc {vacc:.3f}  {time.time() - t0:.0f}s")
        print(line, flush=True)
        log.append(line)
        ckpt = {"model": model.state_dict(), "input_wh": INPUT_WH, "epoch": epoch, "val_px": vpx}
        torch.save(ckpt, out / "last.pt")
        if vpx < best_px:
            best_px = vpx
            torch.save(ckpt, out / "best.pt")
    (out / "log.txt").write_text("\n".join(log) + f"\nbest val_px {best_px:.2f}\n")
    print(f"best val_px {best_px:.2f}  ->  {out / 'best.pt'}")


if __name__ == "__main__":
    main()
