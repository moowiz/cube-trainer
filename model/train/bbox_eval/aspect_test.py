"""Landscape vs portrait-crop A/B on the same synthetic images.

640x480 -> 160x120 letterbox has scale 0.25 and NO bars.
A centered 360x480 crop -> 160x120 has scale 0.25 too (same cube pixel size)
but 35 px grey pillar bars each side - exactly what the app's 480x640 frames
produce.  So any IoU gap between the two columns is the pillarbox, not scale.
"""
import json, pathlib, sys, zlib
import numpy as np, onnxruntime as ort
from PIL import Image

ROOT = pathlib.Path(r"C:\Users\moowi\Documents\GitHub\cube_stuff\model")
WEB = ROOT.parent / "web" / "public" / "models"
MODEL = pathlib.Path(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2] else WEB/"cubebox.onnx"
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

def iou(gt, pb):
    ix0,iy0,ix1,iy1 = max(gt[0],pb[0]),max(gt[1],pb[1]),min(gt[2],pb[2]),min(gt[3],pb[3])
    inter = max(0,ix1-ix0)*max(0,iy1-iy0)
    return inter/((gt[2]-gt[0])*(gt[3]-gt[1])+(pb[2]-pb[0])*(pb[3]-pb[1])-inter+1e-9)

root = ROOT/sys.argv[1]
N = int(sys.argv[3]) if len(sys.argv) > 3 else 400
res = {"landscape": [], "portrait": []}
n = 0
for lf in sorted((root/"labels").glob("*.json")):
    if zlib.crc32(lf.stem.encode()) % 20 != 0:   # val split only
        continue
    m = json.loads(lf.read_text())
    pts = [c for f,v in m["faces"].items() if v.get("visible") and v.get("corners") for c in v["corners"]]
    if not pts: continue
    a = np.array(pts, float)
    gt = [a[:,0].min(), a[:,1].min(), a[:,0].max(), a[:,1].max()]
    im = Image.open(root/m["image"]).convert("RGB")
    W, H = im.size
    cw = int(round(H*3/4))
    x0 = (W-cw)//2
    if gt[0] < x0+2 or gt[2] > x0+cw-2:   # cube must fit inside the crop
        continue
    _, pb, s = predict(im)
    res["landscape"].append((iou(gt, pb), (pb[2]-pb[0])/(gt[2]-gt[0]), (pb[3]-pb[1])/(gt[3]-gt[1]), max(gt[2]-gt[0], gt[3]-gt[1])*s))
    imc = im.crop((x0, 0, x0+cw, H))
    gtc = [gt[0]-x0, gt[1], gt[2]-x0, gt[3]]
    _, pbc, sc = predict(imc)
    res["portrait"].append((iou(gtc, pbc), (pbc[2]-pbc[0])/(gtc[2]-gtc[0]), (pbc[3]-pbc[1])/(gtc[3]-gtc[1]), max(gtc[2]-gtc[0], gtc[3]-gtc[1])*sc))
    n += 1
    if n >= N: break

print(f"{root.name}: {n} val images, same content both columns (scale {0.25})")
print(f"{'':10s} {'IoU mean':>9s} {'IoU med':>8s} {'IoU<0.7':>8s} {'w/t med':>8s} {'h/t med':>8s}")
for k, v in res.items():
    a = np.array(v)
    print(f"{k:10s} {a[:,0].mean():9.3f} {np.median(a[:,0]):8.3f} {(a[:,0]<0.7).mean():8.1%} {np.median(a[:,1]):8.3f} {np.median(a[:,2]):8.3f}")
sz = np.array(res["landscape"])[:,3]
print("\n by cube size (long side, canvas px):   n   land IoU   port IoU")
for lo,hi in [(0,25),(25,35),(35,50),(50,999)]:
    k = (sz>=lo)&(sz<hi)
    if k.sum(): print(f"  {lo:3d}-{hi:3d} px {k.sum():5d}   {np.array(res['landscape'])[k,0].mean():.3f}     {np.array(res['portrait'])[k,0].mean():.3f}")
