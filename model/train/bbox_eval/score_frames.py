"""Score every dense frame with the deployed cubebox + facekp; write a csv."""
import csv
import json
import pathlib
import sys

import numpy as np
import onnxruntime as ort
import torch
from PIL import Image

sys.path.insert(0, r"C:\Users\moowi\Documents\GitHub\cube_stuff\model\train")
from dataset import letterbox_image, normalize_batch
from model import build_model, decode_maps

ROOT = pathlib.Path(r"C:\Users\moowi\Documents\GitHub\cube_stuff\model"); WEB = ROOT.parent/"web"/"public"/"models"
meta = json.loads((WEB/"cubebox.json").read_text()); _,_,IH,IW = meta["input"]["shape"]
mean = np.array(meta["input"]["mean"],np.float32); std = np.array(meta["input"]["std"],np.float32)
box = ort.InferenceSession(str(WEB/"cubebox.onnx"), providers=["CPUExecutionProvider"])
sig = lambda v: 1/(1+np.exp(-v))
ck = torch.load(ROOT/"train"/"runs"/(sys.argv[2] if len(sys.argv) > 2 else "kpft1")/"best.pt", map_location="cpu", weights_only=True)
KP=tuple(ck["input_wh"]); kp = build_model("center", pretrained=False, input_hw=(KP[1],KP[0])); kp.load_state_dict(ck["model"]); kp.eval()
PAD=0.45  # stage 2 runs on stage 1's box padded like the app (two-stage; a crop model is meaningless full-frame)
def locate(im):
    sw,sh = im.size; s=min(IW/sw,IH/sh); dx,dy=(IW-sw*s)/2,(IH-sh*s)/2
    c = Image.new("RGB",(IW,IH),(114,114,114)); c.paste(im.resize((round(sw*s),round(sh*s)),Image.BILINEAR),(round(dx),round(dy)))
    x=(np.asarray(c,np.float32)/255-mean)/std; y=box.run(None,{"image":x.transpose(2,0,1)[None]})[0][0]
    cx,cy,w,h=(float(sig(v)) for v in y[1:5]); return float(sig(y[0])), w*IW, h*IH, ((cx-w/2)*IW-dx)/s, ((cy-h/2)*IH-dy)/s, ((cx+w/2)*IW-dx)/s, ((cy+h/2)*IH-dy)/s  # size in BOX px, box in source px
def faces(im, box):
    x0,y0,x1,y1=box; bw,bh=x1-x0,y1-y0
    im=im.crop((max(0,x0-PAD*bw),max(0,y0-PAD*bh),min(im.width,x1+PAD*bw),min(im.height,y1+PAD*bh)))
    arr=np.asarray(letterbox_image(im,*KP))
    with torch.no_grad(): maps=kp(normalize_batch(torch.from_numpy(arr.copy()).unsqueeze(0)))
    sc,qd=decode_maps(maps,input_wh=KP,thresh=0.5); return int((sc[0]>0).sum()), float(sc[0].max())
sp = pathlib.Path(sys.argv[1]); rows=[]
for clip in ["a","b"]:
    for f in sorted((sp/"dense"/clip).glob("*.jpg")):
        im=Image.open(f).convert("RGB"); obj,w,h,*bx=locate(im); nf,fmax=faces(im,bx) if obj>=0.5 else (0,0.0)
        t=(int(f.stem[1:])-1)/4
        rows.append(dict(clip=clip,frame=f.name,t=t,obj=round(obj,3),boxw=round(w,1),boxh=round(h,1),size=round(max(w,h),1),nfaces=nf,facemax=round(fmax,3),lum=round(float(np.asarray(im.convert("L")).mean()),1)))
with open(sp/"dense_scores.csv","w",newline="") as fh:
    wr=csv.DictWriter(fh,fieldnames=rows[0].keys()); wr.writeheader(); wr.writerows(rows)
print(len(rows),"scored")
