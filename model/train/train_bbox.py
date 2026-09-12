"""Stage-1 cube localizer: tiny convnet, 160x120 in, [objectness, cx, cy, w, h] out.

    python train_bbox.py --data ../data_v3,../data_real*20 --coco ../roboflow --epochs 20 --out runs/box1

Console lines match train.py's format so watch.py's dashboard picks runs up
unchanged (val_px here = mean bbox-corner error in 160x120 pixels;
val_conf_acc = objectness accuracy). Prints mean IoU at the end.
"""
from __future__ import annotations

import argparse
import time
from pathlib import Path

import torch
import torch.nn as nn
from torch.utils.data import ConcatDataset, DataLoader

from bbox_data import BOX_WH, CocoBBox, SynthBBox


class TinyBox(nn.Module):
    """~0.2M params. 5 stride-2 conv blocks -> GAP -> 5 outputs."""

    def __init__(self):
        super().__init__()
        chans = [3, 16, 32, 64, 96, 128]
        layers: list[nn.Module] = []
        for a, b in zip(chans, chans[1:]):
            layers += [nn.Conv2d(a, b, 3, stride=2, padding=1, bias=False), nn.BatchNorm2d(b), nn.ReLU(inplace=True)]
        self.body = nn.Sequential(*layers)
        self.head = nn.Sequential(nn.Linear(128, 64), nn.ReLU(inplace=True), nn.Linear(64, 5))

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        y = self.body(x).mean(dim=(2, 3))
        return self.head(y)  # [obj_logit, 4 raw box coords -> sigmoid downstream]


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


def criterion(pred: torch.Tensor, obj: torch.Tensor, box: torch.Tensor):
    obj_loss = nn.functional.binary_cross_entropy_with_logits(pred[:, 0], obj)
    pb = boxes_from(pred)
    box_l1 = nn.functional.smooth_l1_loss(pb, box, reduction="none").mean(dim=1)
    per_box = (1.0 - _giou(pb, box)) + 0.5 * box_l1
    box_loss = (per_box * obj).sum() / obj.sum().clamp(min=1)
    return obj_loss + 2.0 * box_loss


@torch.no_grad()
def evaluate(model, dl, device):
    model.eval()
    tot = {"loss": 0.0, "px": 0.0, "acc": 0.0, "iou": 0.0, "n": 0, "npos": 0}
    for x, obj, box in dl:
        x, obj, box = x.to(device), obj.to(device), box.to(device)
        pred = model(x)
        b = x.size(0)
        tot["loss"] += criterion(pred, obj, box).item() * b
        tot["acc"] += ((torch.sigmoid(pred[:, 0]) > 0.5) == (obj > 0.5)).float().sum().item()
        pos = obj > 0.5
        if pos.any():
            pb = boxes_from(pred)[pos]
            gb = box[pos]
            scale = torch.tensor([BOX_WH[0], BOX_WH[1], BOX_WH[0], BOX_WH[1]], device=device)
            tot["px"] += ((pb - gb).abs() * scale).mean(dim=1).sum().item()
            tot["iou"] += iou(pb, gb).sum().item()
            tot["npos"] += int(pos.sum())
        tot["n"] += b
    return (tot["loss"] / tot["n"], tot["px"] / max(1, tot["npos"]),
            tot["acc"] / tot["n"], tot["iou"] / max(1, tot["npos"]))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="../data_v3",
                    help="synthetic/real keypoint roots, comma-separated, *N oversamples")
    ap.add_argument("--coco", default="../roboflow", help="dir of Roboflow COCO exports (each with train/valid)")
    ap.add_argument("--coco-rep", type=int, default=8, help="oversample factor for the small real coco sets")
    ap.add_argument("--out", default="runs/box1")
    ap.add_argument("--epochs", type=int, default=20)
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
        for sub in sorted(Path(args.coco).iterdir()):
            if (sub / "train").is_dir():
                train_parts.extend([CocoBBox(sub / "train", augment=True)] * args.coco_rep)
            if (sub / "valid").is_dir():
                val_parts.append(CocoBBox(sub / "valid", augment=False))
    train_ds, val_ds = ConcatDataset(train_parts), ConcatDataset(val_parts)
    train_dl = DataLoader(train_ds, batch_size=args.batch, shuffle=True, num_workers=args.workers,
                          pin_memory=(device == "cuda"), persistent_workers=args.workers > 0)
    val_dl = DataLoader(val_ds, batch_size=args.batch, shuffle=False, num_workers=0)
    print(f"device={device}  train={len(train_ds)}  val={len(val_ds)}")

    model = TinyBox().to(device)
    print(f"params: {sum(p.numel() for p in model.parameters()):,}")
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=args.lr, total_steps=args.epochs * max(1, len(train_dl)))

    best_iou = 0.0
    for epoch in range(1, args.epochs + 1):
        model.train()
        t0 = time.time()
        run, n = 0.0, 0
        for x, obj, box in train_dl:
            x, obj, box = x.to(device, non_blocking=True), obj.to(device), box.to(device)
            opt.zero_grad(set_to_none=True)
            loss = criterion(model(x), obj, box)
            loss.backward()
            opt.step()
            sched.step()
            run += loss.item() * x.size(0)
            n += x.size(0)
        vloss, vpx, vacc, viou = evaluate(model, val_dl, device)
        print(f"epoch {epoch:3d}  train_loss {run / n:.4f}  val_loss {vloss:.4f}  "
              f"val_px {vpx:.2f}  val_conf_acc {vacc:.3f}  {time.time() - t0:.0f}s", flush=True)
        ckpt = {"model": model.state_dict(), "input_wh": BOX_WH, "epoch": epoch, "val_iou": viou}
        torch.save(ckpt, out / "last.pt")
        if viou > best_iou:
            best_iou = viou
            torch.save(ckpt, out / "best.pt")
    print(f"best val IoU {best_iou:.3f}  ->  {out / 'best.pt'}")


if __name__ == "__main__":
    main()
