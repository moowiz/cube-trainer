# model/ — synthetic data + keypoint model

Produces `web/public/models/facekp.onnx`, the face keypoint detector.
M3 (data generation) done; currently at **M4: training + ONNX export**.

## Training (`train/`) and export (`export/`)

One-time setup (Python 3.13 — torch has no 3.14 wheels yet):

```
cd model
python -m venv .venv
.venv\Scripts\python -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cu124
.venv\Scripts\python -m pip install -r requirements.txt
```

```
cd train
..\.venv\Scripts\python train.py --data ../data --overfit 50 --epochs 600 --batch 16 --lr 1e-3
    # pipeline correctness check: must reach ~2 px. Verified 2026-09: 2.07 px.
..\.venv\Scripts\python train.py --data ../data --epochs 30 --out runs/base
cd ..\export
..\.venv\Scripts\python export_onnx.py --ckpt ../train/runs/base/best.pt
    # -> web/public/models/facekp.onnx (int8) + facekp.json (pre/post-processing metadata)
```

The model is MobileNetV3-Small → direct regression of `(6 faces × [visibility
logit, 4 corners])` at 320x240 input, faces in URFDLB order, corners in the
cubejs sticker-layout order the labels use. `web/` must read `facekp.json`
rather than hardcoding preprocessing.

## Sim-to-real notes (first 20k run, 2026-09)

30 epochs: 8.74 px mean / 4.7 px median val corner error, 95.8% visibility
accuracy — mean dragged by a tail (p90 20 px) of heavily foreshortened and
far-away faces. On the real M2 webcam fixtures (`train/predict.py`) the model
finds the cube confidently but underestimates its extent: real frames hold
the cube far closer than the original render distribution ever did (only 6 of
2,221 val faces were >100 px). Generator fixes that followed: 40% close-up
framing regime, 35% near-face-on poses, 18% dim scenes, seeded camera
directions, and style chosen by hashed seed (plain `seed % 10` cycled with
period 10 and aliased with the old every-20th val split so badly that val was
100% stickered — the loader now splits by filename hash instead).
`train/diagnose.py` prints the error breakdown that caught all of this.

## Long run + sim-to-real round 2 (2026-09-11, runs/long)

120 epochs on 38k (landscape + portrait, close-up + far, dim scenes),
cached loader: **8.90 px mean / 3.4 px median** val corner error, 97.4%
visibility accuracy, converged flat (a real plateau, not a schedule
artifact). The mean's tail is two characterized failure modes
(`diagnose.py`): >100 px close-up faces average 27 px — on near-face-on
views the head regresses a ~45°-rotated "hedge" quad, averaging over the
4-fold corner-order ambiguity of a lone square face — and foreshortened U/D
faces run ~2x the error of the others. On real phone frames the model now
gets face identity right (center color), position and scale right, and
hedges rotation on dead-on views. Attack order for the tail: M5 real-frame
fine-tune, more close-up synthetic, then a rotation-canonical corner
parameterization or heatmap head if still stuck.

**Quantization finding:** dynamic int8 shifts corners ~33 px mean — useless
(the FC regression head quantizes terribly). `export_onnx.py` now gates on
measured shift (<1 px) and deploys fp32 (24.5 MB) until static QDQ
calibration is implemented. Browser (headless Chrome, RTX 4070): webgpu
6.1 ms, wasm 10.9 ms per inference; `web/scripts/check-detect.mjs` runs both.

## M5 labeling workflow

Conventions (settled with the user on the first labeled photo, 2026-09-11):
corners go at the **outermost point of the visible plastic** — never
extrapolated past a rounded stickerless edge (systematic ~corner-radius
offset vs the sharp-box synthetic labels is accepted; fix the generator, not
the labels, if it ever matters). Occluded corners are estimated and clicked.
Every face whose center is identifiable gets labeled — an unlabeled visible
face trains the visibility head wrong.

1. Open `<deploy>/label.html` (also in `web/public/`), load photos, label
   visible faces' corners (TL,TR,BR,BL in sticker order), export
   `labels-all.json`.
