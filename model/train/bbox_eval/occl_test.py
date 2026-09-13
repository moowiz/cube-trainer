"""IoU of the deployed cubebox on data_v4 val, split by the generator's own
occlusion metadata (hasHands / hasPalm / nFingers / hasClutter)."""
import json
import pathlib
import sys
import zlib

import numpy as np
import onnxruntime as ort
from PIL import Image

ROOT = pathlib.Path(r"C:\Users\moowi\Documents\GitHub\cube_stuff\model")
WEB = ROOT.parent/"web"/"public"/"models"
MODEL = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] else str(WEB/"cubebox.onnx")
meta_j = json.loads((WEB/"cubebox.json").read_text())
_, _, IH, IW = meta_j["input"]["shape"]
mean = np.array(meta_j["input"]["mean"], np.float32); std = np.array(meta_j["input"]["std"], np.float32)
sess = ort.InferenceSession(MODEL, providers=["CPUExecutionProvider"])
sig = lambda v: 1/(1+np.exp(-v))

def predict(im):
    sw, sh = im.size
    s = min(IW/sw, IH/sh); dx, dy = (IW-sw*s)/2, (IH-sh*s)/2
    c = Image.new("RGB", (IW, IH), (114,114,114))
    c.paste(im.resize((round(sw*s), round(sh*s)), Image.BILINEAR), (round(dx), round(dy)))
    x = (np.asarray(c, np.float32)/255 - mean)/std
    y = sess.run(None, {"image": x.transpose(2,0,1)[None]})[0][0]
    cx, cy, w, h = (float(sig(v)) for v in y[1:5])
    return [((cx*IW-w*IW/2)-dx)/s, ((cy*IH-h*IH/2)-dy)/s, ((cx*IW+w*IW/2)-dx)/s, ((cy*IH+h*IH/2)-dy)/s], s

root = ROOT/sys.argv[1]
N = int(sys.argv[3]) if len(sys.argv) > 3 else 600
rows = []
for lf in sorted((root/"labels").glob("*.json")):
    if zlib.crc32(lf.stem.encode()) % 20 != 0: continue
    m = json.loads(lf.read_text())
    pts = [c for f,v in m["faces"].items() if v.get("visible") and v.get("corners") for c in v["corners"]]
    if not pts: continue
    a = np.array(pts, float)
    gt = [a[:,0].min(), a[:,1].min(), a[:,0].max(), a[:,1].max()]
    im = Image.open(root/m["image"]).convert("RGB")
    pb, s = predict(im)
    ix0,iy0,ix1,iy1 = max(gt[0],pb[0]),max(gt[1],pb[1]),min(gt[2],pb[2]),min(gt[3],pb[3])
    inter = max(0,ix1-ix0)*max(0,iy1-iy0)
    gw, gh = gt[2]-gt[0], gt[3]-gt[1]
    mm = m.get("meta", {})
    rows.append(dict(iou=inter/(gw*gh+(pb[2]-pb[0])*(pb[3]-pb[1])-inter+1e-9),
                     wr=(pb[2]-pb[0])/gw, hr=(pb[3]-pb[1])/gh,
                     left=(pb[0]-gt[0])/gw, top=(pb[1]-gt[1])/gh,
                     right=(gt[2]-pb[2])/gw, bottom=(gt[3]-pb[3])/gh,
                     size=max(gw,gh)*s,
                     hands=bool(mm.get("hasHands")), palm=bool(mm.get("hasPalm")),
                     nfing=int(mm.get("nFingers") or 0), clutter=bool(mm.get("hasClutter")),
                     shadow=bool(mm.get("hardShadow")), corner=bool(mm.get("cornerOn"))))
    if len(rows) >= N: break

def rep(lab, sel):
    s = [r for r in rows if sel(r)]
    if not s: return
    io = np.array([r["iou"] for r in s]); md = lambda k: np.median([r[k] for r in s])
    print(f"{lab:26s} n={len(s):4d}  IoU {io.mean():.3f}/{np.median(io):.3f}  <0.7 {(io<0.7).mean():5.1%} | w/t {md('wr'):.3f} h/t {md('hr'):.3f} | L{md('left'):+.3f} T{md('top'):+.3f} R{md('right'):+.3f} B{md('bottom'):+.3f}")
print(f"{'group':26s} {'':6s}  IoU mean/med  frac bad | median ratios | median per-edge inset")
rep("ALL", lambda r: True)
rep("hands", lambda r: r["hands"])
rep("no hands", lambda r: not r["hands"])
rep("palm+fingers", lambda r: r["palm"])
rep("3+ fingers", lambda r: r["nfing"] >= 3)
rep("clutter", lambda r: r["clutter"])
rep("no occluder at all", lambda r: not r["hands"] and not r["clutter"])
rep("hard shadow", lambda r: r["shadow"])
rep("corner-on", lambda r: r["corner"])
print()
rep("in-range >=32px", lambda r: r["size"] >= 32)
rep("  + hands", lambda r: r["size"] >= 32 and r["hands"])
rep("  + no hands", lambda r: r["size"] >= 32 and not r["hands"])
