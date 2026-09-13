"""Stage-1 cube localizer: tiny convnet, 160x120 in, [objectness, cx, cy, w, h] out.

    python train_bbox.py --data ../data_v4,../data_real*40 --coco ../roboflow --epochs 40 --out runs/box4

Console lines match train.py's format so watch.py's dashboard picks runs up
unchanged (val_px here = mean bbox-corner error in 160x120 pixels;
val_conf_acc = objectness accuracy). `real_iou` is the yardstick: IoU against
the hand-labelled silhouettes in ../data_real_val, which is NEVER trained on.

Two heads, `--head`:

  gap    (v1, runs/box1..box3) 5 stride-2 blocks -> global average pool ->
         MLP -> 5 numbers. GAP throws away where everything was, so the MLP
         has to reconstruct a box from channel means. Measured ceiling: on
         data_v4 val frames with NO occluder at all it reaches IoU 0.833,
         and 12.9% of them land below 0.7. That variance is the whole bug -
         the median box is the right size, a long tail of frames clips the
         cube.
  dense  (default) the same body truncated at stride 16 -> an 8x10 grid of
         per-cell predictions (objectness, centre offset, w, h), reduced
         inside the graph to one box by an objectness-weighted average, and
         re-logit'd so the exported output is bit-compatible with the
         existing [1,5] contract in web/src/detect/cubebox.ts (sigmoid each
         of 1..4, multiply by input w/h). Every cell over the cube votes for
         the same box, so the read-out averages ~10 votes instead of relying
         on one global pooled vector. Offsets can reach +-0.5 of the frame
         from their own cell, so a cell anywhere on the cube can name the
         true centre.
"""
from __future__ import annotations

import argparse
import time
from pathlib import Path

import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.utils.data import ConcatDataset, DataLoader

from bbox_data import BOX_WH, CocoBBox, SynthBBox

GRID_W, GRID_H = 10, 8  # 160x120 at stride 16
OFFSET_RANGE = 0.5      # how far (in frame widths) a cell may point


def _blocks(chans):
    layers: list[nn.Module] = []
    for a, b in zip(chans, chans[1:]):
        layers += [nn.Conv2d(a, b, 3, stride=2, padding=1, bias=False), nn.BatchNorm2d(b), nn.ReLU(inplace=True)]
    return nn.Sequential(*layers)


class TinyBox(nn.Module):
    """~0.2M params. 5 stride-2 conv blocks -> GAP -> 5 outputs."""

    def __init__(self):
        super().__init__()
        self.body = _blocks([3, 16, 32, 64, 96, 128])
        self.head = nn.Sequential(nn.Linear(128, 64), nn.ReLU(inplace=True), nn.Linear(64, 5))

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        y = self.body(x).mean(dim=(2, 3))
        return self.head(y)  # [obj_logit, 4 raw box coords -> sigmoid downstream]


def _logit(p: torch.Tensor) -> torch.Tensor:
    p = p.clamp(1e-4, 1 - 1e-4)
    return torch.log(p) - torch.log1p(-p)


class DenseBox(nn.Module):
    """Per-cell box votes at stride 16, pooled by objectness into one box.

    The reduction lives in `forward` so the ONNX graph still emits [1,5] in
    the raw-logit convention cubebox.ts already decodes - no web change.
    """

    def __init__(self):
        super().__init__()
        self.body = _blocks([3, 16, 32, 64, 96])           # -> (96, 8, 10)
        self.neck = nn.Sequential(nn.Conv2d(96, 96, 3, padding=1, bias=False),
                                  nn.BatchNorm2d(96), nn.ReLU(inplace=True))
        self.head = nn.Conv2d(96, 5, 1)
        self.register_buffer("gx", ((torch.arange(GRID_W) + 0.5) / GRID_W).view(1, 1, GRID_W))
        self.register_buffer("gy", ((torch.arange(GRID_H) + 0.5) / GRID_H).view(1, GRID_H, 1))

    def maps(self, x: torch.Tensor) -> torch.Tensor:
        return self.head(self.neck(self.body(x)))  # (B,5,8,10)

    def reduce(self, m: torch.Tensor) -> torch.Tensor:
        o = m[:, 0]                                         # (B,8,10)
        p = torch.softmax(o.flatten(1), dim=1).view_as(o)
        cx = self.gx + (torch.sigmoid(m[:, 1]) - 0.5) * OFFSET_RANGE
        cy = self.gy + (torch.sigmoid(m[:, 2]) - 0.5) * OFFSET_RANGE
        w = torch.sigmoid(m[:, 3])
        h = torch.sigmoid(m[:, 4])
        box = torch.stack([(p * cx).sum((1, 2)), (p * cy).sum((1, 2)),
                           (p * w).sum((1, 2)), (p * h).sum((1, 2))], dim=1)
        obj = o.flatten(1).amax(dim=1, keepdim=True)
        return torch.cat([obj, _logit(box)], dim=1)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.reduce(self.maps(x))


