# Design: always-two-stage detection, portrait stage 1, square stage 2

Status: DESIGN v3 - all open questions settled by the user 2026-09-12,
implementation and overnight training start from here. v1 answered
`PORTRAIT-BRIEF.md` as written (full-frame stage 2); v2 added the
two-stage requirement; v3 records the decisions and the plan being run.

## Decisions (user, 2026-09-12)

1. **Range stays at arm's reach.** Floor = 0.133 of frame height, never
   extended.
2. **Two-stage is the only path.** Localize -> crop -> corners, on every
   detection tick, on every page. No full-frame stage 2 anywhere.
3. **Stage 1 miss = failure.** No fallback crop. That tick produces no
   detection, the tracker decays, the banner says no cube was found.
4. **Stage 2 input is square**, matched to the data: cube silhouettes have
   aspect 1.00 median (99% within 0.8-1.25), so the crop is square and so
   is the input. Size **256x256**: on a 480x640 phone frame the padded
   crop is ~215 px at the floor and 260 / 488 / 689 px at p5 / p50 / p95,
   so 256 takes the far end of the range without upscaling and downsamples
   the rest.
5. **No interim, no compatibility work.** Old caches are deleted; old
   checkpoints are not fine-tuned from; landscape models are not kept.
6. **Regenerate and retrain everything.** A fresh portrait synthetic set,
   both models trained from scratch on it, then the real-photo fine-tune,
   then export and deploy. Runs overnight.

## 0. Shapes

| model | input | sees | grid (stride 16) | pixels |
|---|---|---|---|---|
| `cubebox` (stage 1) | **120x160** portrait | the whole 480x640 phone frame at scale 0.25, no bars | 8x10 | 19.2k |
| `facekp` (stage 2) | **256x256** square | the padded silhouette crop, ~fully used | 16x16 | 65.5k |

Total pixel budget 84.7k against 96k today (76.8k + 19.2k); the EP
benchmark cache key includes the shape, so the phone re-benchmarks once.
Desktop (landscape webcam) costs 0.75x on stage 1 only, with cubes 2.3x the
floor; stage 2 is orientation-free.

Why the crop fixes the far-cube problem better than any input size: stage 2
becomes scale-normalized. The cube hull is ~135 px in the input at every
distance, a face edge ~100 px = 6 cells, against 2 cells at the floor with
today's full-frame 320x240. Corner error in source px = model error / crop
scale: 2.5 source px at the floor (6 today), 8 source px on the nearest
cubes (6 today; on 60 px stickers, irrelevant).

## 1. Data: fresh portrait render, two caches

**Render `data_v5`: 54k at 480x640** with the generator as it is
(`--width 480 --height 640 --cornerBias 0.4`, negatives and hands/clutter
at their current rates). `fill` is defined on the vertical FOV so the size
distribution is unchanged; `inFrame` uses the render's own size so labels
are right. Portrait renders make stage 1's cache a plain letterbox (no
sliding-crop trick needed) and compose hands, clutter and background for a
tall frame. Local rate 7-9 img/s per instance; N instances into
`data_v5_part$i` roots, merged.

**Frame cache `cache_240x320/`** (stage 1): the existing letterbox path at
the new shape. 480x640 -> 240x320 exactly, no bars. `SynthBBox` pools it by
2 to 120x160 with `avg_pool2d` as today. Real photos (3:4) fill it too; the
10 landscape real photos get top/bottom bars, which is the desktop case.

**Crop cache `cache_crop320/`** (stage 2, new `view="crop"` in
`CubeKeypointDataset`): one padded-silhouette crop per image taken from the
**native** image (480x640 render, 3000x4000 photo), per-side padding
U(0.2, 0.7), deterministic by index, letterboxed square to 320x320 with the
rgb(114) pad; corners in crop-normalized coords. Train time `_zoom_crop`
re-crops the canvas with per-side padding U(-0.1, 0.45) (negative = the
localizer clipped the cube, which its per-edge sd of 0.08-0.14 says
happens) and letterboxes to 256; worst-case upscale 1.6x, like the floor's
1.2x at runtime. Val: pad 0.45, no jitter = the app's `padBox`. Why not the
existing `_zoom_crop` on the frame cache: it cuts a far cube's 60 px window
out of a 320x240 thumbnail and blows it up 5x, while the app cuts 215 px out
of the source and shrinks it - the same train/inference mismatch that capped
cubebox (BBOX-HANDOFF §1c).

