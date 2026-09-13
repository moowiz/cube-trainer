"""Contact sheet of data_real_val: green = GT silhouette box, red = cubebox."""
import json, pathlib, sys
import numpy as np, onnxruntime as ort
from PIL import Image, ImageDraw

ROOT = pathlib.Path(r"C:\Users\moowi\Documents\GitHub\cube_stuff\model")
WEB = ROOT.parent / "web" / "public" / "models"
meta = json.loads((WEB / "cubebox.json").read_text())
_, _, IH, IW = meta["input"]["shape"]
mean = np.array(meta["input"]["mean"], np.float32); std = np.array(meta["input"]["std"], np.float32)
sess = ort.InferenceSession(str(WEB / "cubebox.onnx"), providers=["CPUExecutionProvider"])
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
    return float(sig(y[0])), [((cx-w/2)-dx)/s, ((cy-h/2)-dy)/s, ((cx+w/2)-dx)/s, ((cy+h/2)-dy)/s]

root = ROOT / sys.argv[1]
tiles = []
for lf in sorted((root/"labels").glob("*.json")):
    m = json.loads(lf.read_text())
    pts = [c for f,v in m["faces"].items() if v.get("visible") and v.get("corners") for c in v["corners"]]
    if not pts: continue
    a = np.array(pts, float)
    gt = [a[:,0].min(), a[:,1].min(), a[:,0].max(), a[:,1].max()]
    p = root/m["image"]
    if not p.exists(): p = root/"images"/pathlib.Path(m["image"]).name
    im = Image.open(p).convert("RGB")
    obj, pb = predict(im)
    gw, gh = gt[2]-gt[0], gt[3]-gt[1]
    ix0,iy0,ix1,iy1 = max(gt[0],pb[0]),max(gt[1],pb[1]),min(gt[2],pb[2]),min(gt[3],pb[3])
    inter = max(0,ix1-ix0)*max(0,iy1-iy0)
    iou = inter/(gw*gh+(pb[2]-pb[0])*(pb[3]-pb[1])-inter)
    # crop a generous region around the union so the cube is big in the tile
    ux0,uy0 = min(gt[0],pb[0]), min(gt[1],pb[1]); ux1,uy1 = max(gt[2],pb[2]), max(gt[3],pb[3])
    pad = 0.6*max(ux1-ux0, uy1-uy0)
    cb = [max(0,ux0-pad), max(0,uy0-pad), min(im.width,ux1+pad), min(im.height,uy1+pad)]
    dr = ImageDraw.Draw(im)
    lw = max(2, int(0.006*max(im.size)))
    dr.rectangle(gt, outline=(80,230,120), width=lw); dr.rectangle(pb, outline=(255,80,60), width=lw)
    tiles.append((f"{lf.stem[-6:]} IoU{iou:.2f}", im.crop([int(v) for v in cb])))

W = 300; cols = 7; rows = (len(tiles)+cols-1)//cols
sheet = Image.new("RGB", (W*cols, (W+18)*rows), (16,18,20)); d = ImageDraw.Draw(sheet)
for i,(nm,im) in enumerate(tiles):
    im.thumbnail((W,W), Image.LANCZOS)
    xx,yy = (i%cols)*W, (i//cols)*(W+18)
    sheet.paste(im,(xx,yy)); d.text((xx+4,yy+W+3), nm, fill=(230,230,230))
sheet.save(sys.argv[2]); print("wrote", sys.argv[2], len(tiles), "tiles")
