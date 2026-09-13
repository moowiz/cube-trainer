"""Shared pieces of the stage-1 evaluation scripts: the deployed-ONNX
localizer wrapper (letterbox exactly like the app's cubebox.ts), the
silhouette ground truth of a labelled root, and per-photo rows.

    from common import Localizer, labelled_rows, ROOT, WEB
"""
import json
import pathlib
import sys

import numpy as np
import onnxruntime as ort
from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parents[2]          # .../model
WEB = ROOT.parent / "web" / "public" / "models"
PHOTOS = ROOT.parent / "stephens_photos"
sys.path.insert(0, str(ROOT / "train"))
from shapes import MIN_FACE_EDGE_FRAC

sig = lambda v: 1 / (1 + np.exp(-v))


class Localizer:
    """cubebox.onnx + its sidecar. predict(im) -> (objectness, [x0,y0,x1,y1] in source px, scale)."""

    def __init__(self, onnx_path=None, meta_path=None):
        self.meta = json.loads(pathlib.Path(meta_path or WEB / "cubebox.json").read_text())
        _, _, self.ih, self.iw = self.meta["input"]["shape"]
        self.mean = np.array(self.meta["input"]["mean"], np.float32)
        self.std = np.array(self.meta["input"]["std"], np.float32)
        self.sess = ort.InferenceSession(str(onnx_path or WEB / "cubebox.onnx"), providers=["CPUExecutionProvider"])

    def letterbox(self, im: Image.Image):
        sw, sh = im.size
        s = min(self.iw / sw, self.ih / sh)
        dx, dy = (self.iw - sw * s) / 2, (self.ih - sh * s) / 2
        c = Image.new("RGB", (self.iw, self.ih), (114, 114, 114))
        c.paste(im.resize((round(sw * s), round(sh * s)), Image.BILINEAR), (round(dx), round(dy)))
        return c, s, dx, dy

    def predict(self, im: Image.Image):
        c, s, dx, dy = self.letterbox(im)
        x = (np.asarray(c, np.float32) / 255 - self.mean) / self.std
        y = self.sess.run(None, {"image": x.transpose(2, 0, 1)[None]})[0][0]
        cx, cy, w, h = (float(sig(v)) for v in y[1:5])
        cx, w, cy, h = cx * self.iw, w * self.iw, cy * self.ih, h * self.ih
        box = [((cx - w / 2) - dx) / s, ((cy - h / 2) - dy) / s, ((cx + w / 2) - dx) / s, ((cy + h / 2) - dy) / s]
        return float(sig(y[0])), box, s


def gt_box(label: dict):
    """Axis-aligned hull of every visible face's corners, or None (no cube)."""
    pts = [c for v in label["faces"].values() if v.get("visible") and v.get("corners") for c in v["corners"]]
    if not pts:
        return None
    a = np.array(pts, float)
    return [a[:, 0].min(), a[:, 1].min(), a[:, 0].max(), a[:, 1].max()]


def iou(a, b):
    ix0, iy0, ix1, iy1 = max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])
    inter = max(0, ix1 - ix0) * max(0, iy1 - iy0)
    return inter / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter)


def batch_index() -> dict[str, str]:
    """source photo name -> stephens_photos batch (batch1 = the loose photos at the top)."""
    idx = {}
    if PHOTOS.is_dir():
        for f in PHOTOS.iterdir():
            if f.is_file() and f.suffix.lower() in (".jpg", ".jpeg", ".png"):
                idx[f.name] = "batch1"
            elif f.is_dir() and not f.name.startswith("_"):
                for g in f.iterdir():
                    if g.suffix.lower() in (".jpg", ".jpeg", ".png"):
                        idx[g.name] = f.name
    return idx


def labelled_rows(root: pathlib.Path, loc: Localizer, negatives: bool = False):
    """One row per labelled image: IoU, objectness, per-edge insets as a
    fraction of the true box (+ = predicted edge inside the truth), size of the
    true box on the model canvas, range fraction (long side / frame height),
    batch. Cube-less labels are skipped unless negatives=True (then iou is None)."""
    batches = batch_index()
    rows = []
    for lf in sorted((root / "labels").glob("*.json")):
        m = json.loads(lf.read_text())
        gt = gt_box(m)
        if gt is None and not negatives:
            continue
        p = root / m["image"]
        if not p.exists():
            p = root / "images" / pathlib.Path(m["image"]).name
        im = Image.open(p).convert("RGB")
        obj, pb, s = loc.predict(im)
        row = dict(name=lf.stem, batch=batches.get(m.get("source", ""), "-"), obj=obj,
                   portrait=im.height > im.width, frame_h=im.height)
        if gt is None:
            row.update(iou=None, size=0.0, frac=0.0)
        else:
            gw, gh = gt[2] - gt[0], gt[3] - gt[1]
            row.update(iou=iou(gt, pb), wr=(pb[2] - pb[0]) / gw, hr=(pb[3] - pb[1]) / gh,
                       size=max(gw, gh) * s, frac=max(gw, gh) / im.height,
                       left=(pb[0] - gt[0]) / gw, top=(pb[1] - gt[1]) / gh,
                       right=(gt[2] - pb[2]) / gw, bottom=(gt[3] - pb[3]) / gh)
        rows.append(row)
    return rows


# range bins as fractions of the frame height: below the floor, far, mid, near
RANGE_BINS = [(0.0, MIN_FACE_EDGE_FRAC), (MIN_FACE_EDGE_FRAC, 0.188), (0.188, 0.25), (0.25, 9.0)]


def range_bin(frac: float) -> str:
    names = ["<floor", "far", "mid", "near"]
    for name, (lo, hi) in zip(names, RANGE_BINS):
        if lo <= frac < hi:
            return f"{name} {lo:.3f}-{hi:.3f}" if hi < 9 else f"{name} >{lo:.2f}"
    return "?"


def iou_table(rows, key, label):
    """Mean/median IoU, tail, median w/t h/t and the weakest objectness per value of rows[key]."""
    print(f"\n  {label:28s}    n   meanIoU  medIoU  <0.7  med w/t  med h/t  min obj")
    for g in sorted({r[key] for r in rows}, key=str):
        sel = [r for r in rows if r[key] == g and r["iou"] is not None]
        if not sel:
            continue
        io = np.array([r["iou"] for r in sel])
        print(f"  {str(g):28s} {len(sel):4d}   {io.mean():.3f}   {np.median(io):.3f}  {100 * (io < 0.7).mean():4.0f}%"
              f"   {np.median([r['wr'] for r in sel]):.3f}   {np.median([r['hr'] for r in sel]):.3f}"
              f"   {min(r['obj'] for r in sel):.2f}")


def localizer_args(onnx_path):
    """(onnx, meta) for Localizer: a side-exported model uses the sidecar next to it."""
    if not onnx_path:
        return None, None
    p = pathlib.Path(onnx_path)
    meta = p.with_suffix(".json")
    return p, (meta if meta.exists() else None)
