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
..\.venv\Scripts\python train.py --data ../data_v5 --overfit 50 --epochs 600 --batch 16 --lr 1e-3
    # pipeline correctness check. Center head verified 2026-09-12: 0.50 px
    # (the legacy head reached 2.07 px on the same check).
..\.venv\Scripts\python train_bbox.py --data "../data_v5,../data_real*40" --coco ../roboflow --neg ../negatives ^
    --head dense --epochs 50 --out runs/box9                       # stage 1, ~18 min
..\.venv\Scripts\python train.py --data ../data_v5 --epochs 150 --out runs/kp1    # stage 2 from scratch, ~45 min
..\.venv\Scripts\python train.py --data "../data_v5,../data_real*150" --init runs/kp1/best.pt ^
    --epochs 15 --lr 5e-5 --select real --out runs/kpft1           # stage 2 real-photo fine-tune
cd ..\export
..\.venv\Scripts\python export_bbox.py --ckpt ../train/runs/box9/best.pt      # -> web/public/models/cubebox.{onnx,json}
..\.venv\Scripts\python export_onnx.py --ckpt ../train/runs/kpft1/best.pt --data ../data_v5
    # -> web/public/models/facekp.onnx + facekp.json (pre/post-processing metadata, cropTrained stamp)
```

## Always two-stage: portrait stage 1, square crop stage 2 (2026-09-13)

Design and the decisions behind it: `PORTRAIT-DESIGN.md` (final). The app
runs `cubebox` on the whole phone frame and `facekp` on stage 1's box padded
0.45 per side, on every detection tick, on every page; a stage-1 miss is a
tick with no detections. There is no full-frame stage 2 anywhere.

| model | input | sees | grid | cache |
|---|---|---|---|---|
| `cubebox` (stage 1) | **120x160** portrait | the 480x640 phone frame at 0.25, no bars | 10x8 (HxW) | `cache_240x320/` (pooled by 2 at load) |
| `facekp` (stage 2) | **256x256** square | the padded silhouette crop | 16x16 | `cache_crop320/` |

`train/shapes.py` is the only place these live (`BOX_WH`, `KP_WH`,
`FRAME_CACHE_WH`, `CROP_CACHE_WH`, `MIN_FACE_EDGE_FRAC`, `PAD_VAL`); every
script imports it, checkpoints carry `input_wh` and `view`, and eval/export
rebuild from the checkpoint. The synthetic set is `data_v5`: 54k **480x640
portrait** renders (5 instances x 10,800, seeds 1-5, `--cornerBias 0.4`,
generator unchanged from data_v4; audit: 7.1% negatives, 5.3%
exposure-boosted, 15 frames under the luminance floor, 0.2% of faces under
the range floor).

**The crop view** (`CubeKeypointDataset(view="crop")`, the stage-2 default).
The cache holds one padded-silhouette crop per image cut from the **native**
image (480x640 render, 3000x4000 photo) with per-side padding U(0.2, 0.7),
deterministic by file stem, letterboxed square to 320. Each sample is then
re-cropped around the cube hull with per-side padding U(-0.1, 0.45) (train;
negative = the localizer clipped the cube) or exactly 0.45 (val = the app's
`padBox`), clamped to the cached content like the app clamps to the frame,
and letterboxed to 256. Cube-less renders get a random square window (a
stage-1 false positive on a hand or a mug). Why not crop the old 320x240
thumbnail: the app cuts ~215 px out of the source at the range floor and
shrinks it; cutting 60 px out of a thumbnail and blowing it up 5x was the
train/inference mismatch that capped the previous two-stage attempt
(`BBOX-HANDOFF.md` 1c). `_zoom_crop`, `_portrait_sim` and `_pillarbox` are
gone; stage 1 gets top/bottom `_bars` at p 0.15 (the desktop webcam case)
and COCO negatives a random 3:4 crop at p 0.6 (empty phone frames).

Both caches build in parallel (`_build_cache`, ~8-10 workers): 54k frames in
94 s, 54k crops in 86 s.

**The range floor is a fraction of the source frame height**, 0.133 (the
measured arm's-reach edge is 0.153), because stage 2 is scale-normalized by
the crop and its model px no longer say how far away the cube is. It is 85 px
on a phone frame, 42.6 px in the frame cache and 34 px at the 256 crop input
(where it only masks the sliver of a third face at the edge of a loose
crop). `targets.py` derives the ignore band from the grid height,
`diagnose.py` bins faces by that fraction (far 0.133-0.188, mid 0.188-0.25,
near > 0.25) and reports corner error in source px through the crop scale,
and `web/src/color.ts` `MIN_FACE_EDGE_FRAC` is compared in source px
(`identify.ts` receives the crop geometry; `autoscan-main.ts` tests stage 1's
box against it).

**Results** (`data_real_val`, 42 photos / 76 faces, never trained on; the
measurement plan is `PORTRAIT-DESIGN.md` 5):

`data_real_val` is 96 frames / 178 faces since batch 7 (42 photos + 54
clip stills held out as time blocks), never trained on. "Before" is the
previously deployed pair (`v4ft1` full-frame 320x240 + `box6` 160x120
landscape) re-measured on exactly the same 96 frames, so the two columns
are like for like. Corner error is in **source px** (through the crop scale
for the two-stage model; through the frame scale for the full-frame one),
because that is what the colour sampler sees; the model-input px are in
parentheses. Range bins are the face's longest edge over the frame height.

| stage 2 on the padded stage-1 box (`diagnose.py`, pad 0.45) | before: v4ft1 full-frame | **kpft1** two-stage |
|---|---|---|
| F1 at score 0.5 | 0.936 | **0.972** |
| missed faces | 13 of 166 (+12 below the floor ignored) | **4 of 178** (0 of the 12 below the floor) |
| corner error, model px mean / median | 3.84 / 3.44 | 3.54 / 3.33 |
| corner error, **source px** mean / median / p90 | (not comparable) | **15.2 / 10.7 / 29.7** |
| far 0.133-0.188 (43 faces), source px | 32.2, 6 missed | **9.95**, 0 missed |
| mid 0.188-0.25 (47) | 35.0, 3 missed | **15.8**, 0 missed |
| near > 0.25 (76) | 27.3, 4 missed | **18.4**, 4 missed |
| error vs face size, 40-70 px faces | 7.5% of the edge | 7.7% |
| batch 7 (102 faces) mean px / missed | 4.27 / 9 | **3.67 / 1** |
| batches 1-6 mean px / missed | 3.32 / 4 (73 faces) | 3.35 / 3 (76 faces) |
| with the crop jittered ±0.15 per side (localizer error) | - | 3.51 px mean, 2 missed: stage 2 does not care |
| synthetic val (data_v5 crops, 5760 faces) | - | 2.92 px mean, F1 0.990, source px 5.9 |

The four remaining misses are all foreshortened third faces (shortest edge
under a quarter of the longest: 3 of 13 such faces missed); glancing-angle
faces are now the weakest class, exactly the pose `--cornerBias` exists to
supply. Source-px error is the honest number and it fell 2-3x across the
board; the far bin, the case this design was for, fell 3.2x and lost its
misses.

| stage 1 on the whole frame (`bbox_measure.py`, 91 frames with a cube + 5 without) | before: box6 (landscape) | box9 (portrait, no batch 7) | box10 (+ batch 7 + side bands) | **box11** (real `*80`) |
|---|---|---|---|---|
| mean / median IoU | 0.733 / 0.839 | 0.730 / 0.843 | 0.833 / 0.868 | **0.852 / 0.878** |
| IoU < 0.7 | 27.5% | 33.0% | 13.2% | **7.7%** |
| misses (obj < 0.5) | 1 | 3 | 2 | **1** |
| cube-less frames, max objectness | 0.23 | 0.03 | 0.05 | 0.04 |
| batch 7 (54 clip frames) mean IoU / < 0.7 | 0.656 / 39% | 0.653 / 46% | 0.827 / 15% | **0.844 / 7%** |
| batches 1-6 (37 photos) mean IoU | 0.846 | 0.841 | 0.841 | **0.864** |
| far 0.133-0.188 (6) / mid (13) / near (68) | 0.32 / 0.73 / 0.81 | 0.43 / 0.65 / 0.80 | 0.79 / 0.76 / 0.85 | **0.81 / 0.81 / 0.86** |
| median w/t, h/t | 1.02, 0.98 | 1.01, 0.98 | 1.02, 1.00 | 1.00, 0.99 |
| per-edge sd (L T R B) | 0.36 0.24 0.27 0.35 | 0.18 0.24 0.22 0.23 | 0.10 0.08 0.07 0.10 | **0.06 0.04 0.06 0.09** |
| log `real_iou` (its own val set) | 0.846 (42 photos) | 0.845 (42 photos) | 0.837 (96 frames) | 0.853 (96 frames) |

box9 vs box10 is the batch-7 effect: identical recipe, the clip frames in
training (216 of 373 real photos, `*40`) plus the side-band augmentation.
The old photo batches did not move; the clip frames went from a 46% tail to
15%, the far bin from 0.43 to 0.79, and the 2.4x-oversized boxes on far
cubes are gone (w/t 1.05). box11 doubles the real oversampling (`*80`,
real ~28% of the mixture) and lifts everything again, old batches included
(0.841 -> 0.864); the one miss left is batch-2's dim dead-on-against-a-
monitor photo, now at obj 0.37 (was 0.15; the open regression since box5).

**Stage-2 recipe ablations, same night** (`diagnose.py` on the 96-frame
val, pad 0.45; log `real_px` is the fine-tune's own selection metric):

| run | recipe | log real_px | mean / median px | F1 | missed / FP | batch 7 mean, missed | far / mid / near src px |
|---|---|---|---|---|---|---|---|
| kp1 → kpft1 | scratch on data_v5 only, then `data_real*150` ft | 3.55 | 3.54 / 3.33 | 0.972 | 4 / 6 | 3.67, 1 | 9.95 / 15.8 / 18.4 |
| kp1 → kpft2 | same, ft with `data_real*60` | 3.69 | - | - | - | - | - |
| kp2 → **kpft3** | scratch on `data_v5,data_real*20`, then `*150` ft | **3.33** | **3.33 / 3.04** | 0.961 | 4 / 10 | **3.45, 0** | 10.2 / 14.1 / 16.2 |
| kp3 → kpft4 | scratch on `data_v5,data_real*40`, then `*150` ft | 3.39 | - | - | - | - | - |
| kp2 → kpft5 | as kpft3 but 30 fine-tune epochs | 3.33 | - | - | - | - | - |
| kpg1 → kpgft1 | kp2/kpft3 recipe with `--points 16` (seam grid, below) | 3.63 | 3.63 / 3.17 | 0.964 | 4 / 9 | - | 11.4 / 15.3 / 18.5 |

Real photos in the from-scratch mix help: kp2 alone (no fine-tune) already
reached 3.52 on the val, kp1 needed its fine-tune for 3.55, and kp2's
synthetic val_px is better too (2.69 vs 2.77). Doubling that weight (kp3,
`*40`) changes nothing (3.51 / 2.77, ft 3.39). The lighter fine-tune mix
(`*60`) is worse than `*150`, and 30 fine-tune epochs (kpft5) end exactly
where 15 do. kpft3 trades four more false positives at
score 0.5 (the tracker and seam veto absorb those) for 6% lower corner
error and a clean batch 7.

**16-point seam grid (`--points 16`, 2026-09-13): tried, no gain, not
deployed.** The idea: the 4 corners fix a homography, so the 16 seam
intersections are derived from them exactly and the head regresses those
instead - interior junctions are crisp features a thumb rarely covers, and 16
points overdetermine the 8-dof warp so the app could fit it by least squares,
read the residual as a quality weight and drop outliers. Tooling is in place
(`targets.face_points` / `cyclic_perms`, `--points`, checkpoints record
`npts`, `decode_maps(points=True)`, `check_targets.py` covers both counts) and
`diagnose.py` gained the **cell-centre error** - the 9 sticker centres through
a homography fitted to every regressed point, i.e. the number the colour
sampler actually feels - plus `--fit all|interior|inner` to choose the points
the warp is fitted to. Same recipe as kp2 → kpft3, real val:

| | kpft3 (4 corners) | kpgft1 (16-point grid) |
|---|---|---|
| corner error | **3.33 px** | 3.63 px |
| cell-centre error | **2.58 px (10.7 src px)** | 2.69 px (11.7 src px) |
| far-bin cell-centre | **7.6 src px** | 8.6 src px |
| under crop jitter ±0.15 | **2.49 px** | 2.66 px |
| raw 16-point error | - | 3.05 px |

Why it cannot help with this head, measured rather than argued: fitting the
warp to all 16 points, the 12 interior ones or the 4 innermost gives the
same cell-centre error to 0.01 px. The head regresses every point from one
peak cell's features, so the 16 come out projectively consistent with each
other - the error is a whole-face shift, not independent per-point noise,
and there is nothing for redundancy to average or a residual to flag. The
lower interior-point error (3.05 vs 3.63 for the corners) is geometry (points
near the centre move less under a whole-face error), not easier features.
Spreading the offset loss over 16 targets cost the corners ~9%. Redundancy
would need points that are localized *independently* - a dense junction
heatmap at stride 4 with per-junction peaks - which is a different (and
costlier on the phone) architecture, not a flag on this one. Keep
`--points 4`.

Deployed 2026-09-13 (late): `cubebox` = **box13** (batches 8-9 in; see the box table's ‡ note on stage-1 noise), `facekp` = **kpft7**
(kp2/kpft3's recipe with batch 8 in `data_real`: kp4 scratch on
`data_v5,data_real*20`, then the `*150` fine-tune). On the 114-frame val:

| | kpft3 | kpft6 (kp2 base + ft) | **kpft7** (kp4 base + ft) |
|---|---|---|---|
| batch 8 (32 faces) mean px / missed | 4.52 / 1 | 4.06 / 1 | **3.98 / 0** |
| overall mean px / missed / FP / F1 | 3.51 / 5 / 16 / 0.951 | 3.45 / 6 / 13 / 0.956 | 3.47 / **3 / 12 / 0.965** |

Other batches move within noise. box11 was already fine on batch 8 (0.816
IoU, none under 0.7, boxes ~7% small) and was not retrained. fp32; the int8
gate still fails at 14 px mean shift. `web/test/fixtures/facekp-maps-square.json`
is dumped from kpft3.

**Where the remaining error is (kpft6, 204 real val faces).** Model-px error
is ~3.4 in every range bin while source-px error grows with the face
(far 10, mid 13, near 16): the error is a constant in the model's own
pixels, i.e. bound by the 256 input / stride-16 offset regression, not by
the camera. Camera resolution alone cannot help; a bigger input or a
finer head can.

**Seam refinement does NOT help corners (measured 2026-09-13).**
`diagnose.py --dump DIR [--dump-scale 2]` writes every model input (and the
same window from the native photo at 2x, ~the phone frame's scale) with
predicted and true quads; `web/test/refine-bench.test.ts` runs
`gridfit.refineQuad` on them. At 1x: 3.45 -> 4.88 px (29 better, 157
worse); at 2x: 3.45 -> 3.77 px (44 better, 106 worse); started FROM THE
TRUTH it drifts 4.1 / 2.3 px while its seam score rises. The seam prior's
optimum is ~2 model px (~9 source px) from the outline labels (rounded
stickerless cubies, or label noise - the bench cannot separate them), and
the detector is already inside that. Do not feed refined quads to the
tracker or the overlay. It still runs in the colour sampler (`REFINE`);
whether it helps the cell centres there is unmeasured.

## Architecture: anonymous-quad head (center-v1, 2026-09-12)

`train/model.py` holds two heads; `--head` picks one and every checkpoint
records which, so `predict.py` / `diagnose.py` / `export_onnx.py` rebuild the
right class from `ckpt["head"]` (absent ⇒ `legacy`).

**`center` (default).** MobileNetV3-Small split at `features[9]` →
stride-16 tap (48 ch, 15x20) and stride-32 trunk (576 ch, 8x10); the trunk is
1x1'd to 96 ch, bilinearly upsampled to 15x20, concatenated with the tap, and
passed through two 3x3 convs (144→96→96); a final 1x1 conv emits **9 maps**:
channel 0 a face-center heatmap logit, channels 1-8 the four corner offsets
in cell units relative to the cell center. Faces are peaks
("Objects as Points", Zhou et al. 2019); decoding is 3x3 max-pool NMS →
top 6 → `corner = ((j + 0.5 + offx) * 16 / W, (i + 0.5 + offy) * 16 / H)`.
**1.19M params** (0.26M of it neck+head) against the legacy head's 6.27M,
and the fp32 ONNX is **4.66 MB** against 24.5 MB.

Quads are **anonymous**: no face identity anywhere in the model. The generator
renders every cube in the fixed standard scheme, so the legacy head's six
named slots were really learning "what color is the middle sticker" — a
question `web/src/detect/identify.ts` answers directly, and can keep
re-answering as the light changes. Dropping identity also removes the reason
the old head hedged: with named slots the loss had to commit to an identity on
symmetric corner-on views and resolved it by averaging rotations into a
diamond.

Targets (`train/targets.py`) are built per batch on the GPU from the unchanged
label arrays — the cache format and `--data` handling did not move. A face is
a positive iff `conf == 1 and valid == 1`; hidden faces contribute nothing (the
legacy `hidden_weight` supervision of never-observed geometry is gone). Face
center is the **intersection of the quad's diagonals**, not the corner mean
(under perspective the mean drifts toward the near edge). Gaussian sigma is
`clamp(0.25 * sqrt(area_in_cells), 0.8, 3.0)`; offsets are supervised wherever
the Gaussian is ≥ 0.5, assigned to the face with the higher Gaussian there and
ties broken by area. Loss is CenterNet penalty-reduced focal (α=2, β=4, divided
by the positive count) plus SmoothL1 on offsets (β=0.3 cells), the latter
still taking the **minimum over the 4 cyclic shifts** of the target quad — the
same DECISION as the legacy loss, for the same reason.

Measured on all 76k of `data/`: **0 colliding center cells** and 9 of 150,922
positive faces with an off-grid center, so stride 16 is not too coarse (the
tripwire for going to stride 8 was 2%).

`train/check_targets.py` round-trips the whole chain offline in a second —
labels → dense targets → the maps a perfect model would emit → decode →
metrics — and requires the quads back exactly. Run it after touching
`targets.py`, `decode_maps` or `center_metrics`; it catches the grid,
half-cell, channel-order and corner-convention mistakes that otherwise only
show up as "training stalls at 4 px" with no other symptom. Verified against
1,144 real label quads at 7e-9 px.

**`val_conf_acc` means something different for this head.** It is detection
**F1** at score 0.5 under greedy centroid matching (a match must sit within
50% of the ground-truth face's mean edge length), not per-slot visibility
accuracy — do not compare it with pre-2026-09-12 runs. `val_px` / `real_px`
are the rotation-invariant corner error over **matched** detections only;
faces with no match are misses and stay out of the mean, showing up in the F1
instead. `diagnose.py` prints the detection accounting alongside, plus a
rotation column (`rot20%`: the share of matched faces rotated more than 20°
from ground truth) — that is the number that says whether the diamond/hedge
failure mode is back.

`web/` must read `facekp.json` rather than hardcoding preprocessing; for this
head the sidecar carries `head: "center-v1"`, `anonymous: true`, the output
stride and a prose description of the decode.

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
(the FC regression head quantizes terribly). `export_onnx.py` gates on
measured shift (<1 px) and deploys fp32. Browser (headless Chrome, RTX 4070):
webgpu 6.1 ms, wasm 10.9 ms per inference; `web/scripts/check-detect.mjs`
runs both.

**Quantization, center head (2026-09-12):** removing the dense layer did NOT
rescue int8. Static QDQ on the fully convolutional graph still moves corners
5.4 px mean (gate: 1 px), with and without the head's 1x1 Conv
excluded, so fp32 ships — now only **4.66 MB**, which was most of the reason
to want int8 in the first place. The shift is measured by taking the fp32
model's heatmap peaks and reading BOTH models' offsets at those same cells,
so NMS tie-breaking noise cannot contaminate it.

**Inference cost, center head: ~10-15% over the legacy head**, i.e. close to
free. Two alternating rounds, idle box, headless Chrome on an RTX 4070:

| | webgpu | wasm |
|---|---|---|
| legacy ft7 | 5.8, 6.0 ms | 16.1, 13.1 ms |
| center20 | 6.7, 6.5 ms | 17.0, 16.9 ms |

**Do not trust a single `check-detect.mjs` reading - this measurement misled
us twice.** A pass taken while a training run held the GPU read 15.3 / 24.1
ms and looked like a 2.2x regression; the legacy model under that same load
read 15.9 / 21.5 ms against its own 6.1 / 10.9 ms on record. A second pass,
on a box that had only just gone idle, read 9.4 vs 6.2 ms and looked like
1.5x. Only alternating both models over several rounds on a quiet machine
gave a stable answer - and legacy wasm still swung 13.1-16.1 ms between
rounds. Always alternate, always repeat.

Arithmetic, for when the measurement is ambiguous anyway: the neck is two
3x3 convs at 15x20 (144->96->96, ~62 MMACs) where the old squeeze+FC was
~11 MMACs, against a backbone of roughly 90 MMACs at this input size - so
~10-15% is about what theory predicts. If the phone ever misses the fps bar,
the first lever is depthwise-separable fuse convs (~4 MMACs for the same
output shape), not the backbone.

## Center vs legacy head, measured (2026-09-12)

Same data (`../data`), same recipe as `runs/long4` (AdamW, OneCycle over 150
epochs, lr 3e-4, batch 64), so `long4` IS the legacy baseline — no legacy
twin was rerun. `runs/center20` is the center head stopped at epoch 20 to
keep the schedule identical.

| epoch | long4 `val_px` (legacy) | center20 `val_px` |
|---|---|---|
| 5 | 20.22 | **10.66** |
| 10 | 14.40 | **6.57** |
| 20 | 9.74 | **4.46** |

The center head at epoch 20 is where the legacy head got after **150**
epochs (long4 finished at 4.22). Overfit sanity: 0.50 px vs the legacy
head's 2.07 px on the identical check.

**The diamond is gone — this was the point of the exercise.** `diagnose.py`
on `runs/center20/best.pt`, synthetic val, score ≥ 0.5:

```
  size bin      n     mean px   rot med   rot>20%   missed
    0- 40 px  2569      5.72      3.9deg     8.3%      705
   40- 70 px  2860      4.03      1.7deg     0.9%       38
   70-100 px  1453      3.52      1.1deg     0.6%        1
  100-inf px   892      4.68      1.1deg     0.0%        0
