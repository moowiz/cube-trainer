"""Export the trained FaceKP model for the browser (M4).

    python export_onnx.py --ckpt ../train/runs/base/best.pt

Steps: torch -> ONNX (static shape from ckpt["input_wh"], opset 17) -> parity check in
onnxruntime -> int8 quantization -> parity check again -> copy to
web/public/models/facekp.onnx plus a facekp.json metadata sidecar describing
preprocessing and the output layout, so web/ never hardcodes them.

Quantization: static QDQ (quantize_static, QuantFormat.QDQ) calibrated on a
handful of real val-split frames from ../data, per-channel int8 weights,
uint8 activations. Dynamic int8 (weights only) was tried first and shifted
corners ~24-33 px on this architecture - the big FC regression head
quantizes terribly under a dynamic (no-calibration) range estimate. If
full-graph static QDQ still misses the gate, a second attempt excludes the
head's Gemm nodes from quantization (kept fp32) and requantizes just the
backbone; the better of the two attempts is what the gate below judges.
Either way the deployable model is whichever passes QUANT_GATE_PX - a
quantization that moves corners is worse than a bigger download.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime
from pathlib import Path

# Keep CPU usage low: this machine may be mid-training (GPU + 8 dataloader
# workers). Must be set before onnxruntime is imported to have any effect.
os.environ.setdefault("OMP_NUM_THREADS", "2")
os.environ.setdefault("OPENBLAS_NUM_THREADS", "2")

import numpy as np
import onnx
import onnxruntime as ort
import torch
from onnxruntime.quantization import CalibrationDataReader

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "train"))
from dataset import NORM_MEAN, NORM_STD, CubeKeypointDataset
from model import CENTER_DEDUPE_FRAC, CENTER_MIN_DEDUPE_PX, CENTER_STRIDE, build_model
from shapes import KP_WH, MIN_FACE_EDGE_FRAC, PAD_VAL
from targets import GRID_CORNER_IDX

WEB_MODELS = Path(__file__).resolve().parent.parent.parent / "web" / "public" / "models"
INPUT_WH = KP_WH   # overwritten from the checkpoint in main()
VIEW = "crop"
CALIB_MAX_SAMPLES = 64  # small on purpose - a training run owns the rest of the CPU
ORT_THREADS = 2  # applied to every session *we* construct; see note in main()


def _cpu_light_session_options() -> ort.SessionOptions:
    so = ort.SessionOptions()
    so.intra_op_num_threads = ORT_THREADS
    so.inter_op_num_threads = 1
    return so


def ort_run(path, x):
    sess = ort.InferenceSession(
        str(path), sess_options=_cpu_light_session_options(), providers=["CPUExecutionProvider"]
    )
    return sess.run(None, {"image": x.numpy()})[0]


class ArrayCalibrationReader(CalibrationDataReader):
    """Feeds pre-decoded float32 NCHW arrays to the static quantizer.

    quantize_static consumes the reader exactly once per call, so callers
    must construct a fresh instance (or call .rewind()) for each attempt.
    """

    def __init__(self, arrays: list[np.ndarray]):
        self._arrays = arrays
        self._it = iter(arrays)

    def get_next(self):
        arr = next(self._it, None)
        return None if arr is None else {"image": arr}

    def rewind(self):
        self._it = iter(self._arrays)


def _val_or_all(data_root: str, input_wh, view: str):
    """The val split, or the whole root when the hash split leaves it empty
    (a preview render of a few dozen images)."""
    ds = CubeKeypointDataset(data_root, split="val", input_size=input_wh, view=view)
    return ds if len(ds) else CubeKeypointDataset(data_root, split="all", input_size=input_wh, view=view)


def build_calibration_arrays(data_root: str, input_wh, max_samples: int = CALIB_MAX_SAMPLES, view: str = "crop"):
    """Up to `max_samples` real val-split frames as (1,3,H,W) float32 arrays.

    Reuses the same CubeKeypointDataset pathway as the parity check below, so
    it only reads the already-built cache under `data_root` - no writes.
    Falls back to random noise (with a loud warning) if no dataset is found:
    calibrating on random data gives meaningless int8 ranges, but keeps
    `model/` and `web/` independently runnable per the repo convention.
    """
    try:
        ds = _val_or_all(data_root, input_wh, view)
        n = min(max_samples, len(ds))
        arrays = [ds[i][0].unsqueeze(0).numpy() for i in range(n)]
        print(f"calibration: {n} real val-split samples from {data_root}")
        return arrays
    except FileNotFoundError:
        print(
            f"WARNING: no dataset found under {data_root!r} - calibrating on random "
            "data, this makes the resulting int8 activation ranges meaningless"
        )
        return [torch.randn(1, 3, input_wh[1], input_wh[0]).numpy() for _ in range(8)]


def head_node_names(model_path, head: str) -> list[str]:
    """Node names belonging to the prediction head, for the exclusion retry.

    Legacy: `self.head` is `Flatten -> Linear(...,512) -> Hardswish ->
    Dropout -> Linear(512, 54)`; torch.onnx.export names its nodes with a
    `/head/...` prefix (verified against the actual export - the backbone is
    conv-only, so these are exactly the two head Gemms). Those are the nodes
    that quantize worst.

    Center: `self.head` is a single 1x1 Conv, so the op filter has to include
    Conv. It is not expected to need excluding - the whole point of dropping
    the dense layer is that this graph should quantize.
    """
    m = onnx.load(str(model_path))
    ops = ("Gemm", "MatMul") if head == "legacy" else ("Gemm", "MatMul", "Conv")
    return [n.name for n in m.graph.node if n.op_type in ops and "/head/" in n.name]


def measure_corner_shift(fp32_path, other_path, xs, head: str):
    """Mean/max corner movement in input pixels between two ONNX graphs.

    Legacy: corners are output channels, so it is a direct subtraction.

    Center: corners only exist after decoding, and comparing decoded quads
    would fold NMS tie-breaking noise into a number that is supposed to
    measure weight precision. So the peak cells are taken from the FP32
    model and BOTH models' offsets are read at those same cells, which
    isolates what the gate is actually about: did quantization move the
    corners? Offsets are in cell units, hence the stride multiply.
    """
    ref = np.concatenate([ort_run(fp32_path, xs[i : i + 1]) for i in range(len(xs))])
    got = np.concatenate([ort_run(other_path, xs[i : i + 1]) for i in range(len(xs))])
    if head == "legacy":
        px = np.abs(ref[:, :, 1:] - got[:, :, 1:]).reshape(-1, 4, 2) * np.array(INPUT_WH)
        return float(px.mean()), float(px.max())
    n, c, _, w = ref.shape
    # channels: 1 heat + 2P offsets [+ 8 twist]; the twist channels are not
    # corners and stay out of the gate
    twist_ch = 8 if c in (1 + 2 * 4 + 8, 1 + 2 * 16 + 8) else 0
    npts = (c - 1 - twist_ch) // 2
    heat = 1 / (1 + np.exp(-ref[:, 0]))
    px = []
    for i in range(n):
        flat = heat[i].ravel()
        for c in np.argsort(flat)[-3:]:
            if flat[c] < 0.3:
                continue
            cy, cx = divmod(int(c), w)
            a = ref[i, 1:1 + 2 * npts, cy, cx].reshape(-1, 2)   # (P,2): 4 corners or the 16-point grid
            b = got[i, 1:1 + 2 * npts, cy, cx].reshape(-1, 2)
            px.append(np.abs(a - b) * CENTER_STRIDE)
    if not px:
        print("WARNING: no fp32 heatmap peak above 0.3 on the parity frames - the "
              "corner-shift gate has nothing to measure, refusing to ship int8")
        return float("inf"), float("inf")
    px = np.concatenate(px)
    return float(px.mean()), float(px.max())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt", default="../train/runs/base/best.pt")
    ap.add_argument("--data", default="../data", help="real samples for calibration + the quantization parity check")
    ap.add_argument("--out", default="out")
    ap.add_argument("--crop-trained", choices=["auto", "yes", "no"], default="auto",
                    help="the sidecar's cropTrained stamp. 'auto' = true iff the checkpoint was "
                         "trained on the crop view (the default and the only deployable kind: the "
                         "app runs stage 2 on stage-1 crops only and refuses a model without the stamp)")
    ap.add_argument("--no-deploy", action="store_true",
                    help="skip writing web/public/models/facekp.{onnx,json} - use for test runs")
    args = ap.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    ckpt = torch.load(args.ckpt, map_location="cpu", weights_only=True)
    head = ckpt.get("head", "legacy")
    npts = ckpt.get("npts", 4)
    twist = bool(ckpt.get("twist", False))
    global INPUT_WH, VIEW
    INPUT_WH = tuple(ckpt.get("input_wh", KP_WH))
    VIEW = ckpt.get("view", "frame")
    crop_trained = VIEW == "crop" if args.crop_trained == "auto" else args.crop_trained == "yes"
    print(f"checkpoint view={VIEW} input_wh={INPUT_WH} -> cropTrained={crop_trained}")
    if not crop_trained:
        print("WARNING: a model without the cropTrained stamp is not runnable by the app "
              "(always-two-stage, PORTRAIT-DESIGN.md 3.3) - exporting anyway for tests")
    model = build_model(head, pretrained=False, input_hw=(INPUT_WH[1], INPUT_WH[0]), npts=npts, twist=twist)
    model.load_state_dict(ckpt["model"])
    model.eval()
    out_name = "faces" if head == "legacy" else "maps"
    params = sum(p.numel() for p in model.parameters())
    print(f"head={head}  output={out_name}  params={params / 1e6:.2f}M" + ("  twist=on" if twist else ""))

    fp32_path = out / "facekp.fp32.onnx"
    x = torch.randn(1, 3, INPUT_WH[1], INPUT_WH[0])
    torch.onnx.export(
        model, x, fp32_path, opset_version=17,
        input_names=["image"], output_names=[out_name],
        dynamo=False,
    )

    # parity: torch vs onnxruntime on random input
    with torch.no_grad():
        ref = model(x).numpy()
    got = ort_run(fp32_path, x)
    fp32_diff = float(np.abs(ref - got).max())
    print(f"fp32 onnx vs torch: max abs diff {fp32_diff:.2e}")
    assert fp32_diff < 1e-3, "fp32 export does not match torch"

    from onnxruntime.quantization import QuantFormat, QuantType, quantize_static
    from onnxruntime.quantization.shape_inference import quant_pre_process

    # quantize_static wants a shape-inferred graph; run the quantizer's own
    # recommended preprocessing pass and fall back to the raw export if it
    # errors out (older opset/shape-inference edge cases).
    preproc_path = out / "facekp.fp32.preproc.onnx"
    try:
        quant_pre_process(str(fp32_path), str(preproc_path))
        quant_input_path = preproc_path
        print(f"quant_pre_process ok -> {preproc_path.name}")
    except Exception as e:  # pragma: no cover - depends on installed onnx/opset support
        print(f"quant_pre_process failed ({e}); quantizing the raw export instead")
        quant_input_path = fp32_path

    # real val-split frames from ../data, reused for both calibration ranges
    # and the measured-shift gate below (falls back to random data if
    # ../data isn't present, same as before)
    try:
        ds = _val_or_all(args.data, INPUT_WH, VIEW)
        xs = torch.stack([ds[i][0] for i in range(min(16, len(ds)))])
    except FileNotFoundError:
        xs = torch.randn(8, 3, INPUT_WH[1], INPUT_WH[0])
    calib_arrays = build_calibration_arrays(args.data, INPUT_WH, view=VIEW)

    def try_static_quant(label: str, dst_path: Path, nodes_to_exclude=None):
        quantize_static(
            str(quant_input_path), str(dst_path),
            calibration_data_reader=ArrayCalibrationReader(calib_arrays),
            quant_format=QuantFormat.QDQ,
            per_channel=True,
            weight_type=QuantType.QInt8,
            activation_type=QuantType.QUInt8,
            nodes_to_exclude=nodes_to_exclude,
        )
        mean_px, max_px = measure_corner_shift(fp32_path, dst_path, xs, head)
        print(f"static QDQ [{label}] vs fp32 on {len(xs)} samples: "
              f"mean corner shift {mean_px:.3f} px, max {max_px:.3f} px")
        return mean_px, max_px

    QUANT_GATE_PX = 1.0

    full_path = out / "facekp.int8.qdq-full.onnx"
    full_mean, full_max = try_static_quant("full graph", full_path)
    candidates = [("static-qdq-full", full_path, full_mean, full_max)]

    if full_mean >= QUANT_GATE_PX:
        head_nodes = head_node_names(quant_input_path, head)
        if head_nodes:
            print(f"full QDQ missed the {QUANT_GATE_PX} px gate; retrying with "
                  f"head nodes kept fp32: {head_nodes}")
            head_excl_path = out / "facekp.int8.qdq-head-fp32.onnx"
            excl_mean, excl_max = try_static_quant(
                "head excluded", head_excl_path, nodes_to_exclude=head_nodes
            )
            candidates.append(("static-qdq-head-excluded", head_excl_path, excl_mean, excl_max))
        else:
            print("full QDQ missed the gate but no head Gemm/MatMul nodes were "
                  "found by name - skipping the exclusion fallback")

    # Keep whichever int8 attempt shifted corners least; the gate below still
    # decides whether *that* is good enough to ship over fp32.
    best_label, best_path, px_mean, px_max = min(candidates, key=lambda c: c[2])
    print(f"best int8 candidate: {best_label} (mean {px_mean:.3f} px, max {px_max:.3f} px)")

    int8_path = out / "facekp.onnx"
    int8_path.write_bytes(best_path.read_bytes())
    sizes = (fp32_path.stat().st_size // 1024, int8_path.stat().st_size // 1024)
    print(f"sizes: fp32 {sizes[0]} KB -> int8 ({best_label}) {sizes[1]} KB")

    # A quantization that moves corners is worse than a bigger download - the
    # deployable model is whichever passes this gate, static QDQ or fp32.
    deploy, kind = (int8_path, "int8") if px_mean < QUANT_GATE_PX else (fp32_path, "fp32")
    print(f"deploying {kind} (quantization gate: mean shift < {QUANT_GATE_PX} px)")

    if args.no_deploy:
        print("--no-deploy: skipping write to web/public/models/")
        return

    gh, gw = INPUT_WH[1] // CENTER_STRIDE, INPUT_WH[0] // CENTER_STRIDE
    legacy_output = {
        "name": "faces", "shape": [1, 6, 9], "faces": "URFDLB",
        "channels": "0: visibility logit (sigmoid me), 1..8: x0,y0..x3,y3 normalized by input w,h",
        "cornerOrder": "TL,TR,BR,BL in the face's cubejs sticker-layout orientation",
    }
    n_ch = 1 + 2 * npts + (8 if twist else 0)
    center_output = {
        "name": "maps", "shape": [1, n_ch, gh, gw], "stride": CENTER_STRIDE,
        "channels": f"0: face-center heatmap logit (sigmoid me); 1..{2 * npts}: point offsets "
                    "x0,y0.. in cells, relative to the cell center"
                    + (f"; {1 + 2 * npts}..{n_ch - 1}: the twist head (see `twist`)" if twist else ""),
        "decode": f"corner = ((j+0.5+offx)*stride/W, (i+0.5+offy)*stride/H); candidates are "
                  f"every cell >= threshold, strongest first (ties to the lower cell index), "
                  f"then drop a quad whose center is within {CENTER_DEDUPE_FRAC} x an "
                  f"already-kept quad's mean edge (floor {CENTER_MIN_DEDUPE_PX:.0f} px), keep 6; "
                  f"NOT a 3x3 max-pool - that dropped a face on small cubes. Quads are "
                  f"ANONYMOUS - name them by center color",
        "cornerOrder": "cyclic, winding consistent; starting corner arbitrary",
        # M13 (2026-09-19): the twist head, read PER QUAD at the quad's own
        # heatmap cell. Classes are in the quad's decoded corner order: edge k
        # is decoded corner k -> k+1. A single frame gives the angle only mod
        # 90 (a layer at +30 looks exactly like one at -60); the turn's
        # direction is the sweep across frames. deg > 0 = clockwise seen from
        # the turning face = that face's neighbours' bordering rows moving
        # from their corner k+1 toward their corner k.
        "twist": {
            "channels": [1 + 2 * npts, n_ch],
            "classes": ["none", "self", "edge0", "edge1", "edge2", "edge3"],
            "classChannels": [1 + 2 * npts, 1 + 2 * npts + 6],
            "angleChannels": [1 + 2 * npts + 6, n_ch],
            "angle": "(cos 4a, sin 4a): a = atan2(sin, cos) / 4 is the layer's angle mod 90 deg",
        } if twist else None,
    }

    WEB_MODELS.mkdir(parents=True, exist_ok=True)
    (WEB_MODELS / "facekp.onnx").write_bytes(deploy.read_bytes())
    meta = {
        "input": {"name": "image", "shape": [1, 3, INPUT_WH[1], INPUT_WH[0]], "layout": "NCHW rgb",
                  "mean": NORM_MEAN.tolist(), "std": NORM_STD.tolist(), "scale": "pixel/255 then (x-mean)/std",
                  "letterbox": "aspect-preserving fit, centered, pad rgb(114,114,114); "
                               "coords map back as (u*W - dx)/scale (see train/dataset.py letterbox_params)"},
        "output": legacy_output if head == "legacy" else center_output,
        "trainedEpoch": ckpt.get("epoch"), "valPx": ckpt.get("val_px"), "realPx": ckpt.get("real_px"),
        "precision": kind,
        # run name from the checkpoint path (runs/<name>/last.pt), shown in
        # the pages' status lines so a phone user knows which model is live
        "run": Path(args.ckpt).resolve().parent.name,
        "checkpoint": Path(args.ckpt).name,
        "exported": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "cropTrained": crop_trained,
        # what the model was trained to look at: stage 1's box padded by
        # `cropPad` per side (web padBox), letterboxed square. The range floor
        # is a fraction of the SOURCE frame height (web color.ts MIN_FACE_EDGE_FRAC).
        "view": VIEW, "cropPad": PAD_VAL if VIEW == "crop" else None,
        "minFaceEdgeFrac": MIN_FACE_EDGE_FRAC,
        "head": "legacy" if head == "legacy" else ("center-v1" if npts == 4 else "grid-v1"),
        # Anonymous quads carry no face identity: the app names each one from
        # its center sticker color (web/src/detect/identify.ts).
        "anonymous": head != "legacy",
        # 2026-09-13: how many points each face's offsets carry (channels
        # 1..2P). 4 = the corners; 16 = the 4x4 seam grid, row-major with
        # (u,v) = (i/3, j/3) at p = j*4+i, corners at `gridCornerIdx`. The
        # web decoder must read this rather than assume 9 channels.
        "points": npts,
        "gridCornerIdx": list(GRID_CORNER_IDX) if npts == 16 else None,
    }
    (WEB_MODELS / "facekp.json").write_text(json.dumps(meta, indent=2))
    print(f"wrote {WEB_MODELS / 'facekp.onnx'} and facekp.json")


if __name__ == "__main__":
    main()
