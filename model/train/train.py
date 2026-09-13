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
from torch.utils.data import ConcatDataset, DataLoader, Subset

from augment import augment_sample
from dataset import CubeKeypointDataset, normalize_batch
from model import (HEADS, build_model, center_loss, center_metrics, conf_accuracy, count_params,
                   f1_from_counts, keypoint_loss, pixel_error)
from targets import build_center_targets, dataset_target_stats

INPUT_WH = (320, 240)


def evaluate(model, loader, device, head="legacy", grid_hw=None):
    """-> (loss, px, acc). For the center head the last two are redefined:
    `px` is the corner error over MATCHED detections only and `acc` is
    detection F1 at score 0.5, not per-slot visibility accuracy. The log-line
    keys stay val_px / val_conf_acc because watch.py parses those exact
    names - do not compare the numbers across heads."""
    model.eval()
    tot = {"loss": 0.0, "px": 0.0, "acc": 0.0, "n": 0}
    err_sum = 0.0
    matched = tp = fp = fn = 0
    with torch.no_grad():
        for x, conf, corners, valid in loader:
            x, conf, corners, valid = x.to(device), conf.to(device), corners.to(device), valid.to(device)
            x = normalize_batch(x)
            pred = model(x)
            b = x.size(0)
            if head == "center":
                t = build_center_targets(conf, corners, valid, grid_hw)
                loss, _, _ = center_loss(pred, t)
                e, m, a, c, d = center_metrics(pred, conf, corners, valid, INPUT_WH)
                err_sum += e
                matched += m
                tp += a
                fp += c
                fn += d
            else:
                loss, _, _ = keypoint_loss(pred, conf, corners, valid)
                tot["px"] += pixel_error(pred, conf, corners, INPUT_WH, valid) * b
                tot["acc"] += conf_accuracy(pred, conf) * b
            tot["loss"] += loss.item() * b
            tot["n"] += b
    n = tot["n"]
    if head == "center":
        # DECISION: a finite sentinel, not nan, when nothing matched (typical
        # for the first epoch or two, when no cell clears score 0.5).
        # watch.py's line regex only accepts [\d.]+ for val_px, and dropping
        # those rows would silently punch holes in the dashboard.
        px = err_sum / matched if matched else 999.99
        return tot["loss"] / n, px, f1_from_counts(tp, fp, fn)
    return tot["loss"] / n, tot["px"] / n, tot["acc"] / n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="../data",
                    help="dataset root(s), comma-separated; append *N to oversample a root "
                         "(e.g. ../data,../data_real*150 - a handful of real frames must not "
                         "drown in tens of thousands of synthetic ones)")
    ap.add_argument("--init", default=None, help="checkpoint to initialize from (M5 fine-tune)")
    ap.add_argument("--resume", default=None,
                    help="resume an interrupted run: its last.pt (or run dir). Requires identical "
                         "--data/--epochs/--batch - if the schedule length changed, start fresh instead")
    ap.add_argument("--real-val", default="../data_real_val",
                    help="held-out real-photo root; every image in it is evaluated each epoch "
                         "(real_px in the log). '' disables. NEVER pass this root to --data.")
    ap.add_argument("--select", choices=["synth", "real"], default="synth",
                    help="which val picks best.pt: synthetic val_px (default) or held-out real_px "
                         "(use 'real' for fine-tunes - synthetic val favors the least-adapted epoch)")
    ap.add_argument("--head", choices=list(HEADS), default="center",
                    help="'center': anonymous-quad CenterNet head (default since 2026-09-12). "
                         "'legacy': the named-slot FC regression head - kept so old checkpoints "
                         "stay trainable/comparable, not for new runs")
    ap.add_argument("--out", default="runs/base")
    ap.add_argument("--epochs", type=int, default=30)
    ap.add_argument("--batch", type=int, default=64)
    ap.add_argument("--lr", type=float, default=3e-4)
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--overfit", type=int, default=0, help="train+val on the first N samples, no augmentation")
    args = ap.parse_args()

    device = "cuda" if torch.cuda.is_available() else "cpu"
    # Static input shape and a fixed batch size: let cuDNN pick kernels once.
    torch.backends.cudnn.benchmark = True
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    roots = []
    for spec in args.data.split(","):
        if not spec:
            continue
        path, _, rep = spec.partition("*")
        roots.append((path, max(1, int(rep or 1))))

    def concat(split, augment):
        parts = []
        for path, rep in roots:
            ds = CubeKeypointDataset(path, split=split, input_size=INPUT_WH, augment=augment,
                                     raw_uint8=True)
            if len(ds):
                parts.extend([ds] * (rep if split == "train" or split == "all" else 1))
        return ConcatDataset(parts)

    if args.overfit:
        ds = concat("all", None)
        train_ds = val_ds = Subset(ds, range(min(args.overfit, len(ds))))
    else:
        train_ds = concat("train", augment_sample)
        val_ds = concat("val", None)
    # Workers hand back uint8 HWC; normalize_batch runs on the GPU after the
    # copy. Measured 2026-09-12: the per-sample float path cost 0.63 ms of
    # worker CPU and quadrupled the bytes through pin_memory and PCIe.
    train_dl = DataLoader(train_ds, batch_size=args.batch, shuffle=True, num_workers=args.workers,
                          pin_memory=(device == "cuda"), persistent_workers=args.workers > 0)
    val_dl = DataLoader(val_ds, batch_size=args.batch, shuffle=False, num_workers=0)
    real_dl = None
    if args.real_val:
        rv = CubeKeypointDataset(args.real_val, split="all", input_size=INPUT_WH, augment=None,
                                 raw_uint8=True)
        if len(rv):
            real_dl = DataLoader(rv, batch_size=args.batch, shuffle=False, num_workers=0)
    print(f"device={device}  train={len(train_ds)}  val={len(val_ds)}"
          + (f"  real_val={len(real_dl.dataset)}" if real_dl else ""))

    model = build_model(args.head, pretrained=True, input_hw=(INPUT_WH[1], INPUT_WH[0])).to(device)
    grid_hw = getattr(model, "grid_hw", None)
    print(f"head={args.head}  params={count_params(model) / 1e6:.2f}M"
          + (f"  grid={grid_hw[0]}x{grid_hw[1]}" if grid_hw else ""))
    if args.head == "center":
        dataset_target_stats(val_ds, grid_hw, name="val")
        if real_dl is not None:
            dataset_target_stats(real_dl.dataset, grid_hw, name="real_val")
    if args.init and args.resume:
        raise SystemExit("--init and --resume are mutually exclusive")
    if args.init:
        ckpt = torch.load(args.init, map_location=device, weights_only=True)
        if ckpt.get("head", "legacy") != args.head:
            raise SystemExit(f"--init {args.init} has head {ckpt.get('head', 'legacy')!r}, "
                             f"this run is {args.head!r} - the heads share no weights")
        model.load_state_dict(ckpt["model"])
        print(f"initialized from {args.init} (epoch {ckpt.get('epoch')}, val_px {ckpt.get('val_px')})")
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    total_steps = args.epochs * max(1, len(train_dl))
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=args.lr, total_steps=total_steps)
    scaler = torch.amp.GradScaler(enabled=device == "cuda")

    best_px = float("inf")
    log = []
    start_epoch = 1
    if args.resume:
        rp = Path(args.resume)
        if rp.is_dir():
            rp = rp / "last.pt"
        ckpt = torch.load(rp, map_location=device, weights_only=True)
        if "opt" not in ckpt:
            raise SystemExit(f"{rp} predates resumable checkpoints (no optimizer state) - start fresh")
        # The LR schedule is positional: if the dataset, epochs, or batch size
        # changed, the step count differs and resuming would train on a wrong
        # schedule. Refuse rather than silently degrade.
        if ckpt.get("head", "legacy") != args.head:
            raise SystemExit(f"resume mismatch: checkpoint head {ckpt.get('head', 'legacy')!r} "
                             f"vs --head {args.head!r}")
        if ckpt.get("total_steps") != total_steps:
            raise SystemExit(f"resume mismatch: checkpoint expects total_steps={ckpt.get('total_steps')}, "
                             f"this invocation has {total_steps} (data/epochs/batch changed?) - start fresh")
        model.load_state_dict(ckpt["model"])
        opt.load_state_dict(ckpt["opt"])
        sched.load_state_dict(ckpt["sched"])
        scaler.load_state_dict(ckpt["scaler"])
        best_px = ckpt.get("best_px", float("inf"))
        log = list(ckpt.get("log", []))
        start_epoch = ckpt["epoch"] + 1
        print(f"resumed {rp} at epoch {start_epoch}/{args.epochs} (best val_px so far {best_px:.2f})")

    for epoch in range(start_epoch, args.epochs + 1):
        model.train()
        t0 = time.time()
        # Loss running sums stay on the device: `.item()` / `float()` on a
        # CUDA tensor is a full sync, and three of them per step kept the CPU
        # from queueing the next H2D copy behind the current step's kernels.
        run_loss = torch.zeros((), device=device)
        run_heat = torch.zeros((), device=device)
        run_off = torch.zeros((), device=device)
        n = 0
        for x, conf, corners, valid in train_dl:
            x, conf, corners, valid = x.to(device, non_blocking=True), conf.to(device), corners.to(device), valid.to(device)
            x = normalize_batch(x)
            opt.zero_grad(set_to_none=True)
            targets = (build_center_targets(conf, corners, valid, grid_hw)
                       if args.head == "center" else None)
            with torch.amp.autocast(device_type="cuda", enabled=device == "cuda"):
                pred = model(x)
                loss, lh, lo = (center_loss(pred, targets) if args.head == "center"
                                else keypoint_loss(pred, conf, corners, valid))
            scaler.scale(loss).backward()
            scaler.step(opt)
            scaler.update()
            sched.step()
            run_loss += loss.detach() * x.size(0)
            run_heat += torch.as_tensor(lh, device=device).detach() * x.size(0)
            run_off += torch.as_tensor(lo, device=device).detach() * x.size(0)
            n += x.size(0)
        run_loss, run_heat, run_off = run_loss.item(), run_heat.item(), run_off.item()
        vloss, vpx, vacc = evaluate(model, val_dl, device, args.head, grid_hw)
        rpx = None
        if real_dl is not None:
            _, rpx, _ = evaluate(model, real_dl, device, args.head, grid_hw)
        line = (f"epoch {epoch:3d}  train_loss {run_loss / n:.4f}  val_loss {vloss:.4f}  "
                f"val_px {vpx:.2f}  val_conf_acc {vacc:.3f}  {time.time() - t0:.0f}s"
                + (f"  real_px {rpx:.2f}" if rpx is not None else "")
                + (f"  heat {run_heat / n:.4f}  off {run_off / n:.4f}" if args.head == "center" else ""))
        print(line, flush=True)
        log.append(line)
        slim = {"model": model.state_dict(), "input_wh": INPUT_WH, "epoch": epoch,
                "val_px": vpx, "real_px": rpx, "head": args.head}
        select_px = rpx if (args.select == "real" and rpx is not None) else vpx
        if select_px < best_px:
            best_px = select_px
            torch.save(slim, out / "best.pt")
        # last.pt carries full training state so an interrupted run can
        # --resume; best.pt stays slim (it's what export/fine-tune consume)
        torch.save({**slim, "opt": opt.state_dict(), "sched": sched.state_dict(),
                    "scaler": scaler.state_dict(), "best_px": best_px,
                    "total_steps": total_steps, "log": log}, out / "last.pt")
    which = "real_px" if args.select == "real" and real_dl is not None else "val_px"
    (out / "log.txt").write_text("\n".join(log) + f"\nbest {which} {best_px:.2f}\n")
    print(f"best {which} {best_px:.2f}  ->  {out / 'best.pt'}")


if __name__ == "__main__":
    main()
