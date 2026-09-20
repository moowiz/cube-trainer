"""Train the stage-2 face keypoint model (M4) on padded silhouette crops.

    python train.py --data ../data_v5 --epochs 150 --out runs/kp1
    python train.py --data ../data_v5 --overfit 50 --epochs 150   # pipeline check

The default `--view crop` is the always-two-stage design
(model/PORTRAIT-DESIGN.md): every sample is a padded crop around the cube,
re-drawn per epoch from the crop cache, at the square KP_WH input. There is
no full-frame stage 2 any more.

The overfit run is the correctness test: 50 images, no augmentation, val ==
train. If the pipeline is sound it drives corner error to ~1 px; if it can't,
something upstream (labels, loss, normalization) is broken - fix that before
burning a real run.
"""
from __future__ import annotations

import argparse
import functools
import json
import time
from pathlib import Path

import torch
from torch.utils.data import ConcatDataset, DataLoader, Subset

from augment import augment_sample
from dataset import CubeKeypointDataset, normalize01, normalize_batch, to_float01
from gpu_augment import disable_compile, enable_compile, photometric_batch
from model import (
    HEADS,
    POINT_COUNTS,
    build_model,
    center_loss,
    center_metrics,
    conf_accuracy,
    count_params,
    f1_from_counts,
    keypoint_loss,
    load_center_weights,
    pixel_error,
    twist_counts_zero,
    twist_summary,
)
from shapes import FRAME_CACHE_WH, KP_WH
from targets import build_center_targets, dataset_target_stats

INPUT_WH = KP_WH   # set per --view in main(); evaluate() reads the module global


