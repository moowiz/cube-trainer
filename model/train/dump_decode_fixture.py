"""Dump raw center-head maps + the Python decode as a web test fixture.

    python dump_decode_fixture.py --ckpt runs/kpft1/best.pt --data ../data_v5
    python dump_decode_fixture.py --synthetic          # no checkpoint needed

Writes web/test/fixtures/facekp-maps-square.json (input size and view from
the checkpoint - the crop view re-crops the val image the way the app does):

    { "shape": [1,9,16,16], "stride": 16, "inputWh": [256,256], "thresh": 0.3,
      "maps": [ ...flattened float32, row-major... ],
      "expected": [ {"score": .., "quad": [[x,y] x4]}, ... ] }

web/test/facekp-decode.test.ts feeds `maps` through the TypeScript mirror of
`decode_maps` and requires it to reproduce `expected` to 1e-4. That test is
the only thing keeping the two decoders honest, so regenerate the fixture
whenever decode_maps changes - and regenerate it from a REAL checkpoint when
one exists, because a trained heatmap has the near-tie peaks that catch NMS
and top-k ordering bugs that clean synthetic maps do not.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import torch

from model import CENTER_STRIDE, build_model, decode_to_list
from shapes import KP_WH
from shapes import grid_hw as shapes_grid_hw

INPUT_WH = KP_WH
FIXTURE = Path(__file__).resolve().parents[2] / "web" / "test" / "fixtures" / "facekp-maps-square.json"


def _write_quad(maps, i, j, cx, cy, half, stride=CENTER_STRIDE):
    """Make cell (i,j) predict an axis-aligned square of side 2*half px centred
    at (cx,cy) px, by writing the offsets that decode to exactly that."""
    corners = [(cx - half, cy - half), (cx + half, cy - half),
               (cx + half, cy + half), (cx - half, cy + half)]
    for c, (x, y) in enumerate(corners):
        maps[0, 1 + 2 * c, i, j] = x / stride - (j + 0.5)
        maps[0, 2 + 2 * c, i, j] = y / stride - (i + 0.5)


def synthetic_maps(grid_hw=None, seed: int = 7) -> torch.Tensor:
    """Deterministic stand-in carrying the cases a trained map almost never
    produces but the decoder must get right. Since 2026-09-12 deduplication is
    on the decoded quads (see model.py::decode_maps), so what matters is no
    longer plateaus in the heatmap but what the competing cells DRAW:

      A  two adjacent cells describing the SAME quad     -> collapse to one
      B  two cells 2 apart describing DIFFERENT small
         faces, centres 32 px apart (the small-cube case
         the old 3x3 NMS destroyed)                      -> keep both
      C  an exact score tie between two separate quads   -> both, lower cell
                                                            index first
      D  a sub-threshold peak                            -> dropped
      E  offsets putting corners outside the frame       -> kept as-is
    """
    if grid_hw is None:
        grid_hw = shapes_grid_hw(KP_WH)
    g = torch.Generator().manual_seed(seed)
    H, W = grid_hw
    maps = torch.full((1, 9, H, W), -4.0)
    maps += torch.randn(1, 9, H, W, generator=g) * 0.3
    maps[0, 1:] = torch.randn(9 - 1, H, W, generator=g) * 2.0

    # A: cells (4,5) and (4,6) both draw the one 96 px face centred at (88,72)
    maps[0, 0, 4, 5], maps[0, 0, 4, 6] = 3.5, 2.6
    _write_quad(maps, 4, 5, 88, 72, 48)
    _write_quad(maps, 4, 6, 88, 72, 48)

    # B: a small cube - two 30 px faces whose centres are only 32 px (2 cells)
    # apart. Both must survive: 0.5 * 30 = 15 px radius < 32 px separation.
    maps[0, 0, 9, 12], maps[0, 0, 9, 14] = 2.4, 2.0
    _write_quad(maps, 9, 12, 200, 152, 15)
    _write_quad(maps, 9, 14, 232, 152, 15)

    # C: an exact tie, two well-separated quads
    maps[0, 0, 12, 3] = maps[0, 0, 12, 8] = 1.0
    _write_quad(maps, 12, 3, 56, 200, 20)
    _write_quad(maps, 12, 8, 136, 200, 20)

    # D: below threshold.  E: corners off the left edge and above the frame.
    maps[0, 0, 2, W - 1] = -1.2
    maps[0, 0, 6, 1] = 2.2
    _write_quad(maps, 6, 1, -10, 20, 40)
    return maps


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt", default=None, help="a center-head checkpoint; omit for --synthetic")
    ap.add_argument("--data", default="../data")
    ap.add_argument("--index", type=int, default=0, help="which val image to run")
    ap.add_argument("--synthetic", action="store_true", help="fabricate the maps instead")
    ap.add_argument("--thresh", type=float, default=0.3)
    ap.add_argument("--out", default=str(FIXTURE))
    args = ap.parse_args()

    if args.synthetic or not args.ckpt:
        maps = synthetic_maps()
        source = "synthetic (dump_decode_fixture.py --synthetic)"
    else:
        from dataset import CubeKeypointDataset
        ckpt = torch.load(args.ckpt, map_location="cpu", weights_only=True)
        head = ckpt.get("head", "legacy")
        if head != "center":
            raise SystemExit(f"{args.ckpt} has head {head!r}; this fixture is center-head only")
        global INPUT_WH
        INPUT_WH = tuple(ckpt.get("input_wh", KP_WH))
        model = build_model(head, pretrained=False, input_hw=(INPUT_WH[1], INPUT_WH[0]), npts=ckpt.get("npts", 4))
        model.load_state_dict(ckpt["model"])
        model.eval()
        ds = CubeKeypointDataset(args.data, split="val", input_size=INPUT_WH, view=ckpt.get("view", "frame"))
        with torch.no_grad():
            maps = model(ds[args.index][0].unsqueeze(0))
        source = f"{args.ckpt} on {ds.files[args.index].name}"

    dets = decode_to_list(maps, input_wh=INPUT_WH, thresh=args.thresh)[0]
    payload = {
        "source": source,
        "shape": list(maps.shape),
        "stride": CENTER_STRIDE,
        "inputWh": list(INPUT_WH),
        "thresh": args.thresh,
        "maps": [round(float(v), 6) for v in maps.flatten().tolist()],
        "expected": [{"score": round(d["score"], 6),
                      "quad": [[round(float(x), 6), round(float(y), 6)] for x, y in d["quad"]]}
                     for d in dets],
    }
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload))
    print(f"wrote {out}  ({len(dets)} detections >= {args.thresh}, source: {source})")
    for d in dets:
        q = np.asarray(d["quad"])
        print(f"  score {d['score']:.3f}  quad x {q[:, 0].min():.3f}..{q[:, 0].max():.3f} "
              f"y {q[:, 1].min():.3f}..{q[:, 1].max():.3f}")


if __name__ == "__main__":
    main()
