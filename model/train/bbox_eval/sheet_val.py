"""Contact sheet of data_real_val: green = GT silhouette box, red = cubebox."""
import json
import pathlib
import sys

import numpy as np
from PIL import Image, ImageDraw

from common import ROOT, Localizer

loc = Localizer()

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
    obj, pb, _ = loc.predict(im)
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
