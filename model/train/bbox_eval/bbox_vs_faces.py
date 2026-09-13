"""Compare the stage-1 box against the stage-2 face quads on unlabelled frames.

The keypoint model is accurate to ~3 px on real photos, so the bounding box of
its detected quads is a good stand-in for the true cube silhouette - good
enough to say whether the localizer box is too small, and on which side.
"""
import json, pathlib, sys
import numpy as np, onnxruntime as ort, torch
from PIL import Image, ImageDraw
sys.path.insert(0, r"C:\Users\moowi\Documents\GitHub\cube_stuff\model\train")
from dataset import letterbox_image, normalize_batch
from model import build_model, decode_maps

ROOT = pathlib.Path(r"C:\Users\moowi\Documents\GitHub\cube_stuff\model")
WEB = ROOT.parent / "web" / "public" / "models"
meta = json.loads((WEB / "cubebox.json").read_text())
_, _, IH, IW = meta["input"]["shape"]
mean = np.array(meta["input"]["mean"], np.float32); std = np.array(meta["input"]["std"], np.float32)
sess = ort.InferenceSession(str(WEB / "cubebox.onnx"), providers=["CPUExecutionProvider"])
sig = lambda v: 1 / (1 + np.exp(-v))
from shapes import KP_WH
ck = torch.load(ROOT / "train" / "runs" / "v4ft1" / "best.pt", map_location="cpu", weights_only=True)
kp = build_model("center", pretrained=False, input_hw=(KP_WH[1], KP_WH[0])); kp.load_state_dict(ck["model"]); kp.eval()

def box_pred(im):
    sw, sh = im.size
    s = min(IW / sw, IH / sh); dx, dy = (IW - sw*s)/2, (IH - sh*s)/2
    c = Image.new("RGB", (IW, IH), (114,114,114))
    c.paste(im.resize((round(sw*s), round(sh*s)), Image.BILINEAR), (round(dx), round(dy)))
    x = (np.asarray(c, np.float32)/255 - mean)/std
    y = sess.run(None, {"image": x.transpose(2,0,1)[None]})[0][0]
    cx, cy, w, h = (float(sig(v)) for v in y[1:5])
    cx, w, cy, h = cx*IW, w*IW, cy*IH, h*IH
    return float(sig(y[0])), [((cx-w/2)-dx)/s, ((cy-h/2)-dy)/s, ((cx+w/2)-dx)/s, ((cy+h/2)-dy)/s]

def faces_box(im):
    sw, sh = im.size
    s = min(KP_WH[0]/sw, KP_WH[1]/sh); dx, dy = (KP_WH[0]-sw*s)/2, (KP_WH[1]-sh*s)/2
    arr = np.asarray(letterbox_image(im, *KP_WH))
    with torch.no_grad():
        maps = kp(normalize_batch(torch.from_numpy(arr.copy()).unsqueeze(0)))
    sc, qd = decode_maps(maps, input_wh=KP_WH, thresh=0.5)
    pts, n = [], 0
    for d in range(sc.shape[1]):
        if sc[0, d] <= 0: continue
        n += 1
        q = qd[0, d].numpy() * np.array(KP_WH)
        pts.extend([((px-dx)/s, (py-dy)/s) for px, py in q])
    if not pts: return n, None
    a = np.array(pts)
    return n, [a[:,0].min(), a[:,1].min(), a[:,0].max(), a[:,1].max()]

src, out = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
tiles = []
print(f"{'frame':8s} {'obj':>5s} {'faces':>5s} {'IoU':>6s}  edge inset as fraction of true box (+ = too small)")
for p in sorted(src.glob("108*.png")):
    im = Image.open(p).convert("RGB")
    obj, pb = box_pred(im)
    n, gt = faces_box(im)
    dr = ImageDraw.Draw(im)
    if gt: dr.rectangle(gt, outline=(80,230,120), width=4)
    dr.rectangle(pb, outline=(255,80,60), width=4)
    tiles.append((p.stem, im))
    if not gt:
        print(f"{p.stem:8s} {obj:5.2f} {n:5d}      -  (no faces detected)"); continue
    gw, gh = gt[2]-gt[0], gt[3]-gt[1]
    ix0, iy0, ix1, iy1 = max(gt[0],pb[0]), max(gt[1],pb[1]), min(gt[2],pb[2]), min(gt[3],pb[3])
    inter = max(0,ix1-ix0)*max(0,iy1-iy0)
    iou = inter/(gw*gh + (pb[2]-pb[0])*(pb[3]-pb[1]) - inter)
    print(f"{p.stem:8s} {obj:5.2f} {n:5d} {iou:6.3f}  left {(pb[0]-gt[0])/gw:+.2f}  top {(pb[1]-gt[1])/gh:+.2f}  "
          f"right {(gt[2]-pb[2])/gw:+.2f}  bottom {(gt[3]-pb[3])/gh:+.2f}   w/true {(pb[2]-pb[0])/gw:.2f} h/true {(pb[3]-pb[1])/gh:.2f}")

W, H = 320, 427
sheet = Image.new("RGB", (W*4, (H+16)*2), (16,18,20)); d = ImageDraw.Draw(sheet)
for i,(nm,im) in enumerate(tiles):
    xx, yy = (i%4)*W, (i//4)*(H+16)
    sheet.paste(im.resize((W,H), Image.LANCZOS), (xx,yy)); d.text((xx+5,yy+H+3), nm+"  red=box  green=faces", fill=(230,230,230))
sheet.save(out); print("wrote", out)