def build_box_model(head: str) -> nn.Module:
    return DenseBox() if head == "dense" else TinyBox()


def boxes_from(pred: torch.Tensor):
    return torch.sigmoid(pred[:, 1:])


def iou(a: torch.Tensor, b: torch.Tensor) -> torch.Tensor:
    """cxcywh IoU, elementwise over the batch."""
    ax0, ay0 = a[:, 0] - a[:, 2] / 2, a[:, 1] - a[:, 3] / 2
    ax1, ay1 = a[:, 0] + a[:, 2] / 2, a[:, 1] + a[:, 3] / 2
    bx0, by0 = b[:, 0] - b[:, 2] / 2, b[:, 1] - b[:, 3] / 2
    bx1, by1 = b[:, 0] + b[:, 2] / 2, b[:, 1] + b[:, 3] / 2
    iw = (torch.min(ax1, bx1) - torch.max(ax0, bx0)).clamp(min=0)
    ih = (torch.min(ay1, by1) - torch.max(ay0, by0)).clamp(min=0)
    inter = iw * ih
    union = a[:, 2] * a[:, 3] + b[:, 2] * b[:, 3] - inter
    return inter / union.clamp(min=1e-6)


def _giou(a: torch.Tensor, b: torch.Tensor) -> torch.Tensor:
    """cxcywh GIoU per row. Penalizes undersized boxes far better than
    coordinate L1 (v1's boxes systematically undershot the cube's extent)."""
    ax0, ay0 = a[:, 0] - a[:, 2] / 2, a[:, 1] - a[:, 3] / 2
    ax1, ay1 = a[:, 0] + a[:, 2] / 2, a[:, 1] + a[:, 3] / 2
    bx0, by0 = b[:, 0] - b[:, 2] / 2, b[:, 1] - b[:, 3] / 2
    bx1, by1 = b[:, 0] + b[:, 2] / 2, b[:, 1] + b[:, 3] / 2
    iw = (torch.min(ax1, bx1) - torch.max(ax0, bx0)).clamp(min=0)
    ih = (torch.min(ay1, by1) - torch.max(ay0, by0)).clamp(min=0)
    inter = iw * ih
    union = (a[:, 2] * a[:, 3] + b[:, 2] * b[:, 3] - inter).clamp(min=1e-6)
    cw = torch.max(ax1, bx1) - torch.min(ax0, bx0)
    chh = torch.max(ay1, by1) - torch.min(ay0, by0)
    hull = (cw * chh).clamp(min=1e-6)
    return inter / union - (hull - union) / hull


