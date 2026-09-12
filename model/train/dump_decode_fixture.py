"""Dump raw center-head maps + the Python decode as a web test fixture.

    python dump_decode_fixture.py --ckpt runs/oc1/best.pt --data ../data
    python dump_decode_fixture.py --synthetic          # no checkpoint needed

Writes web/test/fixtures/facekp-maps.json:

    { "shape": [1,9,15,20], "stride": 16, "inputWh": [320,240], "thresh": 0.3,
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

INPUT_WH = (320, 240)
FIXTURE = Path(__file__).resolve().parents[2] / "web" / "test" / "fixtures" / "facekp-maps.json"


def synthetic_maps(grid_hw=(15, 20), seed: int = 7) -> torch.Tensor:
    """Deterministic stand-in with the awkward cases a real map also has:
    two clear peaks, a near-tie plateau (equal neighbours - NMS keeps both
    only if the comparison is >=), a sub-threshold peak, and offsets that
    put corners outside the frame."""
    g = torch.Generator().manual_seed(seed)
    H, W = grid_hw
    maps = torch.full((1, 9, H, W), -4.0)
    maps += torch.randn(1, 9, H, W, generator=g) * 0.3
    maps[0, 1:] = torch.randn(9 - 1, H, W, generator=g) * 2.0
    for (i, j, logit) in ((4, 5, 3.5), (9, 13, 2.0), (2, 16, -1.2)):
        maps[0, 0, i - 1:i + 2, j - 1:j + 2] = logit - 1.5
        maps[0, 0, i, j] = logit
    maps[0, 0, 12, 3] = maps[0, 0, 12, 4] = 1.0   # exact plateau tie
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
        model = build_model(head, pretrained=False, input_hw=(INPUT_WH[1], INPUT_WH[0]))
        model.load_state_dict(ckpt["model"])
        model.eval()
        ds = CubeKeypointDataset(args.data, split="val", input_size=INPUT_WH)
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
