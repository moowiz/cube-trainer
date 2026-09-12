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

**Rotation-invariant loss (2026-09-11):** the corner loss (and
`pixel_error`) now take the minimum over the 4 cyclic shifts of the target
quad. On a dead-on lone face the starting corner is unobservable, and
demanding it produced the rotation-hedge diamonds above; the model's job is
the quad, and orientation is recovered downstream (shared edges between
faces in a frame, temporal tracking) — see keypoint_loss's DECISION note.
val_px from runs before this change reads slightly high by comparison (the
old metric punished rotation disagreements).

**2026-09-11 experiment ladder** (each isolates one change; real-photo
numbers are on the 22 hand-labeled training photos, rotation-invariant
metric): old loss + old data, fine-tuned (ft1) 4.55 px; new loss + old
data (long2) synthetic val 5.19 vs 8.90 old loss, fine-tuned (ft2) 3.06 px
real; new loss + HDRI/rounded-cubie data_v2 (long3) zero-shot real 22.8 vs
27.8 px, fine-tuned (ft3) **2.42 px real**, deployed. The rotation-hedge
diamond on dead-on views is gone (see runs/realframes*/preds_ft3). Both
fine-tunes still miss the darkest backlit webcam frames - that's a label
gap, not a capacity gap.

`data/` is now the single merged synthetic set (76k: img_000001-038000
legacy sharp-box renders, img_038001-076000 HDRI/rounded-cubie renders,
merged 2026-09-12 per user). Labels of both halves validated: 0 geometry
failures over all 76k (winding/convexity), center-color identity clean
(all mismatches in the check were photometric - warm-cast yellow-orange
and desaturation-to-white under the realistic lighting; zero far-color
swaps). The generator appends new-style renders to this set by
numbering. Expect the first post-merge run to rebuild the cache (~17 GB)
and epochs to run ~2x the 38k time.

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
face trains the visibility head wrong. Corner *order* is free up to
rotation: click around the face from any starting corner, either direction
(never zigzag) — the loss is cyclic-shift-invariant and `import_labels.py`
normalizes winding. `check_labels.py` catches zigzags (non-convex quads)
and misplaced shared corners.

1. Open `<deploy>/label.html` (also in `web/public/`), load photos, click
   each visible face's 4 corners going around the face, export
   `labels-all.json`.
2. `python train/check_labels.py --labels labels-all.json` — fix anything it
   flags (re-export; the importer updates edited labels in place and the
   training cache detects the edit).
3. `python train/import_labels.py --labels labels-all.json --images <photo dir> --out data_real`
4. `python train/train.py --data ../data,../data_real --init runs/long/best.pt --epochs 30 --lr 5e-5 --out runs/ft`
5. `python export/export_onnx.py --ckpt ../train/runs/ft/best.pt`

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

Since 2026-09-12 (the batch4 duvet collapse, see git log for the diagnosis)
the cube style also randomizes seam morphology — tile corner radius up to
GAN-fat, tile depth, body color (black/white/oddball), circular and logo
center caps — and the backdrop/table planes draw from a real-photo pool
(`gen/fetch-backgrounds.mjs`) so photos actually reach the visible pixels.
augment.py adds portrait pillarbox simulation, JPEG round-trips, directional
motion blur, and white-balance channel gains at train time (those four cover
the video-pipeline look and retrofit every existing tranche for free).

**Two-stage architecture (decided 2026-09-12, in progress):** stage 1
localizes the cube (bbox; tiny NN at low res - classical edge/chroma first
passes were measured and rejected: white-on-white faces have no edges, the
user's couch blanket defeats chroma blobs), stage 2 runs corner regression
on the crop. Stage 2's crop distribution ships first as augment.py's
_zoom_crop (0.3); the next from-scratch run trains it in. Stage 1's bbox
labels are free (hull of corner labels, synthetic + real); public Roboflow
cube-bbox sets (~540 imgs) can supplement. At runtime stage 1 only runs at
acquisition - a tracked cube's previous quads define the next crop.

**Render pass DONE 2026-09-12 (generator, not yet generated at scale):**
hands (2-5 skin-tone capsule fingers gripping the cube in camera space, ~50%
of scenes, 8 jittered skin tones), foreground clutter primitives (~20%),
hard cast shadows from a real occluder between light and cube (~25%; fixed
two latent shadow bugs: shadow-camera near/far depth starvation, and
occluders placed on faces the camera can't see), and a **corner-on pose
knob** — `--cornerBias F` / env `CORNER_BIAS` on generate.mjs: fraction F of
scenes rejection-samples the camera until the 3rd-most-facing face has
facing >= 0.30. Occlusion NEVER changes labels (corners/visible/facing stay
pure projected geometry). Each label's `meta` records
cornerOn/hasHands/hasClutter/hardShadow for auditing. Debug affordances:
`window.DEBUG_*` flags in scene.mjs, plumbed via env vars in generate.mjs.
Motivation for the pose knob, measured 2026-09-12 on 4k sampled labels per
root: 3-face views are 21-27% of frames but dead-on corner views (min
facing >= 0.40) only 1.4-2.4% under uniform sampling — while corner-on is a
natural in-hand scanning pose and the model's weakest class (see the
45-degree-diamond / identity-averaging note). Refinement candidate: fingers
occasionally render stick-thin.

**DECISION 2026-09-12 — consolidate synthetic data (supersedes append-only
for synthetic).** The next from-scratch set is ONE root, `data_v4`, ~50-60k
generated with the full current feature set (`--cornerBias 0.4`), replacing
`data` (76k: 38k legacy sharp-box + 38k HDRI/rounded — both strictly
superseded by the current generator) and `data_v3` (28k) in `--data` for
from-scratch runs. Rationale: epoch time is linear in dataset size (125k
samples = 7.5 h runs); beyond distribution coverage, count has power-law
diminishing returns; every measured failure was a starved *cell* (corner-on
2%, solid faces 0%, hands 0%), not insufficient totals. Sizing math: ~80
hard joint cells (pose class x occlusion x pattern regime x style family) x
500-800 examples each = 40-65k; secondary axes vary freely within cells and
train-time augmentation multiplies them. Old roots stay on disk for
ablations; synthetic sets are a cache (the generator is the asset). REAL
data (data_real, data_real_val) stays append-only forever. Synthetic val
resets with the new root — real_px is the cross-run yardstick.

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