def _cell_targets(box: torch.Tensor, obj: torch.Tensor) -> torch.Tensor:
    """A size-scaled Gaussian on the box centre (the stage-2 convention, see
    targets.py). Gives the dense head's objectness map a direct signal instead
    of making the soft-argmax discover which cells matter.

    It was a flat inside-the-box plateau first, and that measurably hurt: the
    read-out then averages the w/h votes of every cell over the cube equally,
    including the rim cells that only see part of it, and big close cubes -
    the ones that cover the most cells - came out ~3% small (box4 lost 0.05-
    0.12 IoU on exactly the frames the previous model got right). Weighting
    the average toward the centre cells fixes that without giving up the
    multi-cell ensemble.
    """
    dev = box.device
    gx = ((torch.arange(GRID_W, device=dev) + 0.5) / GRID_W).view(1, 1, GRID_W)
    gy = ((torch.arange(GRID_H, device=dev) + 0.5) / GRID_H).view(1, GRID_H, 1)
    cx, cy = box[:, 0].view(-1, 1, 1), box[:, 1].view(-1, 1, 1)
    sx = (box[:, 2].view(-1, 1, 1) * 0.25).clamp(min=0.8 / GRID_W)
    sy = (box[:, 3].view(-1, 1, 1) * 0.25).clamp(min=0.8 / GRID_H)
    g = torch.exp(-((gx - cx) ** 2 / (2 * sx ** 2) + (gy - cy) ** 2 / (2 * sy ** 2)))
    # Renormalize so the cell nearest the centre is exactly 1. Without this the
    # peak target is whatever the grid happens to sample - often 0.6-0.9 - and
    # since the exported objectness is `max over cells`, BCE drags it down with
    # the map: box6 scored a real photo at objectness 0.07, i.e. a flat miss,
    # on a frame box3 called at 0.99.
    return g / g.amax(dim=(1, 2), keepdim=True).clamp(min=1e-6) * obj.view(-1, 1, 1)


def criterion(model, x: torch.Tensor, obj: torch.Tensor, box: torch.Tensor, bv: torch.Tensor):
    if isinstance(model, DenseBox):
        m = model.maps(x)
        pred = model.reduce(m)
        cell_loss = F.binary_cross_entropy_with_logits(m[:, 0], _cell_targets(box, obj * bv),
                                                       reduction="none")
        # cells of a positive whose box we don't trust (coco) contribute nothing
        keep = (obj * bv + (1 - obj)).view(-1, 1, 1)
        aux = (cell_loss * keep).sum() / keep.expand_as(cell_loss).sum().clamp(min=1)
    else:
        pred = model(x)
        aux = pred.new_zeros(())
    obj_loss = F.binary_cross_entropy_with_logits(pred[:, 0], obj)
    pb = boxes_from(pred)
    box_l1 = F.smooth_l1_loss(pb, box, reduction="none").mean(dim=1)
    per_box = (1.0 - _giou(pb, box)) + 0.5 * box_l1
    w = obj * bv
    box_loss = (per_box * w).sum() / w.sum().clamp(min=1)
    return obj_loss + 2.0 * box_loss + aux, pred


