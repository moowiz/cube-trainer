"""Per-photo rows (json + a sorted listing) and size binning for a cubebox
ONNX on a labelled root.

    python bbox_rows.py data_real_val rows.json [cubebox.onnx]
"""
import json
import sys

import numpy as np

from common import ROOT, Localizer, iou_table, labelled_rows, range_bin

root = ROOT / sys.argv[1]
loc = Localizer(sys.argv[3] if len(sys.argv) > 3 else None)
rows = labelled_rows(root, loc)
json.dump(rows, open(sys.argv[2], "w"), indent=1)
print(f"{'name':>12s} {'batch':>7s} {'size':>6s} {'IoU':>6s} {'w/t':>5s} {'h/t':>5s}  port")
for r in sorted(rows, key=lambda r: r["iou"]):
    print(f"{r['name'][-9:]:>12s} {r['batch']:>7s} {r['size']:6.1f} {r['iou']:6.3f} {r['wr']:5.2f} {r['hr']:5.2f}"
          f"  {int(r['portrait'])}")
for r in rows:
    r["range"] = range_bin(r["frac"])
io = np.array([r["iou"] for r in rows])
print(f"\n  all {len(rows)}: mean IoU {io.mean():.3f}  median {np.median(io):.3f}"
      f"  med w/t {np.median([r['wr'] for r in rows]):.3f}  med h/t {np.median([r['hr'] for r in rows]):.3f}")
iou_table(rows, "range", f"size bin (true long side / frame h; {loc.iw}x{loc.ih} canvas)")
iou_table(rows, "portrait", "portrait (1) / landscape (0)")