Negatives in the crop cache: 7% of renders are cube-less; their "crop" is a
random square window (a stage-1 false positive on a hand or a mug), all
faces `conf = 0`.

**Augmentation.** `_portrait_sim` and `_pillarbox` go. Stage 1 gets
`_bars` (4:3 window, top/bottom bars, p 0.15 = desktop). COCO negatives for
stage 1 get a random 3:4 crop at p 0.6 so they look like empty phone
frames. Stage 2's out-of-distribution cases are the loose/negative crops in
the cache. Photometric/GPU augmentation and `_affine` are shape-agnostic.

**Disk.** Delete `cache_320x240/` under `data_v4`, `data_real`,
`data_real_val`. `data_v4` itself stays on disk unused. New caches: 12.4 GB
frame + 16.6 GB crop for 54k.

## 2. The floor

Fractions of the *source frame height*, orientation-free:

| quantity | value | px on 480x640 |
|---|---|---|
| arm's-reach longest face edge | 0.153 | 98 |
| `MIN_FACE_EDGE_FRAC` | **0.133** | 85 |
| stage-1 in-range test (silhouette long side, same fraction) | 0.133 | 85 |
| generator `fill` (far regime) | 0.27, unchanged | |

Every calibration candidate is a 3000x4000 portrait photo, so the fraction
is exact. Applied: `targets.py` derives the ignore floor in model px from
the fraction and the input height (42.7 px at 320; 34 px at 256, which on
crops only masks the sliver of a third face at the edge of a loose crop);
`scene.mjs` comment; web `color.ts` gets `MIN_FACE_EDGE_FRAC` compared in
**source px** - both callers change, because `autoscan-main.ts` scales the
box by the detector's letterbox scale (meaningless under a square crop) and
`identify.ts` measures letterboxed quads (inflated by the crop zoom, so the
"too small" refusal would never fire). `facePlan` keeps its budget math and
receives source cell px, which is what its constants were measured in.

## 3. Web: two-stage as the only path

Already there (commit `eb06ef5`): `CubeLocalizer`, `detect(source, roi)`
with corners mapped back to frame px, `padBox`, the cadence in
`autoscan-main.ts`, the `cropTrained` stamp. Changes:

1. **`detect/twostage.ts`** (new): one function
   `detectTwoStage(localizer, detector, video) -> { result | null, box,
   roi }`: stage 1 every detection tick (~1 ms on wasm); `roi = padBox(box,
   0.45)`; stage 2 on the ROI; on a stage-1 miss return null. No
   tracker-hull ROI, no centre crop, no full frame. Used by
   `scan-main.ts` (one page since 2026-09-13; its debug panel has the stage-1-only switch that `bbox.html` was)
   page.
2. **Miss handling**: a null tick feeds the tracker nothing (tracks decay as
   they do today when the detector finds nothing); `HintState` shows "no
   cube found" through the existing banner; `cubeTooSmall` compares the
   box's long side to `MIN_FACE_EDGE_FRAC * videoHeight`.
3. **`cropTrained`** is stamped by default for the square export and the
   pages refuse to run a model without it (there is no single-stage path
   to fall back to). A missing `cubebox.json` is the same as a missing
   `facekp.json`: "no model deployed, use the grid scanner".
4. **Debug overlay**: the stage-1 box + objectness and the ROI rectangle on
   both pages; the heat map already maps through `cellToSource`, which is
   ROI-aware.
5. **Tests**: ROI geometry test (a fixture frame with labelled corners
   through `detect(source, roi)` on a stub session, corners back within
   1 px); `facekp-maps-square.json` decode fixture from the new model;
   `identify.test.ts` frame/face sizes against the fraction.