@torch.no_grad()
def evaluate(model, dl, device):
    model.eval()
    tot = {"loss": 0.0, "px": 0.0, "acc": 0.0, "iou": 0.0, "bad": 0, "n": 0, "npos": 0}
    for x, obj, box, bv in dl:
        x, obj, box, bv = x.to(device), obj.to(device), box.to(device), bv.to(device)
        loss, pred = criterion(model, x, obj, box, bv)
        b = x.size(0)
        tot["loss"] += loss.item() * b
        tot["acc"] += ((torch.sigmoid(pred[:, 0]) > 0.5) == (obj > 0.5)).float().sum().item()
        pos = (obj > 0.5) & (bv > 0.5)
        if pos.any():
            pb = boxes_from(pred)[pos]
            gb = box[pos]
            scale = torch.tensor([BOX_WH[0], BOX_WH[1], BOX_WH[0], BOX_WH[1]], device=device)
            tot["px"] += ((pb - gb).abs() * scale).mean(dim=1).sum().item()
            ii = iou(pb, gb)
            tot["iou"] += ii.sum().item()
            tot["bad"] += int((ii < 0.7).sum())
            tot["npos"] += int(pos.sum())
        tot["n"] += b
    npos = max(1, tot["npos"])
    return (tot["loss"] / tot["n"], tot["px"] / npos, tot["acc"] / tot["n"],
            tot["iou"] / npos, tot["bad"] / npos)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="../data_v4,../data_real*40",
                    help="synthetic/real keypoint roots, comma-separated, *N oversamples")
    ap.add_argument("--coco", default="../roboflow", help="dir of Roboflow COCO exports (each with train/valid)")
    ap.add_argument("--coco-rep", type=int, default=4, help="oversample factor for the small real coco sets")
    ap.add_argument("--coco-box", action="store_true",
                    help="also fit the coco boxes (off: they train objectness only - see bbox_data)")
    ap.add_argument("--real-val", default="../data_real_val", help="held-out hand-labelled photos; never trained on")
    ap.add_argument("--head", default="dense", choices=["dense", "gap"])
    ap.add_argument("--select", default="real", choices=["real", "val"], help="which IoU picks best.pt")
    ap.add_argument("--out", default="runs/box4")
    ap.add_argument("--epochs", type=int, default=40)
    ap.add_argument("--batch", type=int, default=256)
    ap.add_argument("--lr", type=float, default=2e-3)
    ap.add_argument("--workers", type=int, default=8)
    args = ap.parse_args()

    device = "cuda" if torch.cuda.is_available() else "cpu"
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    train_parts, val_parts = [], []
    for spec in args.data.split(","):
        if not spec:
            continue
        path, _, rep = spec.partition("*")
        ds = SynthBBox(path, "train", augment=True)
        if len(ds):
            train_parts.extend([ds] * max(1, int(rep or 1)))
        vs = SynthBBox(path, "val", augment=False)
        if len(vs):
            val_parts.append(vs)
    if args.coco:
        bvalid = 1.0 if args.coco_box else 0.0
        for sub in sorted(Path(args.coco).iterdir()):
            if (sub / "train").is_dir():
                train_parts.extend([CocoBBox(sub / "train", augment=True, box_valid=bvalid)] * args.coco_rep)
            if (sub / "valid").is_dir():
                val_parts.append(CocoBBox(sub / "valid", augment=False, box_valid=bvalid))
    train_ds, val_ds = ConcatDataset(train_parts), ConcatDataset(val_parts)
    train_dl = DataLoader(train_ds, batch_size=args.batch, shuffle=True, num_workers=args.workers,
                          pin_memory=(device == "cuda"), persistent_workers=args.workers > 0)
    val_dl = DataLoader(val_ds, batch_size=args.batch, shuffle=False, num_workers=0)
    real_dl = None
    if args.real_val and Path(args.real_val).exists():
        real_ds = SynthBBox(args.real_val, "all", augment=False)
        real_dl = DataLoader(real_ds, batch_size=64, shuffle=False, num_workers=0)
        print(f"real_val={len(real_ds)} (held out, never trained on)")
    print(f"device={device}  head={args.head}  train={len(train_ds)}  val={len(val_ds)}  "
          f"coco_box={args.coco_box}")

    model = build_box_model(args.head).to(device)
    print(f"params: {sum(p.numel() for p in model.parameters()):,}")
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=args.lr, total_steps=args.epochs * max(1, len(train_dl)))

    best = 0.0
    for epoch in range(1, args.epochs + 1):
        model.train()
        t0 = time.time()
        run, n = 0.0, 0
        for x, obj, box, bv in train_dl:
            x, obj = x.to(device, non_blocking=True), obj.to(device)
            box, bv = box.to(device), bv.to(device)
            opt.zero_grad(set_to_none=True)
            loss, _ = criterion(model, x, obj, box, bv)
            loss.backward()
            opt.step()
            sched.step()
            run += loss.item() * x.size(0)
            n += x.size(0)
        vloss, vpx, vacc, viou, vbad = evaluate(model, val_dl, device)
        riou = rbad = float("nan")
        if real_dl is not None:
            _, _, _, riou, rbad = evaluate(model, real_dl, device)
        print(f"epoch {epoch:3d}  train_loss {run / n:.4f}  val_loss {vloss:.4f}  "
              f"val_px {vpx:.2f}  val_conf_acc {vacc:.3f}  val_iou {viou:.3f}  val_bad {vbad:.3f}  "
              f"real_iou {riou:.3f}  real_bad {rbad:.3f}  {time.time() - t0:.0f}s", flush=True)
        ckpt = {"model": model.state_dict(), "head": args.head, "input_wh": BOX_WH, "epoch": epoch,
                "val_iou": viou, "real_iou": riou}
        torch.save(ckpt, out / "last.pt")
        score = riou if (args.select == "real" and real_dl is not None) else viou
        if score > best:
            best = score
            torch.save(ckpt, out / "best.pt")
    print(f"best {args.select} IoU {best:.3f}  ->  {out / 'best.pt'}")


if __name__ == "__main__":
    main()
