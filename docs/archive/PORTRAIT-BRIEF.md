> Archived 2026-09-22: superseded by `model/PORTRAIT-DESIGN.md`, which is current and cited. Kept for the measurements.

# Brief: make the detectors' input match the phone's portrait frame

Design task. Read `CLAUDE.md`, `MILESTONES.md`, and `model/README.md`
(sections "Scanning range", "Stage-1 cube localizer") first. Produce a design
and an ordered implementation plan; don't start coding until the open
questions at the end are settled.

## The problem

Both neural nets take a **landscape** input: the face-keypoint model
(`facekp`) at 320x240 and the cube localizer (`cubebox`) at 160x120. The app
on a phone delivers a **portrait** frame, 480 wide x 640 tall (`camera.ts`
asks for 640x480; the browser swaps it in portrait). Fitting a tall frame
into a wide slot means scaling until the *height* fits, which leaves grey
bars on both sides:

| model | input | phone frame scale | content | bars | pixels wasted |
|---|---|---|---|---|---|
| facekp | 320x240 | 0.375 | 180x240 | 70 px each side | 44% |
| cubebox | 160x120 | 0.1875 | 90x120 | 35 px each side | 44% |

With a portrait input of the same pixel count (240x320 / 120x160) the scale
would be 0.5 / 0.25: **the cube is 33% larger in every model pixel**, for
free. This matters because the project's scanning floor is a face edge of
32 px at facekp scale: on the 2026-09-13 phone clips (5 clips, 1000 frames
scored with the deployed models) **25% of frames had the cube below the
cubebox equivalent of that floor and another 50% within 32-45 px** — even
though the cube looked a reasonable size on screen. A cube filling 25% of the
phone's frame height is *at* the floor today; it would be comfortably inside
it with a portrait input. The far-cube frames are the localizer's worst
failures (`BBOX-HANDOFF.md` (beside this file) §1, size bins).

The current mitigation is augmentation that teaches the models to tolerate
the bars (`augment.py _portrait_sim`, `bbox_data._pillarbox`). It does not
recover the pixels.

## What is true today (constraints)

- **Real data is portrait.** `data_real` + `data_real_val`: 41 of 42 val
  photos are portrait (3000x4000 camera stills or 480x640 app frames). The
  new `stephens_photos/batch7` (279 frames from video) is 720x1280 portrait.
- **Synthetic data is landscape.** All 54k renders in `data_v4` are 640x480.
  The generator already takes `--width/--height` (`gen/generate.mjs`), so
  portrait renders are a flag, but rendering a new tranche is a cloud job.
- **Both nets are fully convolutional.** Weights don't care about the shape;
  only the ONNX static input shape (`export_onnx.py`, `export_bbox.py`),
  the training tensors, and the caches do. The keypoint head is a stride-16
  heatmap; cubebox's dense head is a stride-16 grid + soft-argmax.
- **The training cache is shape-keyed**: `dataset.py` writes
  `cache_{w}x{h}/` per root and fingerprints label files. A new input shape
  means a full cache rebuild (fast, minutes) and the old cache stays valid
  for landscape runs.
- **Calibrated constants assume 320x240**: `MIN_FACE_EDGE_PX = 32`
  (`web/src/color.ts`, `train/targets.py`) was set from "longest face edge is
  36.8 px at the 320x240 input at full arm's reach"; the generator's far-
  regime `fill` 0.27 and `MIN_FACE_EDGE_PX` are deliberately a little apart.
  Rescaling the input rescales what those numbers mean.
- **Web-side letterbox math** lives in `detect/facekp.ts` (`iw/ih`,
  letterbox to model then map corners back), `detect/cubebox.ts` (same, plus
  `padBox`), and `detect-main.ts`/`autoscan-main.ts` use `iw/ih` for the
  scale. Tracker, rectify, colour sampling all work in frame pixels and are
  unaffected.
- **Fixtures**: `web/test/fixtures/` has real frames with expected outputs;
  `facekp-decode.test.ts` and `rectify-real.test.ts` read them. Some encode
  the 320x240 geometry.
- **Desktop still matters.** Dev happens with a landscape webcam, and the
  `detect.html`/`autoscan.html` debug pages must keep working there; a
  landscape frame into a portrait input would simply get top/bottom bars —
  the mirror of today — which is acceptable but should be measured.
- `model/` and `web/` must stay independent; `web/` must run with no model.

## What the design must decide

1. **Input shape.** Portrait-only (240x320 / 120x160), square (e.g.
   288x288), or export one model per orientation and pick at runtime by
   `videoWidth < videoHeight`. Argue from pixels-on-cube for the phone case
   and from what desktop/landscape loses. (My prior: portrait-only, measure
   landscape degradation, accept it if small.)
2. **Training data path.** Options: (a) render a new portrait tranche
   (`--width 480 --height 640`) and letterbox the existing landscape 54k
   into the portrait input with top/bottom bars; (b) centre-crop existing
   landscape renders to 3:4 (loses the sides; check how often the cube is
   cut and what the generator's placement distribution does); (c) both.
   Real photos are already portrait and would finally fill the input.
3. **Recalibrating the floor.** Say explicitly what `MIN_FACE_EDGE_PX`, the
   generator `fill`, and `targets.py` become, and re-derive them from the
   same arm's-length photo rather than scaling by 4/3 blindly.
4. **Order of operations.** Cubebox first is cheap (18-min runs, 37-photo
   holdout, `bbox_eval/` scripts measure it) and proves the pipeline before
   facekp (45-min from-scratch runs, fixture churn). Fine-tune from the
   existing landscape checkpoints vs from scratch — say which and why.
5. **Compatibility.** Sidecar JSON (`facekp.json`/`cubebox.json`) already
   carries `input.shape`; the web loaders read it. Confirm nothing else
   hardcodes 320/240 or 160/120 (grep both trees). Old checkpoints must
   still export.
6. **Measurement.** Before/after on `data_real_val` (real_px for facekp,
   real_iou / in-range bad-rate for cubebox), on the batch7 frames once
   labelled, and specifically the far-cube bin (30-45 px today). Also fps on
   the phone: same pixel count should be same cost, verify.

## Out of scope

Anything about colour, the tracker, orientation resolution, or the M8
fallback. Don't touch `data_real_val` labels. Don't add a scale-up fudge to
boxes (see `BBOX-HANDOFF.md` (beside this file) §4.6).

## Pointers

`web/src/camera.ts`, `web/src/detect/{facekp,cubebox}.ts`,
`web/src/color.ts` (MIN_FACE_EDGE_PX), `model/train/{dataset,augment,
targets,bbox_data,train,train_bbox}.py`, `model/export/export_{onnx,bbox}.py`,
`model/gen/generate.mjs`, `model/README.md` "Scanning range" (the arm's-
length calibration), `model/BBOX-HANDOFF.md` §1(d) (the measured 4% width
shrink from pillarboxing), `model/train/bbox_eval/score_frames.py` (how the
25% / 50% figures above were produced).