## 4. Training plan (tonight, in order)

0. `train/shapes.py`: `BOX_WH = (120, 160)`, `KP_WH = (256, 256)`,
   `FRAME_CACHE_WH = (240, 320)`, `CROP_CACHE_WH = (320, 320)`,
   `MIN_FACE_EDGE_FRAC = 0.133`. Every script with its own `INPUT_WH`
   imports it; eval/export read `ckpt["input_wh"]` and `ckpt["view"]`.
1. Generator preview at 480x640 (24 frames, `visualize.mjs`) - eyeball
   hands/clutter/labels in a tall frame - then the 54k render in parallel
   instances (CPU ceiling ~80%).
2. Delete old caches. Build the frame cache and the crop cache on
   `data_v5`, `data_real`, `data_real_val` (minutes each).
3. **Stage 1 from scratch**: `train_bbox.py --data ../data_v5,../data_real*40
   --coco ../roboflow --neg ../negatives --head dense --epochs 50` (~18 min).
   `--select real` picks `best.pt` on `data_real_val` IoU.
4. **Stage 2 from scratch**: `train.py --view crop --data ../data_v5
   --epochs 150` (~45 min at today's per-epoch cost).
5. **Stage 2 real fine-tune**: the proven recipe, `--init` step 4's
   `best.pt`, `--data ../data_v5,../data_real*150 --epochs 15 --lr 5e-5
   --select real`.
6. Export both (`export_bbox.py`, `export_onnx.py` with the crop stamp),
   deploy to `web/public/models/`, `npm test`, push (Pages deploys).
7. Measurement (§5) written into README and this file; phone check in the
   morning via `/scan.html`.

## 5. Measurement

Before = deployed `v4ft1`/`box6`. Bins as fractions of frame height: far
0.133-0.188, mid 0.188-0.25, near > 0.25.

| what | script |
|---|---|
| stage 2 `real_px`, F1, per batch, far bin, on `data_real_val` **crops** (pad 0.45, and jittered ±0.15 per side for localizer error) | `diagnose.py` (crop view) |
| stage 2 close-up corner error in source px | same |
| stage 2 synthetic `val_px` on the crop cache | `train.py` |
| cubebox `real_iou`, in-range <0.7, per-edge sd, size bins | `train_bbox.py` log, `bbox_measure.py`, `bbox_rows.py` |
| end-to-end on the phone: faces per frame, lock time, fps, both EPs | `/scan.html` |
| batch7 (720x1280) once labelled; phone clips re-scored | `score_frames.py` |

Baselines: v4ft1 full-frame 3.31 px mean / 3.03 median, 4 missed of 73;
box6 real_iou 0.846, in-range <0.7 3.4%, bins 0-30: 0.496, 30-45: 0.797,
45-60: 0.846 (box3).

**Phone clips.** They came out of `extract_frames.py` (long side 1280), so
they are 720x1280 video frames, not 480x640 app frames. A 16:9 frame into
160x120 uses 67.5 px of width vs the app's 90, so if the phone's video is
the usual vertical crop of the 4:3 sensor the clip figures understate what
the app sees by 1.33x. Not blocking: stage 1 is measured on app frames via
`scan.html` (stage 2 off), stage 2 no longer cares.

**Resolution.** Stage 2 is scale-normalized by the crop, so model input
size is no longer the far-cube lever; capture resolution is (a 720x1280
frame would give ~323 px of crop at the floor and 2.25x the pixels per
sticker for colour, at the cost of a 3.7 MB frame read). Deferred; a
one-line `camera.ts` experiment with an fps number, after this lands.

**Results (2026-09-13 morning).** Measured as planned, on the 96-frame
`data_real_val` (42 photos + 54 batch-7 clip stills held out as time blocks)
with the previous pair re-run on the same frames; the full tables are in
`README.md` "Always two-stage". Headline:

| | before (v4ft1 + box6) | now (kpft3 + box11, deployed) |
|---|---|---|
| stage 2 F1 / missed | 0.936 / 13 of 166 | 0.961 / 4 of 178 |
| stage 2 source-px error far / mid / near | 32 / 35 / 27 | 10 / 14 / 16 |
| stage 2 with the crop jittered ±0.15 | - | 3.51 vs 3.54 model px: unaffected |
| stage 2 synthetic val_px (crop cache) | - | 2.79 |
| stage 1 mean IoU / tail < 0.7 | 0.733 / 27.5% | 0.852 / 7.7% |
| stage 1 far bin IoU | 0.32 | 0.81 |
| stage 1 per-edge sd | 0.24-0.36 | 0.04-0.09 |

The range floor did what it was for: the 12 faces under it are all found
(v4ft1 ignored them and found only 7), and nothing else was lost. Batch 7 was
labelled the same morning; `score_frames.py` on the clips is superseded by
the labelled measurement above. Phone check: `/scan.html`.

## 6. Hardcoded shapes to replace (grep of both trees)

`web/`: nothing hardcodes the shapes (sidecar-driven). Floor (§2),
`identify.test.ts` sizes, the decode fixture, `facekp.ts` header comment.

`model/`: `train.py:29`, `diagnose.py:39`, `dump_failures.py:36`,
`predict.py:31`, `viz_nms.py:33,179`, `dump_decode_fixture.py:8,30`,
`bench_local.py:20,35`, `bench_compile.py:49,58`, `check_fast_path.py:29`,
`check_gpu_augment.py:25`, `check_targets.py:27`, `dataset.py:159`,
`model.py:35,93,169,196,257,363`, `bbox_data.py:57,165`, `train_bbox.py:43`
(`GRID_W, GRID_H = 10, 8` -> probe), `export/export_onnx.py:47`,
`bbox_eval/score_frames.py:13-14`, `bbox_eval/bbox_vs_faces.py:21,23,73`,
`bbox_eval/roboflow_audit.py:16,18`.

## 7. Handoff notes for the implementer

Read `CLAUDE.md` (working style, training-run rules, CPU ceiling) and
`model/README.md` "Training performance" before launching anything.

- **Machine:** 20 cores, RTX 4070 SUPER 12 GB, 768 GB free. CPU ceiling
  ~80%: use at most ~12 DataLoader workers and no more than 4-5 render
  instances at once.
- **Generator preview already done:** `model/preview_v5/` holds 24 fresh
  480x640 frames (`img_000065..88`, `viz/` overlays) at 5.2 img/s on one
  instance - but the same root also holds 64 OLD 640x480 frames from an
  earlier session. Delete `preview_v5` before re-rendering into it, and
  never merge it into `data_v5`.
- **Full render recipe:** `model/cloud/RUNBOOK.md` §3 - N instances into
  `data_v5_part$i`, each with a distinct `--seed $i`, plus
  `--width 480 --height 640 --cornerBias 0.4`; then the merge snippet in
  the same section (renumbering copy, since labels reference images by
  relative path). Run `train/check_labels.py --data data_v5` afterwards.
- **Old caches to delete:** `data_v4/cache_320x240`,
  `data_real/cache_320x240`, `data_real_val/cache_320x240`. `data_v4`
  itself stays (unused by this plan).
- **Baselines to compare against** (record in §5 before overwriting
  `web/public/models/`): stage 2 `runs/v4ft1/best.pt`, stage 1
  `runs/box6/best.pt`; their sidecars are the deployed `facekp.json` /
  `cubebox.json`.
- **Killing a run leaves orphaned DataLoader workers** holding the console
  log (see `CLAUDE.md` hard-won facts); detached launches fail silently -
  run training as a session background task and redirect output to
  `runs/<name>-console.log`. Start `train/watch.py` (port 8123, probe
  first) and give the user the URL and a `Get-Content -Wait` command.
- **`data_real_val` is never trained on and its labels are never edited.**
- **Order matters:** shapes module -> cache code -> render finishes ->
  caches -> stage 1 -> stage 2 scratch -> stage 2 real fine-tune -> export
  both -> web -> `npm test` -> commit + push (Pages deploys). The web work
  can be done while renders and runs are in progress.
