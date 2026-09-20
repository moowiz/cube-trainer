"""Two-stage inference from checkpoints, the way the app runs it.

    ts = TwoStage.load("runs/kpft8/best.pt", "runs/box17/best.pt")
    hit = ts.detect(pil_image)      # None: stage 1 saw no cube
    hit.quads                       # [{"score", "quad": 4x(x,y) source px}]

Stage 1 (cubebox) on the whole frame, the box padded by PAD_VAL per side
(web twostage.ts CROP_PAD), stage 2 (facekp) on that crop only, corners
mapped back to source px. Quads are ANONYMOUS (cyclic order, consistent
winding, arbitrary start); naming is the app's job (detect/identify.ts).

Used by predict.py (still images) and detect_server.py (live webcam ->
WebSocket). Keep the letterbox/crop math in dataset.py - this only calls it.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import torch
from PIL import Image

from dataset import NORM_MEAN, NORM_STD, crop_letterbox, crop_window, letterbox_image, letterbox_params
from model import build_model, decode_maps, decode_to_list, has_twist
from shapes import BOX_WH, KP_WH, PAD_VAL


def _sig(v):
    return 1 / (1 + np.exp(-v))


@dataclass
class Detection:
    obj: float
    """Stage-1 box in source px (x0, y0, x1, y1), None without a localizer."""
    box: tuple[float, float, float, float] | None
    """The padded, clamped window stage 2 looked at."""
    window: tuple[float, float, float, float]
    """center head: [{"score", "quad": (4,2) ndarray source px, "twist"?}], strongest first.
    "twist" (a --twist checkpoint only, M13): {"probs": 6 floats over none / self / edge0..3
    in the quad's decoded corner order, "cls": argmax, "pTwisted": 1 - p(none),
    "deg": the layer's angle mod 90}."""
    quads: list[dict] = field(default_factory=list)
    """legacy head only: [(face letter, conf, quad)] for every face >= legacy_thresh."""
    faces: list[tuple[str, float, np.ndarray]] = field(default_factory=list)


class TwoStage:
    def __init__(self, model, head: str, input_wh, localizer, device: str, thresh: float):
        self.model, self.head, self.input_wh = model, head, tuple(input_wh)
        self.localizer, self.device, self.thresh = localizer, device, thresh

    @classmethod
    def load(cls, ckpt_path: str, box_ckpt_path: str | None = None, thresh: float = 0.25,
             device: str | None = None) -> TwoStage:
        device = device or ("cuda" if torch.cuda.is_available() else "cpu")
        ckpt = torch.load(ckpt_path, map_location="cpu", weights_only=True)
        head = ckpt.get("head", "legacy")
        input_wh = tuple(ckpt.get("input_wh", KP_WH))
        model = build_model(head, pretrained=False, input_hw=(input_wh[1], input_wh[0]),
                            npts=ckpt.get("npts", 4), twist=bool(ckpt.get("twist", False))).to(device)
        model.load_state_dict(ckpt["model"])
        model.eval()
        localizer = None
        if box_ckpt_path:
            from train_bbox import build_box_model
            bck = torch.load(box_ckpt_path, map_location="cpu", weights_only=True)
            localizer = build_box_model(bck.get("head", "gap")).to(device)
            localizer.load_state_dict(bck["model"])
            localizer.eval()
        print(f"head={head}  view={ckpt.get('view', 'frame')} {input_wh}  ckpt={ckpt_path}"
              + ("  twist=on" if ckpt.get("twist") else "")
              + (f"  stage 1 {box_ckpt_path}" if localizer else ""))
        return cls(model, head, input_wh, localizer, device, thresh)

    def _run(self, net, pil: Image.Image):
        x = (np.asarray(pil, dtype=np.float32) / 255.0 - NORM_MEAN) / NORM_STD
        xt = torch.from_numpy(x.transpose(2, 0, 1)).unsqueeze(0).to(self.device)
        with torch.no_grad():
            return net(xt)

    def locate(self, img: Image.Image):
        """Stage 1 on the whole image -> (obj, box in source px); box is None under 0.5."""
        y = self._run(self.localizer, letterbox_image(img, *BOX_WH))[0].cpu().numpy()
        obj = float(_sig(y[0]))
        if obj < 0.5:
            return obj, None
        s, dx, dy = letterbox_params(img.width, img.height, *BOX_WH)
        cx, cy = _sig(y[1]) * BOX_WH[0], _sig(y[2]) * BOX_WH[1]
        w, h = _sig(y[3]) * BOX_WH[0], _sig(y[4]) * BOX_WH[1]
        return obj, (((cx - w / 2) - dx) / s, ((cy - h / 2) - dy) / s,
                     ((cx + w / 2) - dx) / s, ((cy + h / 2) - dy) / s)

    def detect(self, img: Image.Image, legacy_thresh: float = 0.25) -> Detection | None:
        """Both stages. None when stage 1 found no cube (stage 2 did not run).
        Without a localizer the image is assumed to BE the crop."""
        obj, box = 1.0, None
        window = (0.0, 0.0, float(img.width), float(img.height))
        if self.localizer is not None:
            obj, box = self.locate(img)
            if box is None:
                return None
            window = crop_window(box, (PAD_VAL,) * 4, (0, 0, img.width, img.height))
        small, scale, dx, dy, window = crop_letterbox(img, window, *self.input_wh)
        pred = self._run(self.model, small)
        iw, ih = self.input_wh

        def to_source(u, v):
            return ((u * iw - dx) / scale + window[0], (v * ih - dy) / scale + window[1])

        det = Detection(obj=obj, box=box, window=window)
        if self.head == "center" and has_twist(pred):
            scores, quads, tw = decode_maps(pred, input_wh=self.input_wh, thresh=self.thresh, with_twist=True)
            for i in range(scores.shape[1]):
                if scores[0, i] <= 0:
                    continue
                probs = tw["probs"][0, i].cpu().numpy()
                q = quads[0, i].cpu().numpy()
                det.quads.append({"score": float(scores[0, i]),
                                  "quad": np.array([to_source(float(u), float(v)) for u, v in q]),
                                  "twist": {"probs": [float(x) for x in probs], "cls": int(probs.argmax()),
                                            "pTwisted": float(1 - probs[0]), "deg": float(tw["deg"][0, i])}})
        elif self.head == "center":
            for d in decode_to_list(pred, input_wh=self.input_wh, thresh=self.thresh)[0]:
                det.quads.append({"score": d["score"],
                                  "quad": np.array([to_source(u, v) for u, v in d["quad"]])})
        else:
            from dataset import FACE_ORDER
            p = pred[0].cpu().numpy()
            for f in range(6):
                conf = float(_sig(p[f, 0]))
                if conf < legacy_thresh:
                    continue
                quad = np.array([to_source(p[f, 1 + 2 * k], p[f, 2 + 2 * k]) for k in range(4)])
                det.faces.append((FACE_ORDER[f], conf, quad))
        return det
