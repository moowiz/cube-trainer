# Design: portrait input + always-two-stage detection (answers `PORTRAIT-BRIEF.md`)

Status: DESIGN v2, no code changed. v1 answered the brief as written
(full-frame stage 2). The user then settled two open questions and added a
requirement, which changes the shape answer for stage 2:

- **Range stays at arm's reach.** The floor is a fraction of frame height
  and does not move (§3).
- **Everything goes through the two-stage path** (localize -> crop ->
  corners). Stage 1 sees the frame, so it wants the frame's aspect
  (portrait). Stage 2 sees a cube crop, and cube crops are **square**: 99%
  of silhouettes in both real and synthetic labels have aspect 0.8-1.25
  (median 1.00). A portrait stage 2 would waste 25% of its input on the
  crop exactly the way the landscape one wastes 44% on the frame today.

Numbers are from throwaway scripts over the label files (6000-frame
`data_v4` sample, seed 0; all 199 real labels; `web/test/fixtures`).

## 0. The one-paragraph version

Stage 1 (`cubebox`) goes portrait, **120x160**, trained on a full-frame cache
that crops the landscape renders to 3:4 with a window that slides to contain
the cube (exact phone geometry). Stage 2 (`facekp`) goes **square, 256x256**,
trained on a crop cache taken from the *native* render/photo around the
padded silhouette, so that training crops are downsampled like runtime crops
and never blown up from a 320x240 thumbnail as `_zoom_crop` does today. The
scanning floor stays 0.133 of frame height (arm's reach 0.153); in the web
it becomes a fraction compared in source px, because model px no longer
mean anything once the input is a crop. The two-stage plumbing already
exists in `web/` and is dormant only because no export has stamped
`cropTrained: true`; the deployed `v4ft1` was in fact trained with the 70%
crop mix, so the first step is to *measure it on crops* and, if it holds,
flip the flag and ship two-stage on the phone before any retraining. Then
cubebox portrait, then the square stage 2, then the web changes that make
two-stage the only path on both pages.

## 1. Shapes

Letterbox scale = min(iw/w, ih/h); "wasted" = padded fraction of the input.

**Stage 1 sees the frame.**

| cubebox input | phone 480x640 | desktop 640x480 | pixels |
|---|---|---|---|
| 160x120 (today) | 0.1875, 35 px side bars, 44% wasted | 0.25, no bars | 19.2k |
| **120x160** | **0.25**, no bars | 0.1875, 35 px top/bottom bars, 44% wasted | 19.2k |

Cube 1.33x larger in every model pixel on the phone. This is where the
far-cube failures live (BBOX-HANDOFF §1 size bins: 30-45 px IoU 0.797 vs
45-60 px 0.846), and this is the brief's gain, delivered where it matters.

**Stage 2 sees a crop.** The crop is the padded silhouette (`padBox` 0.45
from the localizer, 0.4 from the tracker hull), aspect preserved, so it is
square to within ±20%.

| facekp input | square crop | phone frame (fallback) | pixels | grid |
|---|---|---|---|---|
| 320x240 (today) | 0.75x used | 44% wasted | 76.8k | 15x20 |
| 240x320 (brief) | 0.75x used | 0% wasted | 76.8k | 20x15 |
| **256x256** | **fully used** | 25% wasted (side bars) | 65.5k | 16x16 |
| 288x288 | fully used | 25% wasted | 82.9k | 18x18 |

Measured on the real labels, a 480x640 phone frame's padded crop is 260 /
488 / 689 px (p5 / p50 / p95); at the floor it is ~215 px. So stage 2 at 256
downsamples nearly every crop and upscales the floor case by 1.2x. Inside
the input the cube hull is ~135 px and a face edge ~100 px = **6 stride-16
cells at every distance**, against 2 cells at the floor today. Corner error
in source px = model error / crop scale: at the floor that is 3 px / 1.19 =
2.5 source px (6 today); on the nearest cubes 3 px / 0.37 = 8 source px
(6 today) - on 60 px stickers, irrelevant.

**DECISION (proposed): cubebox 120x160, facekp 256x256.** 256 over 288 for
15% less compute than today at a resolution the crop makes sufficient; the
tripwire to go to 288 is close-up corner error in source px getting worse
than v4ft1's on `data_real_val`.

Desktop cost is now confined to stage 1 (0.75x on a webcam whose cubes are
2.3x the floor: the 10 landscape real photos have a median face edge of
143 px today) and stage 2 is orientation-free. The dual-export escape hatch
from v1 is no longer needed.

## 2. Training data

### 2.1 Two caches, one dataset class

`CubeKeypointDataset` gets a `view` argument; cache dirs are keyed by it.

**`view="frame"` -> `cache_240x320_frame/`** (stage 1; 12.4 GB for 54k).
Full frame. When the source aspect is wider than the target (640x480 renders;
never 3:4 photos; never today's 320x240 path, which stays byte-identical):
window = full height x (h x 3/4), centred on the hull of visible+valid
faces, clamped to the frame, deterministic ±10% jitter seeded by index;
hull wider than the window (16.2% of renders, the close-up regime) is cut on
both sides; faces whose centre leaves the window get `conf = 0` (the
generator's own `inFrame` rule and `augment._center_in_frame`). Why crop and
not letterbox: letterboxing shrinks renders to 0.375 against the phone's 0.5
and pushes 24.8% of synthetic faces under the floor; a centred crop cuts
26.1% of cubes, a sliding one 16.2%. `SynthBBox` keeps pooling this by 2 to
120x160 with `avg_pool2d`, unchanged.

**`view="crop"` -> `cache_320x320_crop/`** (stage 2; 16.6 GB for 54k). One
padded-silhouette crop per image taken from the **native** image (640x480
render, 3000x4000 photo), per-side padding U(0.2, 0.7) deterministic by
index, 10% of images loose (U(0.7, 1.5)) to stand in for the no-localizer
fallback; letterboxed to 320x320 with the usual rgb(114) pad; corners in
crop-normalized coords. Train time: the existing `_zoom_crop` re-crops this
canvas with per-side padding U(-0.1, 0.45) - negative so the model sees a
box that clipped the cube, which the localizer's per-edge sd (0.08-0.14)
says happens - and letterboxes to 256; worst-case upscale 1.6x, comparable
to the floor's 1.2x at runtime. Val uses pad 0.45 (the app's) and no
jitter, so `val_px` is measured on the runtime distribution.

Why the cache has to change: today `_zoom_crop` cuts a 60 px window out of a
320x240 thumbnail for a far cube and blows it up 5x, while the app cuts 215
px out of the source and shrinks it. That is the same kind of train/infer
mismatch that cost cubebox its median IoU (BBOX-HANDOFF §1c). The crop cache
is what stops it from being the ceiling of stage 2.

### 2.2 Augmentation

- `augment._portrait_sim` (side bars) goes. Stage 2's bars are the loose
  and fallback crops above. Stage 1's `bbox_data._pillarbox` becomes
  `_bars(target_aspect)` simulating the **desktop** case (4:3 window, top/
  bottom bars) at p 0.15; `_has_bars` checks row 0 too; `NegDir` COCO
  negatives get a random 3:4 crop at p 0.6 so they look like empty phone
  frames instead of letterboxed landscape photos.
- Photometric/GPU augmentation and `_affine` read the image size and are
  shape-agnostic.

### 2.3 Portrait tranche

`generate.mjs --width 480 --height 640` already works, `fill` is defined on
the vertical FOV so sizes are unchanged, `inFrame` uses the render's own
size. Locally 7-9 img/s -> 10k frames ≈ 25 min. It adds hands/clutter/
background composed for a tall frame. Scheduled only if the frame-cache
cubebox leaves a measurable gap on real data (§6); it does not affect stage
2 at all (crops are crops).

## 3. The floor, settled

Range does not extend beyond arm's reach (user, 2026-09-12). Both floors are
fractions of the *source frame height*, orientation-free:

| quantity | value | px on a 480x640 phone frame |
|---|---|---|
| arm's-reach longest face edge | 0.153 of frame height | 98 |
| `MIN_FACE_EDGE_FRAC` (was 32 px at 240 tall) | **0.133** | 85 |
| stage-1 "in range" (silhouette long side, same fraction, lenient by the 1.33-1.54 hull/edge ratio) | 0.133 | 85 |
| generator `fill` (bounding-sphere radius / half frame height) | **0.27, unchanged** | |

Every calibration candidate is a 3000x4000 portrait photo (the faces nearest
36.8 px are `img_real000017` at 37.3 and `img_real000128` at 38.3, both
3000x4000), so the fraction is exact, not a 4/3 guess.

Where the fraction is applied:
- `targets.py`: `MIN_FACE_EDGE_PX = MIN_FACE_EDGE_FRAC * input_h` is the
  ignore floor in model px. For the frame cache that is 42.7 px at 320
  tall. For the crop cache it is 34 px at 256 and almost never triggers
  (crops make faces big); it still masks the sliver of a third face at the
  edge of a loose crop. The collision warning should drop, not rise.
- `scene.mjs`: comment only ("184.7 x fill px at 320 tall").
- **web (`color.ts`)**: `MIN_FACE_EDGE_PX = 32` becomes
  `MIN_FACE_EDGE_FRAC = 0.133` compared in **source px against the source
  frame height**. Both callers must change: `autoscan-main.ts` scales the
  box by the *detector's* letterbox scale, which under a square input is
  0.4 for a phone frame and means nothing; `identify.ts` measures the
  letterboxed quads, which under a crop are inflated by the crop zoom, so
  the "too small" refusal would never fire. Size checks move to the source
  quads (`result.quads[i].corners`); colour naming keeps sampling from the
  letterboxed crop, which has at least the source's pixels. `facePlan`'s
  budget math stays as it is (colour is out of scope) and receives source
  cell px, which is what its measured constants were derived in.

What the brief's phone-clip figures mean now: a cube below 0.133 of the
frame height is still out of range wherever the pixels are, so "25% below
the floor" does not go to 0. See §6 for why those figures are also
pessimistic by ~1.33x.

## 4. Two-stage: what exists, what is missing

**Everything runs on the frontend** - there is no server anywhere in the
pipeline, and the whole two-stage mechanism is already in `web/`
(commit `eb06ef5`, "dormant until stage 2"):

| piece | where | status |
|---|---|---|
| stage-1 localizer, letterbox, decode, `padBox` | `detect/cubebox.ts` | shipped (`box6`) |
| stage 2 on an ROI, corners mapped back to frame px | `detect/facekp.ts detect(source, roi)` | shipped |
| cadence: tracked cube -> tracker-hull ROI (stage 1 idle); acquisition -> localizer; miss -> full frame | `autoscan-main.ts` | shipped, **gated on `detector.cropTrained`** |
| `cropTrained` stamp | `export_onnx.py --crop-trained` | exists; **never passed**, so `facekp.json` says `false` and the gate is closed |
| stage-2 crop training distribution | `augment._zoom_crop` p 0.7 | in every run since 12:11 on 2026-09-12, i.e. **`v4base` and `v4ft1` were trained on it** (best.pt 19:22 / 19:34) |
| stage 2 measured on crops | nowhere | the "batch4 median 6% -> 11.7%" number is from `ft7`, before the crop mix existed |
| `detect.html` debug page | `detect-main.ts` | single-stage full frame only |
| ROI / stage-1 box in the debug overlay | - | missing |
| fallback when stage 1 misses | full frame | should be a centre square crop (§4.2) |
| size floor in source px | - | missing (§3) |

### 4.1 Interim: light it up with the model already deployed

`v4ft1` has seen 70% crop-normalized views (from the blurry thumbnail cache,
but seen). Add `--crop` to `diagnose.py`: for each `data_real_val` image,
crop the hull padded by 0.45 (plus a jittered variant, ±0.15 per side, for
localizer error), letterbox the crop to the model input, decode, map back,
score `real_px`/F1 exactly as today. If crop `real_px` is within ~0.5 px of
full-frame and F1 does not drop, re-export `v4ft1` with `--crop-trained`
and deploy. The phone runs two-stage the same day, with the landscape
models, and every later step is measured against a live two-stage baseline
rather than a dormant one. If it degrades, we learn the size of the
thumbnail-crop mismatch, which is the number that justifies §2.1.

### 4.2 Web changes that make two-stage the only path

1. **`detect/twostage.ts`** (new): the cadence currently inlined in
   `autoscan-main.ts` becomes one function
   `nextRoi(tracks, localizer, frameW, frameH) -> { roi, source: 'tracks' |
   'localizer' | 'fallback', box? }` used by both `autoscan-main.ts` and
   `detect-main.ts`. `bbox.html` stays the stage-1 page.
2. **Fallback = centre square crop** (480x480 of a 480x640 frame), not the
   full frame: it is in-distribution for the loose-crop samples, uses 75% of
   the frame where the user holds the cube, and a square input letterboxes a
   full portrait frame with 25% bars for nothing.
3. **`cropTrained` gate stays** as the guard against deploying a non-crop
   model; with the square export it is always true. `detect.html` gets a
   toggle (2-stage / full-frame) for debugging stage 2 alone.
4. **Floor as a fraction in source px** (§3): `cubeTooSmall` compares the
   localizer box's long side to `MIN_FACE_EDGE_FRAC * videoHeight`;
   `identify.ts` measures source quads.
5. **Debug overlay**: draw the ROI rectangle, its source (colour-coded), and
   the raw stage-1 box + objectness on both pages; the heat map already
   drawn maps through `cellToSource`, which is ROI-aware.
6. **Stage-1 cadence while tracking**: today stage 1 runs only at
   acquisition. Keep that, plus re-run it every ~30 frames while tracking
   and prefer its box if the tracker hull and the box disagree by more than
   the padding (a tracker that has drifted onto the background keeps
   feeding stage 2 the wrong crop otherwise). Tunable; default on.
7. **Tests**: a fixture frame + hand-labelled corners through
   `detect(source, roi)` proving ROI corners map back within 1 px of the
   full-frame path (geometry only, runs without a model via a stub session);
   `facekp-maps-square.json` decode fixture from the new model;
   `identify.test.ts` sizes re-checked against the fraction.

## 5. Order of operations

Dependency: `SynthBBox` is built from the facekp *frame* cache, so cubebox
is the test of the frame cache; the crop cache is new code and is tested by
stage 2. The interim step needs neither.

0. **`train/shapes.py`**: `BOX_WH = (120, 160)`, `KP_WH = (256, 256)`,
   `FRAME_CACHE_WH = (240, 320)`, `CROP_CACHE_WH = (320, 320)`,
   `MIN_FACE_EDGE_FRAC`. Every script that carries `INPUT_WH = (320, 240)`
   imports it (list in §7); eval/export read `ckpt["input_wh"]` (both
   trainers already write it; fallback `(320, 240)`) so old checkpoints
   still export and evaluate at their own shape.
1. **Interim two-stage** (§4.1): `diagnose.py --crop`, measure `v4ft1`,
   flip the flag if it holds. ~1 hour, no training.
2. **Cubebox portrait**: frame cache with the sliding crop, `_bars`,
   `NegDir` crop, grid by probe; `train_bbox.py --out runs/box9p` (~18 min
   + one-time cache build). Measure (§6), deploy alone: `cubebox.ts` reads
   the shape from the sidecar and returns source px.
3. **Stage 2 square**: crop cache; `train.py --view crop` fine-tune from
   `v4base` (30 ep, lr 1e-4) then the real recipe (15 ep, lr 5e-5,
   `../data_real*150`, `--select real`); ~25 min. **One from-scratch
   150-epoch run as the reference** (~45 min) to rule out carried-over
   full-frame habits; deploy what `--select real` prefers. Export with
   `--crop-trained`.
4. **Web** (§4.2), `npm test`, phone via `/autoscan.html`: fps (65.5k +
   19.2k px vs 76.8k today: expect equal or better; the EP bench cache key
   includes the shape so it re-benchmarks once), a real scan.
5. **Portrait tranche** only if step 2 shows a gap (§2.3).
6. **Docs**: README "Scanning range" and "Stage-1", `MILESTONES` M6/M8
   notes, `scene.mjs` comment, delete `cache_320x240/` when nothing
   compares against the landscape models any more.

## 6. Measurement

Before/after = deployed `v4ft1`/`box6` vs each step. Size bins as fractions
of frame height so they compare across shapes: far 0.133-0.188, mid
0.188-0.25, near > 0.25.

| what | script | before |
|---|---|---|
| stage 2 on crops vs full frame, `data_real_val` (`real_px`, F1, per batch, far bin) | `diagnose.py --crop` | full-frame v4ft1: 3.31 mean / 3.03 median, 4 missed of 73 |
| stage 2 on crops with jittered boxes (localizer error) | same, `--crop-jitter` | |
| stage 2 close-up corner error in **source px** (the 256-vs-288 tripwire) | same | |
| stage 2 synthetic `val_px` on the crop cache | `train.py` | v4base 2.58 on the frame cache (not comparable; record both) |
| cubebox `real_iou`, in-range <0.7, per-edge sd, size bins | `train_bbox.py` log, `bbox_measure.py`, `bbox_rows.py` | 0.846, 3.4%; bins 0-30: 0.496, 30-45: 0.797, 45-60: 0.846 (box3) |
| cubebox desktop cost: landscape val letterboxed (`view="frame", crop=False`) | `bbox_measure.py` | |
| end-to-end on the phone: faces per frame, lock time, fps, both EPs | `/autoscan.html` status + scan report | 60 fps wasm |
| batch7 (279 frames, 720x1280) once labelled, and the phone clips re-scored | `score_frames.py` after step 0 | 25% below floor, 50% at 32-45 px |

**About the phone clips.** They came out of `extract_frames.py`, which
resizes video to long side 1280 - so they are 720x1280 16:9 video frames
like batch7, not 480x640 app frames. A 16:9 frame letterboxes into 160x120
at scale 0.094 (content 67.5 px wide, 58% wasted) against the app's 0.1875
(90 px, 44% wasted). If the phone's 16:9 video is the usual vertical crop of
the 4:3 sensor (same horizontal FOV), a cube at a given distance is the same
fraction of the frame *width* in both, and the clip figures understate what
the app sees by 90/67.5 = 1.33x: a cube scored at 32 px in the clips is 43
px in today's app and 57 px with portrait stage 1. Two-photo validation,
if wanted: hold the cube still, save one app debug frame and one video
frame, compare cube width / frame width. Not blocking - stage 1 gets
measured on app frames directly via `bbox.html`, and stage 2 no longer
cares.

**About resolution.** The crop makes stage 2 scale-normalized: the cube is
~135 px in a 256 input at every distance, so model input resolution stops
being the far-cube lever. The remaining lever is *capture* resolution: at
the floor a 480x640 frame has ~215 px of padded crop (256 upscales 1.2x); at
720x1280 it would have ~323 px (downsampled) and colour sampling would get
2.25x the pixels per sticker. Cost is on the frame read for colour
(`getImageData` 3.7 MB vs 1.2 MB per sampled frame), not on the models. Not
proposed now: measure stage 2 at 256 first, then try `camera.ts` at 720p as
a separate one-line experiment with an fps number attached.

## 7. Compatibility: every hardcoded 320/240 or 160/120

Grep of both trees, comments excluded.

**`web/`:** nothing hardcodes the shapes (`facekp.ts`, `cubebox.ts` read
`input.shape`; `autoscan-main.ts` derives its scale from the detector).
Changes are the floor (§3), `identify.test.ts` (builds a 320x240 frame and
sizes faces against the floor), the decode fixture (parameterised by its own
`inputWh`, so the old one keeps passing; add the square one), `facekp.ts`
header comment `(B,9,15,20)`.

**`model/`, all covered by step 0:** `train.py:29`, `diagnose.py:39`,
`dump_failures.py:36`, `predict.py:31`, `viz_nms.py:33,179`,
`dump_decode_fixture.py:8,30`, `bench_local.py:20,35`,
`bench_compile.py:49,58`, `check_fast_path.py:29`, `check_gpu_augment.py:25`,
`check_targets.py:27`, `dataset.py:159` (default), `model.py:35,93,169,196,
257,363` (defaults), `bbox_data.py:57,165`, `train_bbox.py:43`
(`GRID_W, GRID_H = 10, 8` -> probe), `export/export_onnx.py:47`,
`bbox_eval/score_frames.py:13-14`, `bbox_eval/bbox_vs_faces.py:21,23,73`,
`bbox_eval/roboflow_audit.py:16,18`. `export_bbox.py`, `bbox_measure.py`,
`bbox_rows.py`, `aspect_test.py` already take the shape from `BOX_WH` or
the sidecar. Old checkpoints: `input_wh` is in every one; export reads it.

## 8. Settled and still open

Settled (user, 2026-09-12): range stays at arm's reach; two-stage is the
only path; phone-clip aspect is answered by `extract_frames.py` (§6).

Open, in the order they block work:

1. **Stage 2 square at 256** (proposed) vs 288, vs keeping it portrait as
   the brief asked. The silhouette data says square; 256 vs 288 has a
   tripwire (§1).
2. **Interim flip of `cropTrained` on `v4ft1`** if the crop measurement
   holds (§4.1): ship two-stage with the landscape models this week, or wait
   for the square model?
3. **Fallback when stage 1 misses**: centre square crop (proposed) vs full
   frame with bars.
4. **Crop-cache disk**: two caches (12.4 + 16.6 GB) alongside today's
   12.4 GB until the landscape one is deleted. OK?
5. **Fine-tune from `v4base` plus one scratch reference** (~70 min total),
   or fine-tune only?
