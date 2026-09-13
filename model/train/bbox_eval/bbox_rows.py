"""Per-photo rows + size binning for the deployed cubebox on a labelled root."""
import json
import pathlib
import sys

import numpy as np
import onnxruntime as ort
from PIL import Image

ROOT = pathlib.Path(r"C:\Users\moowi\Documents\GitHub\cube_stuff\model")
WEB = ROOT.parent / "web" / "public" / "models"
MODEL = pathlib.Path(sys.argv[3]) if len(sys.argv) > 3 else WEB/"cubebox.onnx"
meta = json.loads((WEB/"cubebox.json").read_text())
_, _, IH, IW = meta["input"]["shape"]
mean = np.array(meta["input"]["mean"], np.float32); std = np.array(meta["input"]["std"], np.float32)
sess = ort.InferenceSession(str(MODEL), providers=["CPUExecutionProvider"])
sig = lambda v: 1/(1+np.exp(-v))

def predict(im):
    sw, sh = im.size
    s = min(IW/sw, IH/sh); dx, dy = (IW-sw*s)/2, (IH-sh*s)/2
    c = Image.new("RGB", (IW, IH), (114,114,114))
    c.paste(im.resize((round(sw*s), round(sh*s)), Image.BILINEAR), (round(dx), round(dy)))
    x = (np.asarray(c, np.float32)/255 - mean)/std
    y = sess.run(None, {"image": x.transpose(2,0,1)[None]})[0][0]
    cx, cy, w, h = (float(sig(v)) for v in y[1:5])
    cx, w, cy, h = cx*IW, w*IW, cy*IH, h*IH
    return float(sig(y[0])), [((cx-w/2)-dx)/s, ((cy-h/2)-dy)/s, ((cx+w/2)-dx)/s, ((cy+h/2)-dy)/s], s

root = ROOT/sys.argv[1]
rows = []
for lf in sorted((root/"labels").glob("*.json")):
    m = json.loads(lf.read_text())
    pts = [c for f,v in m["faces"].items() if v.get("visible") and v.get("corners") for c in v["corners"]]
    if not pts: continue
    a = np.array(pts, float)
    gt = [a[:,0].min(), a[:,1].min(), a[:,0].max(), a[:,1].max()]
    p = root/m["image"]
    if not p.exists(): p = root/"images"/pathlib.Path(m["image"]).name
    im = Image.open(p).convert("RGB")
    obj, pb, s = predict(im)
    gw, gh = gt[2]-gt[0], gt[3]-gt[1]
    ix0,iy0,ix1,iy1 = max(gt[0],pb[0]),max(gt[1],pb[1]),min(gt[2],pb[2]),min(gt[3],pb[3])
    inter = max(0,ix1-ix0)*max(0,iy1-iy0)
    iou = inter/(gw*gh+(pb[2]-pb[0])*(pb[3]-pb[1])-inter)
    rows.append(dict(name=lf.stem, iou=iou, obj=obj, wr=(pb[2]-pb[0])/gw, hr=(pb[3]-pb[1])/gh,
                     size=max(gw,gh)*s, portrait=im.height>im.width,
                     left=(pb[0]-gt[0])/gw, top=(pb[1]-gt[1])/gh,
                     right=(gt[2]-pb[2])/gw, bottom=(gt[3]-pb[3])/gh))
json.dump(rows, open(sys.argv[2], "w"), indent=1)
print(f"{'name':>12s} {'size':>6s} {'IoU':>6s} {'w/t':>5s} {'h/t':>5s}  port")
for r in sorted(rows, key=lambda r: r["iou"]):
    print(f"{r['name'][-9:]:>12s} {r['size']:6.1f} {r['iou']:6.3f} {r['wr']:5.2f} {r['hr']:5.2f}  {int(r['portrait'])}")
sz = np.array([r["size"] for r in rows]); io = np.array([r["iou"] for r in rows])
wr = np.array([r["wr"] for r in rows]); hr = np.array([r["hr"] for r in rows])
print(f"\n size bin (gt long side, px at {IW}x{IH} canvas)   n   meanIoU  medIoU  med w/t  med h/t")
# bins = fractions of the frame height (the range floor is 0.133): far 0.133-0.188, mid 0.188-0.25, near > 0.25
for lo, hi in [(0,round(0.133*IH)),(round(0.133*IH),round(0.188*IH)),(round(0.188*IH),round(0.25*IH)),(round(0.25*IH),999)]:
    k = (sz>=lo)&(sz<hi)
    if k.sum(): print(f"  {lo:3d}-{hi:3d} px  {k.sum():4d}   {io[k].mean():.3f}   {np.median(io[k]):.3f}   {np.median(wr[k]):.3f}   {np.median(hr[k]):.3f}")
print(f"\n  all       {len(rows):4d}   {io.mean():.3f}   {np.median(io):.3f}   {np.median(wr):.3f}   {np.median(hr):.3f}")
for lab, k in [("portrait", np.array([r["portrait"] for r in rows])), ("landscape", ~np.array([r["portrait"] for r in rows]))]:
    if k.sum(): print(f"  {lab:9s} {k.sum():4d}   {io[k].mean():.3f}   {np.median(io[k]):.3f}   {np.median(wr[k]):.3f}   {np.median(hr[k]):.3f}")
