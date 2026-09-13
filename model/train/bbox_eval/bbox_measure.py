"""Per-edge signed error of the deployed cubebox against hand-labelled photos.

Ground truth for a convex cube: the axis-aligned bounding box of every visible
face's corners. Positive error = the predicted edge is INSIDE the true box
(i.e. the prediction is too small on that side).
"""
import json, pathlib, sys
import numpy as np, onnxruntime as ort
from PIL import Image

ROOT = pathlib.Path(r"C:\Users\moowi\Documents\GitHub\cube_stuff\model")
WEB = ROOT.parent / "web" / "public" / "models"
meta = json.loads((WEB / "cubebox.json").read_text())
_, _, IH, IW = meta["input"]["shape"]
mean = np.array(meta["input"]["mean"], np.float32); std = np.array(meta["input"]["std"], np.float32)
sess = ort.InferenceSession(str(WEB / "cubebox.onnx"), providers=["CPUExecutionProvider"])
sig = lambda v: 1 / (1 + np.exp(-v))

def predict(im):
    sw, sh = im.size
    scale = min(IW / sw, IH / sh)
    dx, dy = (IW - sw * scale) / 2, (IH - sh * scale) / 2
    canvas = Image.new("RGB", (IW, IH), (114, 114, 114))
    canvas.paste(im.resize((round(sw * scale), round(sh * scale)), Image.BILINEAR), (round(dx), round(dy)))
    x = (np.asarray(canvas, np.float32) / 255 - mean) / std
    y = sess.run(None, {"image": x.transpose(2, 0, 1)[None]})[0][0]
    cx, cy, w, h = (float(sig(v)) for v in y[1:5])
    cx, w, cy, h = cx * IW, w * IW, cy * IH, h * IH
    return float(sig(y[0])), [((cx - w/2) - dx)/scale, ((cy - h/2) - dy)/scale,
                              ((cx + w/2) - dx)/scale, ((cy + h/2) - dy)/scale]

root = ROOT / sys.argv[1]
rows = []
for lf in sorted((root / "labels").glob("*.json")):
    m = json.loads(lf.read_text())
    pts = []
    for f, v in m["faces"].items():
        if v.get("visible") and v.get("corners"):
            pts.extend(v["corners"])
    if not pts:
        continue
    a = np.array(pts, float)
    gt = [a[:,0].min(), a[:,1].min(), a[:,0].max(), a[:,1].max()]
    im = Image.open(root / m["image"] if (root / m["image"]).exists() else root / "images" / pathlib.Path(m["image"]).name).convert("RGB")
    obj, pb = predict(im)
    gw, gh = gt[2]-gt[0], gt[3]-gt[1]
    ix0, iy0 = max(gt[0], pb[0]), max(gt[1], pb[1])
    ix1, iy1 = min(gt[2], pb[2]), min(gt[3], pb[3])
    inter = max(0, ix1-ix0) * max(0, iy1-iy0)
    iou = inter / (gw*gh + (pb[2]-pb[0])*(pb[3]-pb[1]) - inter)
    rows.append({
        "iou": iou, "obj": obj,
        "left":  (pb[0]-gt[0]) / gw, "top":    (pb[1]-gt[1]) / gh,
        "right": (gt[2]-pb[2]) / gw, "bottom": (gt[3]-pb[3]) / gh,
        "wr": (pb[2]-pb[0]) / gw, "hr": (pb[3]-pb[1]) / gh,
    })

def stat(k):
    v = np.array([r[k] for r in rows])
    return f"{v.mean():+.3f} (median {np.median(v):+.3f}, sd {v.std():.3f})"

print(f"{root.name}: {len(rows)} labelled photos, objectness min {min(r['obj'] for r in rows):.2f}")
print(f"  IoU            mean {np.mean([r['iou'] for r in rows]):.3f}  median {np.median([r['iou'] for r in rows]):.3f}")
print(f"  width  / true  {stat('wr')}")
print(f"  height / true  {stat('hr')}")
print("  per-edge inset as a fraction of the true box (+ = predicted edge is inside the truth):")
for k in ("left", "top", "right", "bottom"):
    print(f"    {k:7s} {stat(k)}")