2. `python train/import_labels.py --labels labels-all.json --images <photo dir> --out data_real`
3. `python train/train.py --data ../data,../data_real --init runs/long/best.pt --epochs 30 --lr 5e-5 --out runs/ft`
4. `python export/export_onnx.py --ckpt ../train/runs/ft/best.pt`

## Training performance (TODO before the next serious run)

Measured on the first 20k run (RTX 4070 SUPER): ~116 s/epoch at ~164 img/s,
GPU 3D utilization ~7% in a sawtooth — the run is **dataloader-bound**, not
GPU-bound. The tax is decoding full 640x480 PNGs per epoch only to resize
them to 320x240.

Fix, in order of payoff:

1. **Pre-decoded cache** — DONE: `dataset.py` lazily builds
   `data/cache_320x240/` (memory-mapped uint8 images + label tensors,
   rebuilt when the label count changes) and reads samples from it;
   augmentation runs on the cached input-size images.
2. Only if still starved after (1): move photometric augmentation to the GPU
   (batched torch ops) or raise `--workers`.

**Resource etiquette:** this is the user's daily-driver PC — keep it usable
while jobs run. Don't raise `--workers` beyond ~half the CPU threads (the
first run used 8 at ~56% CPU: acceptable ceiling, don't exceed it), don't
chase 100% utilization of anything, and prefer making each worker's unit of
work cheaper (caching, smaller decodes) over adding workers. Same applies to
the M3 generator: one headless-Chrome instance is plenty.

## Synthetic data generator (`gen/`)

Renders a 3x3 cube — stickered (70%) or stickerless (30%) — with a real random
scramble, random camera pose, random warm/cool lighting with occasional glare,
and random backgrounds. Procedural grids and tiles are over-represented in the
backgrounds on purpose: they are the hard negatives (bathroom tiles, keyboards)
from MILESTONES M3.

> **DECISION:** Three.js in headless Chrome (puppeteer), not Blender and not
> the `gl` native module. It matches the web app's rendering stack exactly,
> installs cleanly on Windows, and is fast enough (~20k images overnight at
> worst). Revisit Blender only if realism proves to be the bottleneck at M5.

```
cd gen
npm install
npm run preview   # 60 images into ../data/preview — eyeball these first
npm run viz       # draw labels back onto preview images -> ../data/preview/viz
npm run data      # the full 20k set into ../data (resumes if interrupted)
```

(`make data` / `make preview` / `make viz` do the same where make exists.)

Optional: drop real photos (e.g. a COCO subset) into `model/backgrounds/`;
40% of samples will then use them as backgrounds instead of procedural ones.

### Output format

```
data/
  images/img_000001.png     640x480
  labels/img_000001.json
```

Each label:

```json
{
  "image": "images/img_000001.png",
  "width": 640, "height": 480,
  "style": "stickered",
  "faces": {
    "U": { "visible": true, "facing": 0.83, "corners": [[x,y],[x,y],[x,y],[x,y]] },
    "R": { "...": "all six faces always present" }
  },
  "meta": { "seed": 1000004, "scrambleMoves": 22, "fov": 44.2, "bgKind": "procedural", "lightKelvins": [3100] }
}
```

- `corners` are float pixel coordinates in order **[top-left, top-right,
  bottom-right, bottom-left] of that face in its cubejs sticker-layout
  orientation** (the corners touching stickers 1, 3, 9, 7). They are reported
  for all six faces, including ones facing away — filter on `visible`.
- `visible` = the face normal points toward the camera (`facing > 0.15`) and
  the face center is inside the frame.
- `meta.seed` fully determines the sample (deterministic RNG), so any image can
  be re-rendered.

`visualize.mjs` draws the quads back on the images (visible faces bright and
thick, hidden faces dim and thin; corner 0 gets the biggest dot, corner 1 the
next) — this is the M3 "labels visualize correctly" check.

## Layout

```
gen/      generator (Node + three + puppeteer)   <- M3, done
data/     generated images + labels              <- gitignored
train/    keypoint model + training              <- M4 (dataset/augment/model/train)
export/   torch -> onnx -> int8 quantize         <- M4 (export_onnx.py)
.venv/    Python 3.13 venv                       <- gitignored
```