def evaluate(model, loader, device, head="legacy", grid_hw=None, npts=4, twist=False):
    """-> (loss, px, acc, twist_metrics). For the center head px and acc are
    redefined: `px` is the corner error over MATCHED detections only and
    `acc` is detection F1 at score 0.5, not per-slot visibility accuracy.
    The log-line keys stay val_px / val_conf_acc because watch.py parses
    those exact names - do not compare the numbers across heads.
    `twist_metrics` is model.twist_summary's dict (with the raw counts under
    'counts') when the loader yields twist labels, else {}."""
    model.eval()
    tot = {"loss": 0.0, "px": 0.0, "acc": 0.0, "n": 0}
    err_sum = 0.0
    matched = tp = fp = fn = 0
    twc = twist_counts_zero()
    with torch.no_grad():
        for batch in loader:
            x, conf, corners, valid = (t.to(device, non_blocking=True) for t in batch[:4])
            tw = batch[4].to(device, non_blocking=True) if twist else None
            x = normalize_batch(x)
            pred = model(x)
            b = x.size(0)
            if head == "center":
                t = build_center_targets(conf, corners, valid, grid_hw, npts=npts, twist=tw)
                loss = center_loss(pred, t)[0]
                e, m, a, c, d = center_metrics(pred, conf, corners, valid, INPUT_WH,
                                               twist_t=tw, twist_counts=twc)
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
        twm = {**twist_summary(twc), "counts": twc} if twist and twc["n"] else {}
        return tot["loss"] / n, px, f1_from_counts(tp, fp, fn), twm
    return tot["loss"] / n, tot["px"] / n, tot["acc"] / n, {}


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
    ap.add_argument("--points", type=int, choices=list(POINT_COUNTS), default=4,
                    help="center head: what the offsets regress - 4 = the face corners, "
                         "16 = the 4x4 seam grid derived from them (2026-09-13; interior "
                         "junctions are sharper targets and overdetermine the warp). "
                         "val_px/real_px stay the CORNER error either way, so runs compare")
    ap.add_argument("--twist", action="store_true",
                    help="center head: add the twist head (M13) - 8 more channels per cell: which of "
                         "the quad's edges borders a turning layer (or the quad itself is one) and the "
                         "angle mod 90. Reads the labels' `twist` field (pre-M13 synthetic labels are "
                         "converted from meta.layerTwist; real labels without it are static cubes). "
                         "--init from a checkpoint without it keeps the heatmap and corner weights")
    ap.add_argument("--view", choices=["crop", "frame"], default="crop",
                    help="'crop' (the deployed stage-2 view: padded silhouette crops at "
                         f"{KP_WH[0]}x{KP_WH[1]}); 'frame' trains on whole letterboxed frames at "
                         f"{FRAME_CACHE_WH[0]}x{FRAME_CACHE_WH[1]} - experiments only, the app never runs it")
    ap.add_argument("--out", default="runs/base")
    ap.add_argument("--epochs", type=int, default=30)
    ap.add_argument("--batch", type=int, default=64)
    ap.add_argument("--lr", type=float, default=3e-4)
    ap.add_argument("--head-lr-mult", type=float, default=1.0,
                    help="center head: the last 1x1 conv's learning rate as a multiple of --lr. A "
                         "--twist fine-tune from a checkpoint without the head starts its twist "
                         "channels from scratch: at the fine-tune's 5e-5 they barely move in 15 "
                         "epochs, so give the head ~10x (DECISION 2026-09-20, untested at scale)")
    ap.add_argument("--workers", type=int, default=8,
                    help="DataLoader workers. 8 with --compile (the main thread is idle enough "
                         "for them to pay), 4 with --compile off; ~56%% CPU either way")
    ap.add_argument("--overfit", type=int, default=0, help="train+val on the first N samples, no augmentation")
    ap.add_argument("--compile", choices=["auto", "on", "off"], default="auto",
                    help="torch.compile(mode='reduce-overhead') the model and the GPU augmentation. "
                         "'auto' tries and falls back to eager if compilation fails (no Triton / "
                         "compiler on this machine); 'on' makes that failure fatal")
    args = ap.parse_args()

    device = "cuda" if torch.cuda.is_available() else "cpu"
    global INPUT_WH
    INPUT_WH = KP_WH if args.view == "crop" else FRAME_CACHE_WH
    # Static input shape and a fixed batch size: let cuDNN pick kernels once.
    torch.backends.cudnn.benchmark = True
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    # watch.py reads this for the ETA: the log lines alone never say how many
    # epochs the run is aiming at. Written before epoch 1 so a run is
    # projectable from its first line, and rewritten on --resume.
    (out / "meta.json").write_text(json.dumps({
        "epochs": args.epochs, "data": args.data, "batch": args.batch,
        "workers": args.workers, "head": args.head, "lr": args.lr, "npts": args.points,
        "view": args.view, "input_wh": INPUT_WH, "started": time.time(), "twist": args.twist,
    }, indent=1))

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
                                     raw_uint8=True, view=args.view, with_twist=args.twist)
            if len(ds):
                parts.extend([ds] * (rep if split == "train" or split == "all" else 1))
        return ConcatDataset(parts)

    if args.overfit:
        ds = concat("all", None)
        train_ds = val_ds = Subset(ds, range(min(args.overfit, len(ds))))
    else:
        # Workers do geometry + JPEG + erasing; the photometric half runs
        # batched on the GPU in the loop below (gpu_augment.py has the why).
        train_ds = concat("train", functools.partial(augment_sample, photometric=False))
        val_ds = concat("val", None)
    # Workers hand back uint8 HWC; normalize_batch runs on the GPU after the
    # copy. Measured 2026-09-12: the per-sample float path cost 0.63 ms of
    # worker CPU and quadrupled the bytes through pin_memory and PCIe.
    train_dl = DataLoader(train_ds, batch_size=args.batch, shuffle=True, num_workers=args.workers,
                          pin_memory=(device == "cuda"), persistent_workers=args.workers > 0,
                          prefetch_factor=4 if args.workers else None)
    # Eval is unaugmented (~1 ms/sample) but was single-process: ~5-8 s of
    # every epoch. Two workers, not eight - it is a small fraction of the run.
    val_workers = min(2, args.workers)
    val_dl = DataLoader(val_ds, batch_size=args.batch, shuffle=False, num_workers=val_workers,
                        persistent_workers=val_workers > 0)
    real_dl = None
    if args.real_val:
        rv = CubeKeypointDataset(args.real_val, split="all", input_size=INPUT_WH, augment=None,
                                 raw_uint8=True, view=args.view, with_twist=args.twist)
        if len(rv):
            real_dl = DataLoader(rv, batch_size=args.batch, shuffle=False, num_workers=0)  # 42 images
    print(f"device={device}  view={args.view} {INPUT_WH[0]}x{INPUT_WH[1]}  train={len(train_ds)}  val={len(val_ds)}"
          + (f"  real_val={len(real_dl.dataset)}" if real_dl else ""))

    if args.twist and args.head != "center":
        raise SystemExit("--twist needs --head center")
    model = build_model(args.head, pretrained=True, input_hw=(INPUT_WH[1], INPUT_WH[0]),
                        npts=args.points, twist=args.twist).to(device)
    grid_hw = getattr(model, "grid_hw", None)
    # `model` stays the plain module: checkpoints, --init/--resume, the
    # optimizer and export all see it. `run` is what forward goes through -
    # the compiled wrapper shares its parameters. Measured 2026-09-12 (batch
    # 64): fwd+bwd+opt 20.2 ms eager -> 13.8 ms with reduce-overhead (Inductor
    # fusion + CUDA graphs), and the fused augmentation stages on top.
    compiled = device == "cuda" and args.compile != "off"
    run = torch.compile(model, mode="reduce-overhead", dynamic=False) if compiled else model
    if compiled:
        enable_compile()
    print(f"head={args.head}  params={count_params(model) / 1e6:.2f}M"
          + (f"  grid={grid_hw[0]}x{grid_hw[1]}  points={args.points}" if grid_hw else "")
          + ("  twist=on" if args.twist else ""))
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
        if args.head == "center" and ckpt.get("npts", 4) != args.points:
            raise SystemExit(f"--init {args.init} regresses {ckpt.get('npts', 4)} points, this run "
                             f"{args.points} - the head's last layer differs; pass --points to match")
        if tuple(ckpt.get("input_wh", ())) != tuple(INPUT_WH) or ckpt.get("view", "frame") != args.view:
            # DECISION (PORTRAIT-DESIGN.md 5): no fine-tuning across shapes/views;
            # a landscape full-frame checkpoint is not a starting point for a crop model.
            raise SystemExit(f"--init {args.init} is view={ckpt.get('view', 'frame')!r} "
                             f"input_wh={ckpt.get('input_wh')} - this run is {args.view!r} {INPUT_WH}")
        note = ""
        if args.head == "center":
            # a twist run may start from a plain kpft checkpoint (and vice
            # versa): the head's last conv is grown / trimmed, the rest loads
            note = "; " + load_center_weights(model, ckpt["model"])
        else:
            model.load_state_dict(ckpt["model"])
        print(f"initialized from {args.init} (epoch {ckpt.get('epoch')}, val_px {ckpt.get('val_px')}){note}")
    # fused=True: one multi-tensor kernel instead of ~150 foreach launches
    # (12.6 -> 0.9 ms/step measured 2026-09-12), and GradScaler hands the fused
    # step its found_inf tensor instead of calling .item() on it - the last
    # per-step device sync in the loop.
    head_params = list(model.head.parameters()) if hasattr(model, "head") and args.head_lr_mult != 1.0 else []
    head_ids = {id(p) for p in head_params}
    groups = [{"params": [p for p in model.parameters() if id(p) not in head_ids], "lr": args.lr}]
    if head_params:
        groups.append({"params": head_params, "lr": args.lr * args.head_lr_mult})
        print(f"head lr x{args.head_lr_mult:g} ({len(head_params)} tensors)")
    opt = torch.optim.AdamW(groups, lr=args.lr, weight_decay=1e-4, fused=(device == "cuda"))
    total_steps = args.epochs * max(1, len(train_dl))
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=[g["lr"] for g in groups], total_steps=total_steps)
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
        if args.head == "center" and ckpt.get("npts", 4) != args.points:
            raise SystemExit(f"resume mismatch: checkpoint npts {ckpt.get('npts', 4)} vs --points {args.points}")
        if bool(ckpt.get("twist", False)) != args.twist:
            raise SystemExit(f"resume mismatch: checkpoint twist={ckpt.get('twist', False)} vs --twist {args.twist}")
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

    def forward_train(x):
        nonlocal run, compiled
        try:
            return run(x)
        except Exception as e:
            if not compiled or args.compile == "on":
                raise
            print(f"torch.compile failed, continuing eager: {str(e).splitlines()[0][:160]}", flush=True)
            run, compiled = model, False
            disable_compile()
            return run(x)

    for epoch in range(start_epoch, args.epochs + 1):
        model.train()
        t0 = time.time()
        # Loss running sums stay on the device: `.item()` / `float()` on a
        # CUDA tensor is a full sync, and three of them per step kept the CPU
        # from queueing the next H2D copy behind the current step's kernels.
        run_loss = torch.zeros((), device=device)
        run_heat = torch.zeros((), device=device)
        run_off = torch.zeros((), device=device)
        run_tcls = torch.zeros((), device=device)
        run_tang = torch.zeros((), device=device)
        n = 0
        for batch in train_dl:
            if compiled:
                # reduce-overhead = CUDA graphs: tell the runtime the previous
                # step's graph outputs (pred) may now be overwritten.
                torch.compiler.cudagraph_mark_step_begin()
            # All of them come out of the DataLoader pinned; a blocking .to() on
            # any of them is a stream sync (memcpy + cudaStreamSynchronize).
            x, conf, corners, valid = (t.to(device, non_blocking=True) for t in batch[:4])
            tw = batch[4].to(device, non_blocking=True) if args.twist else None
            x = to_float01(x)
            if not args.overfit:   # overfit runs are unaugmented end to end
                x = photometric_batch(x)
            x = normalize01(x)
            opt.zero_grad(set_to_none=True)
            targets = (build_center_targets(conf, corners, valid, grid_hw, npts=args.points, twist=tw)
                       if args.head == "center" else None)
            with torch.amp.autocast(device_type="cuda", enabled=device == "cuda"):
                pred = forward_train(x)
                if args.head == "center":
                    loss, lh, lo, lc, la = center_loss(pred, targets)
                else:
                    loss, lh, lo = keypoint_loss(pred, conf, corners, valid)
                    lc = la = 0.0
            scaler.scale(loss).backward()
            scaler.step(opt)
            scaler.update()
            sched.step()
            run_loss += loss.detach() * x.size(0)
            run_heat += torch.as_tensor(lh, device=device).detach() * x.size(0)
            run_off += torch.as_tensor(lo, device=device).detach() * x.size(0)
            run_tcls += torch.as_tensor(lc, device=device).detach() * x.size(0)
            run_tang += torch.as_tensor(la, device=device).detach() * x.size(0)
            n += x.size(0)
        run_loss, run_heat, run_off = run_loss.item(), run_heat.item(), run_off.item()
        run_tcls, run_tang = run_tcls.item(), run_tang.item()
        t_train = time.time() - t0
        # Eval goes through the plain module: it is ~2 s/epoch eager, and the
        # compiled path would build a graph per eval batch shape (val, val's
        # last batch, real_val) at ~25 s each for nothing.
        vloss, vpx, vacc, vtw = evaluate(model, val_dl, device, args.head, grid_hw, args.points, args.twist)
        rpx = None
        rtw = {}
        if real_dl is not None:
            _, rpx, _, rtw = evaluate(model, real_dl, device, args.head, grid_hw, args.points, args.twist)
        # twist metrics (M13): tw_f1 = a face read as twisted vs not, tw_cls
        # = the right edge / self among twisted faces, tw_deg = mean angle
        # error mod 90 in degrees; real_tw_* the same on the held-out real
        # frames, printed only once some of those carry twist labels.
        twist_fields = ""
        if args.twist:
            twist_fields = f"  tcls {run_tcls / n:.4f}  tang {run_tang / n:.4f}"
            if vtw:
                twist_fields += f"  tw_f1 {vtw['tw_f1']:.3f}  tw_cls {vtw['tw_cls']:.3f}  tw_deg {vtw['tw_deg']:.1f}"
            if rtw and rtw["counts"]["twisted"]:
                twist_fields += f"  real_tw_f1 {rtw['tw_f1']:.3f}  real_tw_cls {rtw['tw_cls']:.3f}"
        line = (f"epoch {epoch:3d}  train_loss {run_loss / n:.4f}  val_loss {vloss:.4f}  "
                f"val_px {vpx:.2f}  val_conf_acc {vacc:.3f}  {time.time() - t0:.0f}s"
                + (f"  real_px {rpx:.2f}" if rpx is not None else "")
                + (f"  heat {run_heat / n:.4f}  off {run_off / n:.4f}" if args.head == "center" else "")
                + twist_fields
                # steps-only time and images/s: the epoch total above also
                # holds val + real_val. Appended last so watch.py's regex,
                # which reads the fields up to "<total>s", is untouched.
                + f"  train {t_train:.0f}s {n / t_train:.0f}img/s  eval {time.time() - t0 - t_train:.0f}s")
        print(line, flush=True)
        log.append(line)
        slim = {"model": model.state_dict(), "input_wh": INPUT_WH, "view": args.view, "epoch": epoch,
                "val_px": vpx, "real_px": rpx, "head": args.head, "npts": args.points, "twist": args.twist,
                "twist_metrics": vtw or None}
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