```

The >100 px close-up class — the one where the legacy head averaged 27 px by
regressing 45°-rotated hedge quads — is now **4.68 px with 0.0% of faces
rotated more than 20°, and nothing missed**.

**Detection F1 is 0.953**, over the 0.95 bar, once out-of-scanning-range
faces are excluded (see "Scanning range" below; before that exclusion it read
0.945). Lowering the score threshold does not help - at 0.25 F1 drops, buying
79 matches for 211 false positives - so the remaining misses are genuine
non-detections.

**What is left is FORESHORTENING, not distance and not corners.** Grouping
the same val faces by how squashed they are (shortest edge / longest edge):

```
  squash        n     mean px   missed
  0.00-0.25   480       5.35    28.5%
  0.25-0.40   940       4.86    13.1%
  0.40-0.60  1354       4.91     9.6%
  0.60-1.01  4794       4.15     4.6%
```

A clean monotonic gradient: a face seen almost edge-on is missed six times as
often as a face-on one. That lowest bin is the third face of a corner-on
view - exactly the pose `--cornerBias 0.4` was added to supply more of, and
`data_v4` is the first root generated with it. So the biggest expected win
from the full run is already in the plan; re-read this table after it rather
than reaching for stride 8.

This CORRECTS an earlier reading of the same run. Binning by sqrt(area) made
it look like a *small-face* problem (705 of 744 misses under 40 px), which
pointed at the stride-16 grid. That was measurement error: area conflates far
away with steeply angled, and 79% of the faces in that bin are close cubes at
a glancing angle.

Zero-shot on `data_real_val` (no fine-tune, 20 epochs): 8.96 px, 13 of 76
faces missed. Not yet comparable with the deployed `ft7` — the deploy gate
is per batch AFTER the real-photo fine-tune.

## Most misses were the DECODER, not the model (2026-09-12, runs/v4base)

Two thirds of every miss on `data_v4` val was a face the model had found and
the decoder threw away. The 3x3 max-pool NMS keeps a cell only if it is the
brightest within one cell of itself — a suppression radius frozen at one
stride (16 px) no matter how big the cube is on screen. But the spacing
between a cube's three face centres shrinks with the cube: at 43 px per face
they sit ~1.8 cells apart, so the strongest face's Gaussian is still rising
as it crosses the weaker face's own centre cell, and that face is dropped
with the model **0.83 confident** in it.

Measured over the 201 misses (`train/dump_failures.py` draws them,
`train/viz_nms.py` draws the mechanism):

| why the face was missed | share | median squash | median heat at the true centre |
|---|---|---|---|
| confident, but not its own 3x3 max | **62.7%** | 0.72 | 0.83 |
| peak survived, below the 0.5 threshold | 16.9% | 0.20 | 0.40 |
| no peak, model saw nothing | 20.4% | 0.31 | 0.29 |

Note the median squash of the suppressed group: **0.72, i.e. not
foreshortened at all**. Miss rate by how far the nearest other face centre
sits: 12.3% at 1.5–2.5 cells, 1.2% at 2.5–4, 0.8% beyond. And the cell that
outranks the true centre points at the neighbouring face 79% of the time.

**Fix: deduplicate on the decoded quads, radius = 0.5 x the kept quad's own
mean edge** (floor 8 px), candidates = every cell above threshold, strongest
first. The radius then scales with the cube. Same checkpoint, no retraining:

| decode | matched | missed | FP | F1 |
|---|---|---|---|---|
| 3x3 max-pool | 5647 | 201 | 38 | 0.979 |
| size-aware (shipped) | 5771 | **77** | 52 | **0.989** |

Sub-40 px faces went from 176 misses to 64. Mean corner error is unchanged
at 2.6 px (the recovered faces are the harder small ones, so it does not
improve). Ties in the candidate order are broken by cell index, which needs
a **stable descending sort — `torch.topk` does not promise that order** and
was measured returning the higher cell first for an exact tie, which the
TypeScript mirror then disagreed with. `web/test/fixtures/facekp-maps*.json`
pin both implementations; the synthetic one now carries a same-quad pair, a
different-faces-32-px-apart pair, an exact tie, a sub-threshold peak and
off-frame corners.

## Scanning range: how far away we care about (DECISION 2026-09-12, user)

The app only ever has to work as far away as a person can hold a cube. The
user photographed one at full arm's reach - the furthest they can hold it -
and that frame is the definition:

- the face's **longest edge is 36.8 px** at the 320x240 model input
  (sqrt(area) 30.5 px, 1.9 cells of the stride-16 grid);
- equivalently the cube's bounding sphere is **0.266 of the frame height**,
  which is the generator's `fill` parameter.

Two floors follow, deliberately a little apart so nothing we generate lands
in the ignored band:

| where | value | effect |
|---|---|---|
| `gen/scene.mjs` `fill` (far regime) | 0.22 -> **0.27** | stop rendering what nobody will scan |
| `train/targets.py` `MIN_FACE_EDGE_PX` | **32 px** (= fill 0.23) | ignore: don't train, don't score |

"Ignore" means exactly that: an out-of-range face is masked out of the
heatmap loss rather than marked as background. Calling it background would
teach the detector to actively SUPPRESS small faces, which is a different and
worse thing than not caring about them. In the metrics such faces are matched
(so a detection on one is not punished as a false positive) but counted in
neither the pixel mean nor the F1; `diagnose.py` prints how many it set
aside, and `--min-edge 0` scores everything again.

**Use the longest EDGE, never sqrt(area) - this matters more than the
threshold does.** Area conflates "far away" with "steeply angled": a face
seen at a glancing angle on a cube held right against the lens has a small
area but a full-length long edge. Measured on the real photos, **79% of the
faces an area-based rule would have discarded are close-up foreshortened
faces** - the third face of a corner-on view, the most valuable pose in the
set and the one `--cornerBias` exists to produce. An area floor would have
silently deleted the data we went out of our way to generate.

The trim is small, because the generator was already nearly right: 2.4% of
`data` faces and 3.9% of `data_real_val` faces fall below the floor.

## Stage-1 cube localizer (`cubebox`, 2026-09-12, runs/box*)

`train_bbox.py` trains the tiny bbox+objectness net that `web/src/detect/cubebox.ts`
runs at 160x120 to find the cube before stage 2 looks at the crop. Full
investigation write-up: `BBOX-HANDOFF.md`. The short version:

**"The box is too small" was variance, not bias.** Against `data_real_val`
(truth = axis-aligned hull of all visible faces' corners = the silhouette),
the original `box3` had median w/true 0.997, h/true 0.985, per-edge inset
within ±0.02 — but per-edge **sd 0.14–0.20** of the box, so mean IoU 0.790
vs median 0.888. Four measured causes, each in `BBOX-HANDOFF.md` §1:

1. **GAP head** (5 convs → global-average-pool → MLP): throws away *where*.
   Ceiling on clean synthetic val with no occluder: IoU 0.833, 12.9% < 0.7.
   Primary cause. Fixed with `--head dense` (stride-16 grid, per-cell box +
   objectness, soft-argmax read-out). Clean ablation `box5gap` vs `box4`:
   real_iou 0.810 vs 0.834.
2. **Roboflow COCO boxes are a different convention** — ~16% wide, median
   IoU 0.756 vs our silhouette, and mostly just sloppy (`bbox_eval/roboflow_audit.py`).
   They were ~29% of the mix at `--coco-rep 8`. Now `--coco-rep 4` and
   objectness-only (`--coco-box` off, `box_valid=0`).
3. **Train/inference downscale mismatch**: `bbox_data` decimated the 320x240
   cache with `[::2, ::2]` (aliased); the browser's `drawImage` is smooth.
   Feeding box3 an aliased input moved its real median IoU 0.888 → 0.959,
   i.e. it was trained on sharper images than it ever sees. Now `avg_pool2d`.
4. **No portrait pillarbox in the synthetic half** (app feeds 480x640 →
   90x120 content + 35 px grey bars; every render is landscape). Controlled
   A/B on the same val images: ~4% width shrink. Now a pillarbox augmentation
   (p=0.45) plus zoom/translate.

Hands cost ~0.075 IoU and double the bad-frame rate but do **not** pull the
box in to the fingers (median insets identical with/without hands) — it is
noise, consistent with cause 1. Out-of-range cubes (< 32 px at 160x120, see
scanning range above) dominate the raw mean; report the in-range number too.

| run | head | data | change | val_iou | real_iou | real <0.7 | in-range <0.7 | min obj |
|---|---|---|---|---|---|---|---|---|
| box3 | gap | data_v3 + coco×8 | was deployed; data_v3 is gone, not reproducible | 0.822* | 0.790 | 32.4% | 20.7% | 0.91 |
| box4 | dense | data_v4 + real×40 + coco×4 | dense head, new aug, coco obj-only | 0.892 | 0.834 | 13.5% | 3.4% | 0.54 |
| box5gap | gap | same | ablation: old head, everything else new | 0.850 | 0.810 | 13.5% | 3.4% | 0.48 |
| **box6** | dense | same | Gaussian cell target (**deployed**) | 0.886 | **0.846** | 10.8% | 3.4% | 0.07 |
| box7 | dense | same | peak-normalised Gaussian, 80 ep (overfits synthetic) | 0.895 | 0.835 | 8.1% | 3.4% | 0.21 |
| box8 | dense | same | + darkening aug to 0.45× (no measured benefit) | 0.891 | 0.828 | 10.8% | 0.0% | 0.18 |
| box9 | dense | **120x160 portrait**, data_v5 + data_real (157) | PORTRAIT-DESIGN.md; frame cache pooled 2x; `_bars` p 0.15 | 0.890 | 0.845 (42 photos) | 33.0%† | 29.9%† | 0.08† |
| box10 | dense | same + batch 7 (`data_real` 373) | `_side_bars` p 0.10 | 0.885 | 0.837 (96 frames) | 13.2%† | 12.6%† | 0.15† |
| **box11** | dense | same, `data_real*80` | real photos at double weight; **deployed 2026-09-13** | 0.883 | 0.853 (96 frames) | 7.7%† | 7%† | 0.37† |
| box12 | dense | same, `data_real*160` | past the sweet spot: synthetic val_iou drops too | 0.870 | 0.839 (96 frames) | - | - | - |
| box13 | dense | same, `data_real*80` with batches 8-9 (457) | batch 9 0.744 -> 0.837 IoU, batch 8 0.816 -> 0.842; batches 6-7 0.82 (noise, see box16); **deployed 2026-09-13 late** | 0.877 | 0.835 (122 frames) | 12.8%‡ | 12.8%‡ | 0.05‡ |
| box14 | dense | same, `data_real*65` (box11's real share) | batch 9 0.849 / 0% <0.7, batch 7 0.824, batch 6 0.793 - the same picture at a different mixing ratio | - | 0.828 (122 frames) | 12.8%‡ | 12.8%‡ | 0.49‡ |
| box15 | dense | box13 minus batch 9 (427) | batch 7 0.820, batch 6 0.809, batch 9 back to 0.748: the batch 6-7 dip is not batch 9's doing | - | 0.828 (122 frames) | 8.5%‡ | 8.5%‡ | 0.09‡ |
| box16 | dense | **box11's exact data (373) and recipe, rerun** | batch 7 0.837 / 13%, batch 6 0.818 / 12%, overall 0.829 / 12.8%: box11 was a lucky draw | - | 0.831 (122 frames) | 12.8%‡ | 12.8%‡ | 0.15‡ |

‡ box11 re-measured on the same 122-frame val (117 with a cube): 0.839 IoU,
6.4% under 0.7, batch 9 0.744 / 25%. **Stage-1 run-to-run noise is about
±0.02 batch IoU and ±6 points on the <0.7 rate** (box16 is box11 rerun
unchanged and lands with box13-15, not with box11). A single run cannot
resolve a difference of that size; only batch 8 (+0.03-0.04) and batch 9
(+0.09-0.13) moved beyond it when their frames entered training. Do not
chase a 0.02 dip on an old batch after adding data - rerun the baseline
first.

† measured with `bbox_measure.py` on the 96-frame val (91 with a cube); the
earlier rows are on the 37-photo set. Full before/after tables: "Always
two-stage" above.

\* on the data_v3 split; not comparable. box4/6/7/8 are within noise of each
other (37 photos). `real_iou`/`real_bad` are printed every epoch and
`--select real` (default) picks `best.pt` on them. Per-edge sd under box6:
top 0.082, right 0.083, bottom 0.110, left 0.139. Median dropped slightly
(0.888 → 0.875): easy close-ups each gave up a little for the tail.

**Open regression:** `img_real000053` (dim, dead-on, single face, landscape,
against a lit monitor) went objectness 0.99 → 0.07 — the one outright miss.
box5gap shows it too, so it is the data/augmentation, not the head; the
darkening aug (box8) did not fix it. `box4` has no misses (min obj 0.54) at
−0.011 IoU, within noise, and is a defensible alternative deploy.

**Negatives (2026-09-13).** Real no-cube frames from the desk clips scored
objectness 0.3-0.5 on a wristwatch, a bottle, an empty mousepad - right at
the threshold. Two sources of "no cube anywhere" now feed training:
`train_bbox.py --neg ../negatives` (default; a flat dir of photos, obj 0,
pillarboxed like phone frames 45% of the time - `fetch_negatives.py` pulls
COCO val2017, 5000 photos, ~420 MB after resize) and the generator's 7%
negative slice, which since this date keeps hands (30%) and clutter (35%)
instead of being bare tables - the next tranche picks that up.

Things not to do: don't add a scale-up fudge (median size is right, and
`autoscan-main.ts` already pads the crop 0.45); don't run 80 epochs; `train_bbox.py`
has no `--resume`/`--init` — 50 epochs is ~18 min, just rerun.

Evaluation scripts live in `train/bbox_eval/` (edit the hardcoded `ROOT` if
the repo moves): `bbox_measure.py` (per-edge error + IoU of the deployed onnx
on a labelled root), `bbox_rows.py` (per-photo rows + size bins, takes an
onnx path), `bbox_vs_faces.py` (unlabelled frames, keypoint hull as truth,
contact sheet), `sheet_val.py` (annotated sheet), `occl_test.py`
(hands/clutter/shadow split on synthetic val), `aspect_test.py`
(landscape vs portrait A/B), `roboflow_audit.py` (COCO convention audit).

```
cd train
..\.venv\Scripts\python train_bbox.py --data "../data_v4,../data_real*40" --coco ../roboflow --coco-rep 4 ^
    --head dense --epochs 50 --workers 8 --out runs/box9 > runs/box9-console.log 2>&1
