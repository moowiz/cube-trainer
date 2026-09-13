"""Per-edge signed error and IoU of a cubebox ONNX against a labelled root,
overall, per photo batch and per range bin.

    python bbox_measure.py data_real_val [cubebox.onnx]

Ground truth for a convex cube: the axis-aligned bounding box of every visible
face's corners. Positive edge error = the predicted edge is INSIDE the true box
(i.e. the prediction is too small on that side).
"""
import sys

import numpy as np

from common import ROOT, Localizer, iou_table, labelled_rows, localizer_args, range_bin

root = ROOT / sys.argv[1]
loc = Localizer(*localizer_args(sys.argv[2] if len(sys.argv) > 2 else None))
rows = labelled_rows(root, loc, negatives=True)
pos = [r for r in rows if r["iou"] is not None]
neg = [r for r in rows if r["iou"] is None]


def stat(k):
    v = np.array([r[k] for r in pos])
    return f"{v.mean():+.3f} (median {np.median(v):+.3f}, sd {v.std():.3f})"


io = np.array([r["iou"] for r in pos])
print(f"{root.name}: {len(pos)} labelled photos with a cube, objectness min {min(r['obj'] for r in pos):.2f}"
      + (f"; {len(neg)} without, objectness max {max(r['obj'] for r in neg):.2f}" if neg else ""))
print(f"  IoU            mean {io.mean():.3f}  median {np.median(io):.3f}  <0.7 {100 * (io < 0.7).mean():.1f}%"
      f"  missed (obj<0.5) {sum(r['obj'] < 0.5 for r in pos)}")
print(f"  width  / true  {stat('wr')}")
print(f"  height / true  {stat('hr')}")
print("  per-edge inset as a fraction of the true box (+ = predicted edge is inside the truth):")
for k in ("left", "top", "right", "bottom"):
    print(f"    {k:7s} {stat(k)}")
for r in pos:
    r["range"] = range_bin(r["frac"])
iou_table(pos, "batch", "by photo batch")
iou_table(pos, "range", "by range (edge / frame h)")
