"""Are the Roboflow COCO boxes the cube silhouette, or tighter?

Reference = hull of the stage-2 keypoint model's detected quads (same
silhouette convention as the synthetic/hand labels). Only images where the
keypoint model finds >=2 faces are used, so the reference really is the
silhouette and not one face.
"""
import json, pathlib, sys
import numpy as np, torch
from PIL import Image
sys.path.insert(0, r"C:\Users\moowi\Documents\GitHub\cube_stuff\model\train")
from dataset import letterbox_image, normalize_batch
from model import build_model, decode_maps

ROOT = pathlib.Path(r"C:\Users\moowi\Documents\GitHub\cube_stuff\model")
from shapes import KP_WH as KP
ck = torch.load(ROOT/"train"/"runs"/"v4ft1"/"best.pt", map_location="cpu", weights_only=True)
kp = build_model("center", pretrained=False, input_hw=(KP[1], KP[0])); kp.load_state_dict(ck["model"]); kp.eval()

def faces_box(im):
    sw, sh = im.size
    s = min(KP[0]/sw, KP[1]/sh); dx, dy = (KP[0]-sw*s)/2, (KP[1]-sh*s)/2
    arr = np.asarray(letterbox_image(im, *KP))
    with torch.no_grad():
        maps = kp(normalize_batch(torch.from_numpy(arr.copy()).unsqueeze(0)))
    sc, qd = decode_maps(maps, input_wh=KP, thresh=0.5)
    pts, n = [], 0
    for d in range(sc.shape[1]):
        if sc[0, d] <= 0: continue
        n += 1
        q = qd[0, d].numpy()*np.array(KP)
        pts.extend([((px-dx)/s, (py-dy)/s) for px, py in q])
    if not pts: return n, None
    a = np.array(pts)
    return n, [a[:,0].min(), a[:,1].min(), a[:,0].max(), a[:,1].max()]

allrows = {}
for sub in sorted((ROOT/"roboflow").iterdir()):
    d = sub/"train"
    if not d.is_dir(): continue
    j = json.loads((d/"_annotations.coco.json").read_text())
    bx = {}
    for a in j["annotations"]: bx.setdefault(a["image_id"], []).append(a["bbox"])
    rows = []
    for im_meta in j["images"]:
        bs = bx.get(im_meta["id"])
        if not bs: continue
        b = max(bs, key=lambda b: b[2]*b[3])
        gtb = [b[0], b[1], b[0]+b[2], b[1]+b[3]]
        im = Image.open(d/im_meta["file_name"]).convert("RGB")
        n, sil = faces_box(im)
        if n < 2 or sil is None: continue
        sw, sh = sil[2]-sil[0], sil[3]-sil[1]
        if sw < 10 or sh < 10: continue
        ix0,iy0,ix1,iy1 = max(sil[0],gtb[0]),max(sil[1],gtb[1]),min(sil[2],gtb[2]),min(sil[3],gtb[3])
        inter = max(0,ix1-ix0)*max(0,iy1-iy0)
        rows.append(dict(iou=inter/(sw*sh+(gtb[2]-gtb[0])*(gtb[3]-gtb[1])-inter+1e-9),
                         wr=(gtb[2]-gtb[0])/sw, hr=(gtb[3]-gtb[1])/sh,
                         left=(gtb[0]-sil[0])/sw, top=(gtb[1]-sil[1])/sh,
                         right=(sil[2]-gtb[2])/sw, bottom=(sil[3]-gtb[3])/sh, nf=n))
    allrows[sub.name] = rows
    a = lambda k: np.array([r[k] for r in rows])
    if rows:
        print(f"{sub.name:10s} n={len(rows):4d}  IoU vs silhouette mean {a('iou').mean():.3f} med {np.median(a('iou')):.3f} "
              f"| w/sil med {np.median(a('wr')):.3f} h/sil med {np.median(a('hr')):.3f} "
              f"| inset L{np.median(a('left')):+.3f} T{np.median(a('top')):+.3f} R{np.median(a('right')):+.3f} B{np.median(a('bottom')):+.3f} "
              f"| frac IoU<0.8 {(a('iou')<0.8).mean():.1%}")
rows = [r for v in allrows.values() for r in v]
a = lambda k: np.array([r[k] for r in rows])
print(f"{'POOLED':10s} n={len(rows):4d}  IoU mean {a('iou').mean():.3f} med {np.median(a('iou')):.3f} "
      f"| w/sil med {np.median(a('wr')):.3f} h/sil med {np.median(a('hr')):.3f} "
      f"| inset L{np.median(a('left')):+.3f} T{np.median(a('top')):+.3f} R{np.median(a('right')):+.3f} B{np.median(a('bottom')):+.3f} "
      f"| frac IoU<0.8 {(a('iou')<0.8).mean():.1%}")