cd ..\export
..\.venv\Scripts\python export_bbox.py --ckpt ../train/runs/box9/best.pt   # -> web/public/models/cubebox.onnx + .json
```

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

0. (Optional) Shoot a phone video instead of photos and pull stills out of it:
   `python train/extract_frames.py clip.mp4 --out ../stephens_photos/batch7`
   — one keeper per second, sharpest frame of each window, duplicates
   dropped, phone rotation honoured (bundled ffmpeg via `imageio-ffmpeg`).
   `--every` / `--max` / `--long-side` tune it. Move slowly and change
   *something* every second (distance, angle, grip, light); a clip where
   nothing changes yields one useful frame.
1. Open `<deploy>/label.html` (also in `web/public/`), load photos, click
   each visible face's 4 corners going around the face, export
   `labels-all.json`.
2. `python train/check_labels.py --labels labels-all.json` — fix anything it
   flags (re-export; the importer updates edited labels in place and the
   training cache detects the edit).
3. `python train/import_labels.py --labels labels-all.json --images <photo dir> --out data_real --source-prefix <batch>/` (the prefix keeps clip batches, which all number stills `v00000.jpg..`, from colliding)
4. `python train/train.py --data ../data,../data_real --init runs/long/best.pt --epochs 30 --lr 5e-5 --out runs/ft`
5. `python export/export_onnx.py --ckpt ../train/runs/ft/best.pt`

### Batch 7: phone clips (2026-09-13)

Five hand-held clips (`stephens_photos/video/`, ~4 min total) → 210 stills
at 1/s (`extract_frames.py`, `v*.jpg`) + 69 extras picked by the deployed
models' scores (`bbox_eval/score_frames.py`, `x*.jpg`, `extras-manifest.json`
says why: uncertain / 1face / far / dark / miss / falseface / edge), all
720x1280, all labelled in one sitting. Clips a-b walk through the flat
(living room, bedroom, mirror, bathroom sink), c-d are the desk with the
cube in hand against two monitors, e is the cube sitting on the desk by
the keyboard, far and static.

- **Split** (`batch7/val-picks.json`): the val slice is *contiguous 1-second
  blocks* from every clip (39 stills) plus the extras that fall inside them
  by clip+time (15), so no val frame has a train neighbour half a second
  away. 216 → `data_real`, 54 → `data_real_val` (now 96 frames, 373 in
  `data_real`). Stage 2's `real_px`/`--select real` are therefore weighted
  toward video frames from here on; `diagnose.py` still splits per batch,
  so the old 42-photo numbers stay comparable.
- **Cube-less frames**: 21 were exported with no faces. 12 are real
  negatives (bed, wall, mousepad, wristwatch, bottle, keyboard) and were
  imported as negatives (stage 1 objectness 0; the importer default since
  this batch, `--drop-negatives` opts out). The other 9
  (`v00012 x00002 x00007 x00008 x00011 x00031 x00037 x00047 x00065`) have
  a cube in them — mid-turn with the layers misaligned, or cut off at the
  frame edge — and were **skipped**, not imported: training objectness 0
  on a visible cube would be wrong, and there is no box-only label type.
- `check_labels.py` flagged 5 frames (`v00058 v00065 v00079 v00092 v00201`)
  with two *opposite* faces marked visible (R+L or F+B). Four were letter
  slips caught by a colour audit on 2026-09-13 (yellow centre labelled L,
  orange labelled F) and fixed, along with `v00044 v00085` (yellow as L) and
  batch 8's `v00033 v00039 v00062 v00063` (orange as R); `v00092` has both
  faces under a thumb and stays. The anonymous-quad head does not use the
  slot, so training never saw a difference; the letters matter because the
  colour-side harness uses them as centre-colour truth (`check_labels`
  now reports a thumb or a neutral centre as unverifiable instead of a
  mismatch, and a "reads R" on an L face under warm light is the checker's
  red/orange confusion, not the label's - orange sits at hue 0-5 there,
  red at -17 to -21).
- 720x1280 is 16:9; the app frame is 4:3 from the same sensor width, so the
  frame cache pillarboxes these to 180x320 inside 240x320 (grey side bands,
  cube at its true app scale) and the crop cache cuts them natively.

### Batch 8: outdoor sticker cube (2026-09-13)

Two clips (43 s, `stephens_photos/video/PXL_20260913_2203*.mp4`) of a
white-body stickered cube on a sunny sidewalk: direct sun, hard shadows,
blown highlights on the stickers - the first daylight footage and the first
non-GAN cube in quantity. Stills every 0.5 s (`--every 0.5 --rate 8`, 79
frames); val is contiguous 3-second blocks (`batch8/val-picks.json`, 18),
train 61 minus 7 mid-turn cube-less frames skipped (`--drop-negatives`).
54 -> `data_real` (427), 18 -> `data_real_val` (114).

- `check_labels.py` flags 24 "seams misaligned" faces on this cube. Checked
  by eye: the quads are right; the seam score assumes dark seams between
  flat stickers and this cube has bright white seams, chunky rounded
  stickers and sun reflections. Not a labelling problem.
- **Clip batches reuse `v00000.jpg..`, and the importer keys on the source
  name.** The first batch-8 import silently overwrote 46 batch-7 labels in
  place (repaired from `batch7/labels-train.json`, verified against the
  image bytes). `import_labels.py` now takes `--source-prefix batch8/` and
  refuses a bare name that is already imported from a different image, so
  every clip batch from here on must be imported with its prefix.

### Batch 9: desk, both cubes (2026-09-13)

38 photos at the desk: the GAN stickerless cube held over the keyboard for
the first 14, the white-body sticker cube for the rest, and in about 20 of
them **the other cube sits on the desk unlabelled** (the labeller does one
cube per frame). DECISION: left as-is. Stage 1 emits one box, every frame
has a hand-held labelled cube, and the desk cube is ~0.07 of the frame
height - half the range floor - so "the near one" is the right answer and
the size-scaled Gaussian target puts ~0 on it anyway. Stage 2 only sees the
stage-1 crop. Revisit if a multi-cube frame ever needs both.

Imported with `--source-prefix batch9/` (30 -> `data_real` 457, 8 ->
`data_real_val` 122, `batch9/val-picks.json`: every ~5th photo, 4 per
cube). The val slice was carved out *after* kpft7's fine-tune had trained
on all 38, so kpft7's batch-9 number (4.22 px, 0 missed, 17 faces) is
optimistic; box11 never saw them: **0.744 IoU, 25% under 0.7**, the weakest
batch for stage 1 (keyboard grid + a second far cube). box13 fixes it (0.837);
the batch 6-7 dip that came with it is run-to-run noise (box16), so box13
is deployed.

### Real-data coverage and what to shoot next

Census of `data_real` + `data_real_val` after batch 7 (frames; range bins
are the longest visible edge over frame height, floor 0.133; "edge" = cube
centre within 20% of a frame border):

| batch | frames | val | no cube | 1 face | 2 | 3 | far <0.188 | mid | near >0.25 | edge | landscape | source |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 22 | 4 | 0 | 6 | 12 | 4 | 3 | 4 | 15 | 2 | 0 | 3000x4000 photos |
| 2 | 38 | 7 | 0 | 22 | 11 | 5 | 0 | 1 | 37 | 1 | 10 | photos + app frames |
| 3 | 23 | 4 | 0 | 0 | 12 | 11 | 0 | 0 | 23 | 0 | 0 | app frames |
| 4 | 14 | 3 | 0 | 1 | 7 | 6 | 0 | 2 | 12 | 0 | 0 | app frames |
| 5 | 7 | 2 | 0 | 1 | 3 | 3 | 0 | 0 | 7 | 0 | 0 | app frames |
| 6 | 95 | 22 | 22 | 28 | 30 | 15 | 9 | 22 | 42 | 1 | 0 | 3000x4000 photos |
| 7 | 270 | 54 | 12 | 103 | 119 | 36 | 55 | 96 | 107 | 14 | 0 | 720x1280 clip stills |
| 8 | 79 | 18 | 7* | 27 | 35 | 10 | 2 | 27 | 43 | 1 | 0 | 720x1280 clip stills, outdoors |
| 9 | 38 | 8 | 0 | 7 | 20 | 11 | 10 | 17 | 11 | 0 | 0 | 3000x4000 photos, desk, two cubes |

\* batch 8's seven cube-less frames are all mid-turn cubes, skipped, not
negatives. 579 frames (batch 8 covers items 2 and 3 below: direct sun, hard
shadows, a white-body sticker cube), 27 of them with every face under the range floor. What is
covered well: the stickerless GAN cube in one person's hands, indoors under
warm room light, bed/blanket/wood/tile/desk backgrounds, near and mid
range, a solved and a glossy white-body cube (batch 6), the desk-with-
monitors scene (batch 7 only). What is thin or absent, in the order it is
likely to bite (video is the cheap way for everything but the first):

1. **A desktop webcam, landscape.** Ten landscape frames exist, all phone.
   The `_bars` augmentation is the only thing standing in for a 640x480
   laptop/desktop webcam: wide FOV, noisy, auto-exposure hunting, the
   user's face and torso in frame, cube held toward the lens, monitor
   glow. Capture from the app itself (`/scan.html` Save frame, or the
   debug frame dump) on a laptop: 30-50 frames, several distances, with
   and without the cube.
2. **Daylight and backlight.** A handful of balcony/window shots in batch 6.
   Missing: direct sun with hard shadows and blown highlights on the
   stickers, the cube held against a bright window (silhouette + flare),
   overcast outdoors, and a night room lit by a single lamp or the phone's
   screen. One clip each.
3. **Other cubes.** Almost everything is one GAN stickerless cube. Missing:
   a classic black-body stickered cube, a worn one with faded/peeling
   stickers, a white-body cube, a non-standard scheme, and - as *hard
   negatives* - a 2x2, a 4x4, dice, Lego bricks, a colourful gift box.
   The detector has never been asked to say "not a 3x3".
4. **Hard negatives it will meet.** Tiled walls and grids without a cube
   (batch 6 has tiles only *with* one), a keyboard alone (batch 7 has it),
   colourful clutter, a cube *picture* on a screen or box, a second
   person's hands, a phone case, coffee mugs. Cube-less frames are 7% of
   real data; the synthetic set has 7% too. 30-60 more from the places
   the app will actually be used.
5. **Mid-turn cubes.** Skipped in batch 7 because there is no label for a
   cube whose layers are misaligned (faces are not planar quads). The app
   sees this constantly while the user scrambles or solves. Decision
   needed: either a box-only label (stage 1 keeps tracking, stage 2 refuses
   the frame) or the localizer learns them from clips with no stage-2
   labels. Until then, don't shoot them.
6. **Cube partly out of frame.** 14 batch-7 frames are near a border, but
   frames where a face is *cut* by the border were skipped. Per the
   labelling convention (occluded corners are estimated and clicked) these
   are labelable when the centre sticker is visible; 20-30 such frames
   would teach both stages the app's most common failure while the user
   is adjusting their grip.
7. **Hands and skin.** One person's hands only. A second pair of hands,
   gloves, sleeves, and a cube held in fingertips (most of the face
   uncovered) vs palmed (a face half covered) - stage 2's occlusion
   handling is trained on capsule fingers.
8. **Motion blur and bad focus.** The blur-rejected frames never reach the
   labeller; the app runs on them. A deliberately fast clip (`--blur 0`
   on extraction) with 20-30 blurred-but-labelable frames would show
   whether stage 1 holds the track through a fast move.
9. **Two cubes in one frame.** Stage 1 regresses one box; several batch-7
   desk frames show a second cube on the table, unlabelled (no frame has
   more than 3 faces), so stage 1 is being taught "the one in the hand".
   The app's behaviour with two cubes is undefined; either keep them out
   of the shot list or decide "biggest wins" and label accordingly.
10. **A second phone / front camera.** All source material is one Pixel's
    rear camera. A different phone changes colour rendering (matters for
    the colour stage, not detection) and the front camera changes the
    mirror/FOV; both are one clip's worth.

Data-efficiency note: batch 7's 216 train frames at `*150` oversampling
make real photos ~half of the stage-2 fine-tune (was ~30%); if the
synthetic `val_px` drifts up in `kpft*` runs, drop the multiplier to
`*60`.

## Training performance

Measured on the first 20k run (RTX 4070 SUPER): ~116 s/epoch at ~164 img/s,
GPU 3D utilization ~7% in a sawtooth — the run is **dataloader-bound**, not
GPU-bound. The tax is decoding full 640x480 PNGs per epoch only to resize
them to 320x240.

Fix, in order of payoff:

1. **Pre-decoded cache** — DONE: `dataset.py` lazily builds a cache per
   view (`cache_240x320/` frames for stage 1, `cache_crop320/` silhouette
   crops for stage 2; memory-mapped uint8 images + label tensors, rebuilt
   when the labels change) and reads samples from it; augmentation runs on
   the cached images. Built in parallel since 2026-09-13.
2. **Cheaper worker output** — DONE 2026-09-12. Profiled after (1): a
   worker spent ~6 ms/sample, of which 3.9 ms was `np.random.normal`
   drawing float64 noise and 0.6 ms the float32 normalize, and then shipped
   a 921 KB float tensor through Windows shared memory + pin_memory. Now:
   float32 `Generator.standard_normal` (3.7 -> 2.0 ms), workers return
   uint8 HWC (`raw_uint8=True`) and `dataset.normalize_batch` runs on the
   GPU, loss running-sums stay on-device (no per-step `.item()` syncs),
   `cudnn.benchmark` on. Loader ceiling at 8 workers: 852 -> 1065 img/s.
   `train/check_fast_path.py` proves the uint8 path is bit-identical to the
   float path every other tool still uses.
3. **Photometric augmentation on the GPU** — DONE 2026-09-12.
   `train/gpu_augment.py` runs color jitter, white balance, Gaussian and
   motion blur and noise batched on the device (`photometric_batch`, ~8 ms
   per batch of 64 while sharing the GPU); workers run `augment_sample(...,
   photometric=False)` = geometry + JPEG + erasing + portrait bars at
   1.7 ms/sample (was 4.7). Loader ceiling at 8 workers: 1098 -> 2298 img/s;
   4 workers now do 1414, more than the original code did with 8. The GPU
   ops reproduce PIL to >=99% bit-exact pixels (`check_gpu_augment.py`; PIL
   truncates instead of rounding, deliberately not copied - see
   `color_jitter`). Exact-114 padding pixels are restored after the ops so
   letterbox/pillar bars stay pristine as they are live.
4. **A sync-free training step** - DONE 2026-09-12. Profiled on an idle
   GPU (the earlier "GPU stuck at P8" reading was an artifact: under load it
   sits at P2 / 2.8 GHz): a batch-64 step took 47.6 ms, and the CPU needed
   47 ms just to *issue* it, because ~12 device synchronizations per step
   (GradScaler's `found_inf.item()`, `.any()`/`nonzero()`/bool-mask indexing
   in photometric_batch and build_center_targets, blocking `.to()` on the
   label tensors, `torch.tensor(..., device="cuda")` constants rebuilt every
   step) parked the CPU behind the previous step's backward, so launch time
   and GPU time added up instead of overlapping. Now: fused AdamW (optimizer
   12.6 -> 0.9 ms, and GradScaler hands it the found_inf tensor instead of
   syncing on it), all photometric coin flips/parameters drawn on the CPU
   and shipped in one pinned copy (`gpu_augment._draw_params`), scatter_add
   instead of mask indexing in targets, cached device constants
   (`gpu_augment.const`), non_blocking copies for all four batch tensors.
   `check_fast_path.py` now runs a full step under
   `torch.cuda.set_sync_debug_mode("error")` - keep it passing. Step: 47.6 ->
   25.9 ms (2467 img/s GPU-side, GPU at ~94%); batch 128 gives 51 ms, i.e.
   nothing, so the GPU is now the real limit.
5. **Workers.** Eager, the main thread spends ~25 of every 26 ms issuing
   kernels, and every extra worker's result handling (unpickle, pin)
   competes with it for the GIL, so 4 workers were as good as 8. With step
   6 below the main thread is mostly idle and 8 workers pay again: use
   `--workers 8` (the default) with `--compile` (also the default), 4
   without; 12 buys a last ~5% and sits at the ~80% CPU ceiling. `--workers`
   does not enter the resume guard, so a paused run can switch.
   (`bench_local.py` used to read a burst rate - 30 steps right after the
   prefetch queue filled - which is why an earlier version of this note
   claimed 8 workers were slower; it now measures a 300-step sustained
   window. Trust train.py's own `train <s> <img/s>` numbers first.)

   Per-epoch: the log line ends with `train <s> <img/s>  eval <s>` so the
   val/real_val share is visible; the first epoch also pays worker spawn,
   a cold memmap cache and (compiled) the compile itself. Sustained on
   data_v4 (51,296 train images, desktop in use):

   | setting                      | epoch | train      | eval |
   |------------------------------|-------|------------|------|
   | eager, 4 workers             | 27 s  | 1950 img/s | 1 s  |
   | compiled, 4 workers          | 27 s  | 2050 img/s | 2 s  |
   | compiled, 8 workers          | 17 s  | 3240 img/s | 1 s  |
   | compiled, 12 workers         | 16 s  | 3410 img/s | 1 s  |

   so a 150-epoch from-scratch run is ~45 min (was ~140 s/epoch on long5b
   before 2026-09-12, i.e. ~6 h). The sustained `bench_local.py` sweep
   (300-step windows, data_v4) agrees: eager 4/6/8 workers 2128/2361/2381
   img/s, compiled 2208/2927/3616; batch 128 and 256 lose either way.
6. **torch.compile** - DONE 2026-09-12, `--compile auto|on|off` (default
   auto: try, fall back to eager with a printed line if the backend is
   missing). The model runs through `torch.compile(mode="reduce-overhead",
   dynamic=False)` (Inductor fusion + CUDA graphs: fwd+bwd+opt 20.2 -> 13.8
   ms at batch 64) and the two elementwise augmentation stages through
   `gpu_augment.enable_compile()` (mode "default": 5.8 -> 2.3 ms; not
   "reduce-overhead", the stages mutate inputs and feed eager convolutions,
   and CUDA-graph outputs are static buffers the next replay overwrites).
   The plain module keeps doing checkpoints, --init/--resume, export and
   eval (eval is ~2 s eager and would cost ~25 s of compile per batch shape).
   First-epoch cost: ~150 s cold, ~40 s with Inductor's on-disk cache warm;
   the train loader's last partial batch is one extra graph. Prerequisites
   on this machine: `pip install "triton-windows<3.3"` (pairs with torch
   2.6; in the venv now) and Python >= 3.13.5 (3.13.4's installer shipped
   a pyconfig.h that defines Py_GIL_DISABLED and breaks every extension
   compile - the machine is on 3.13.15). MSVC Build Tools + Windows SDK
   were installed along the way but the GPU-only path does not need them:
   Triton uses its bundled TinyCC for the launcher stubs. Do not trace CPU
   tensors into a compiled function - Inductor's CPU backend does need
   cl.exe, and that is how the first attempt failed. `bench_compile.py`
   measures the modes; `check_gpu_augment.py --compile` proves the compiled
   stages (identity, padding restore).

   **Measured dead ends (don't retry without a new reason):**
   - Hand-rolled CUDA graphs (`torch.cuda.graph` / `make_graphed_callables`
     without Inductor): -5..12% of fwd+bwd+opt. torch.compile's
     reduce-overhead mode does the same plus fusion for free - see step 6.
   - autocast dtype: fp16 19.2 ms, bf16 23.9, fp32 31.5, fp32+tf32 29.8.
   - channels_last: 2.3-3.5x SLOWER (depthwise convs). batch 128/256: no
     gain once the syncs were gone. Photometric pass in fp16: 6.6 -> 5.9 ms
     (launch-bound, not bandwidth-bound) - not worth a dtype split.

**Resource etiquette:** this is the user's daily-driver PC — keep it usable
while jobs run. The agreed CPU ceiling is ~80% (raised from ~56% on
2026-09-12): up to ~12 `--workers` on the 20-thread i5, no more; don't
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
augment.py adds JPEG round-trips, directional
motion blur, and white-balance channel gains at train time (those four cover
the video-pipeline look and retrofit every existing tranche for free).

**Two-stage architecture (decided 2026-09-12; stage 1 shipped as `cubebox`, see
its section above):** stage 1
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
45-degree-diamond / identity-averaging note).

**Render pass 2 DONE 2026-09-12 (review of the v4 previews against real
photos):** fingers were ~1/10 of the cube width; real ones are ~1/3 (thumb
~0.4), so hands are now a palm ellipsoid behind the cube + forearm capsule
off-frame + 2-4 fat fingers built as root (beside the cube) → knuckle (at
the near edge) → tip (on the near face), i.e. they wrap the edge instead of
pointing at the lens. Hands force the first directional light to cast
shadows, so finger shadows land on the stickers. Center logo is now on the
white (U) center in ~80% of cubes, drawn from a wide family (monograms,
wordmarks, oval/ring badges, cube glyphs, pictograms, CJK characters,
stripes, dot grids, QR-ish blocks, inverted badges, two-tone) on either a
white cap or the face's own tile. GAN-style tile profile (35% of stickered
cubes): tile corners facing the center circle are heavily rounded, the
perimeter corners stay near-square — measured on the GAN 356 close-ups.
Layer misalignment (22%): one outer layer left rotated 2-9 deg (20% of
those 10-20 deg); labels rotate the vertices in that layer with it, which is
what a hand labeler clicking the plastic corner does. meta gains
hasPalm/nFingers/logoOnCap/ganProfile/layerTwist. Preview renders:
`model/preview_v5/` (gitignored). User reviewed the previews and signed
off: fingers are "not super realistic" but good enough to teach that
occluders exist — don't iterate on finger realism; composite real hand
cutouts if hands ever measure weak on data_real_val.

**Auto-exposure floor (2026-09-12, ae1976f):** ~3% of frames rendered
near-black (night HDRIs × low `dim` × low exposure; cube mean < 25/255,
colors unreadable). After each render the scene meters the mean luminance
over the cube's projected box (whole frame for negatives) and re-renders
with more exposure, up to 3×, until it clears 0.15 — what a phone's
auto-exposure would do. Murky-but-legible scenes stay. Measured on the
3200-image local `data_v4`: 173 boosted (5.4%), 1 still below the floor.
meta gains `exposureBoost`/`cubeLum`.

**Local `model/data_v4` (3200 images, seed 1, cornerBias 0.4)** is a
sample rendered 2026-09-12 with the final generator; the full ~54k root is
generated on the cloud box (cloud/RUNBOOK.md) and replaces it. All
`data_v4*` roots are gitignored.

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

- Since `data_v5` the renders are **480x640 portrait** (`--width 480 --height 640`);
  `fill` is defined on the vertical FOV so the size distribution is unchanged.
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
data_v5/  generated 480x640 images + labels       <- gitignored (data_v4: the 640x480 set, unused)
train/    keypoint model + training              <- M4 (dataset/augment/model/train)
          train_bbox.py + bbox_eval/               stage-1 localizer + its measurement scripts
export/   torch -> onnx -> int8 quantize         <- M4 (export_onnx.py)
.venv/    Python 3.13 venv                       <- gitignored
```
