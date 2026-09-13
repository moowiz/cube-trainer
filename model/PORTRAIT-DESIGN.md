# Design: portrait model input (answers `PORTRAIT-BRIEF.md`)

Status: DESIGN, no code changed. Everything below was read from the tree on
2026-09-12 and measured with two throwaway scripts over the label files; the
numbers are reproducible from `data_v4` (6000-file sample, seed 0),
`data_real`, `data_real_val` and `web/test/fixtures`.

## 0. The one-paragraph version

Ship both nets portrait-only: `facekp` at **240x320**, `cubebox` at
**120x160**. Do not letterbox the existing landscape renders into it; **crop
them to 3:4 at cache-build time** with a deterministic window that slides to
contain the cube, which reproduces the phone's geometry exactly (a 360x480
crop into 240x320 is scale 0.667, a 480x640 phone frame is scale 0.5: both
put the frame height on 320 px). The scanning floor is a *fraction of frame
height*, not a pixel count, so it does not move: `MIN_FACE_EDGE_PX` becomes
32 x 4/3 = **42.7 px**, the generator's `fill` stays 0.27, and the arm's-
reach face goes from 36.8 to 49.1 px because every calibration photo is
portrait. The gain is not more range; it is **1.78x the pixels on every face
at a given distance** (2.0 -> 2.67 stride-16 cells at the floor). Cubebox
goes first because its dataset is built from the facekp cache anyway, so the
18-minute cubebox run is also the test of the new cache. Facekp is a
fine-tune from `v4base`, with one from-scratch run as the reference.

## 1. Input shape: portrait 240x320 / 120x160

Letterbox scale = min(iw/w, ih/h); "wasted" = padded fraction of the input.

| model input | phone 480x640 | desktop webcam 640x480 | batch7 video 720x1280 | pixels |
|---|---|---|---|---|
| 320x240 (today) | 0.375, 70 px side bars, 44% wasted | **0.5**, no bars | 0.1875, 92 px side bars, 58% wasted | 76.8k |
| **240x320** | **0.5**, no bars | 0.375, 70 px top/bottom bars, 44% wasted | 0.25, 30 px side bars, 25% wasted | 76.8k |
| 288x288 | 0.45, 36 px side bars, 25% wasted | 0.45, 36 px top/bottom bars, 25% wasted | 0.225, 63 px side bars, 56% wasted | 82.9k |

- **Phone (the product):** portrait gives 1.333x linear, 1.78x area on every
  face. Square gives 1.2x linear for 8% more compute and still wastes a
  quarter of the input on the phone. Square is a compromise that is
  second-best on the only device that matters.
- **Desktop (dev only):** portrait costs 0.75x linear, i.e. a webcam cube is
  the size it would be on a phone held 33% further away. Desktop cubes are
  held close to a laptop (the 10 landscape real photos have a median face
  edge of 143 px at today's scale, minimum 129; those become 107 and 97 px,
  2.3x the new floor), so the debug pages keep working. Measured in §6
  before it is accepted.
- **Two exports, picked at runtime:** technically free at export time (both
  nets are fully convolutional and a checkpoint can be traced at any static
  shape), but a model trained only on portrait tensors has never seen a
  20-wide grid, and training on both orientations means two caches and
  per-orientation batches (tensor shapes can't be mixed in a batch). Not
  worth it for a dev-only path. It stays as the documented escape hatch if
  §6 shows desktop degradation that gets in the way of development.

**DECISION (proposed): portrait-only.** Matches the brief's prior.

Cubebox at 120x160 is the exact half, so `reduce_to_box_input`'s 2x2
`avg_pool2d` from the facekp cache keeps working unchanged. Its stride-16
grid becomes 8 wide x 10 tall (7.5 -> 8 by padding, as 120 -> 8 does today).

## 2. Training data: crop, don't letterbox; render a tranche second

Measured on 6000 `data_v4` labels (all 640x480):

| | value |
|---|---|
| faces with longest edge < 32 px at 320x240 (today's ignore band) | 0.2% |
| same faces letterboxed into 240x320 (scale 0.375): edge < 42.7 px | **24.8%** |
| median face edge, letterboxed into 240x320 | 58 px (vs 78 today) |
| frames whose cube hull crosses a *centred* 3:4 window | 26.1% |
| frames whose hull is wider than any 3:4 window (> 360 of 640 px) | 16.2% |
| hull centre x / width, p5..p95 | 0.40 .. 0.60 |

**(a) Letterbox the landscape 54k into the portrait input:** the renders
shrink to scale 0.375 while the phone runs at 0.5, so a quarter of the
synthetic faces fall into the new ignore band and a phone cube at any
distance looks 1.33x larger than every synthetic cube at that distance. As
the *only* path this trains the wrong scale distribution. Rejected as the
main path; kept as a low-probability augmentation (§2.3) so desktop frames
are not out of distribution.

**(b) Crop to 3:4:** a 360x480 window into 240x320 is scale 0.667, which is
the phone geometry exactly (frame height -> 320 px in both). A *centred*
window cuts the cube in 26% of frames, but `augment._portrait_sim` already
solves this: slide the window to contain the hull. After sliding, only the
16% whose hull is wider than 360 px get cut, and those are the close-up
regime (hull > 56% of the frame width), where a partially out-of-frame face
is exactly what the phone does to a close cube. The generator already
defines the semantics: `visible` is "facing > 0.15 and centre within 8 px of
the frame", and `augment._center_in_frame` zeroes conf on a face whose
centre leaves a crop. Real photos are 3:4 already and fill the input with
no crop.

**(c) Render a portrait tranche:** `generate.mjs --width 480 --height 640`
works today; `fill` is defined against the vertical FOV so the size
distribution is unchanged, and `inFrame` uses the render's own width/height
so labels are right. Locally the generator does 7-9 img/s, so 10k portrait
frames is ~25 minutes on this machine, not a cloud job. It adds what a crop
cannot: hands/forearms/clutter/background composed for a tall frame instead
of sliced off the sides.

**DECISION (proposed): (c) staged.** Crop path first (no rendering, uses all
54k, testable this afternoon); render a 10-20k portrait tranche only if the
crop-trained model leaves a measurable gap on real data (§6). Letterbox
survives only as `_landscape_sim` augmentation.

### 2.1 Where the crop lives: `dataset._build_cache`

When the source aspect is wider than the target aspect (640x480 into
240x320; never for 3:4 photos, never for today's 320x240 cache):

1. window = full height, width = h x iw/ih (360 for a 480-tall render);
2. centre it on the hull of visible+valid faces, clamp to the frame; if the
   hull is wider than the window, centre on the hull and let both sides cut;
3. add a deterministic jitter of up to ±10% of the window width, seeded by
   the file index (variety without breaking cache determinism), still
   clamped so the hull stays inside whenever it can;
4. letterbox the window as today (it now fits exactly: no bars);
5. faces whose centre left the window: `conf = 0`, corners kept (the loss
   only uses corners where conf > 0). Same rule as `_center_in_frame`.

Cache dir is already shape-keyed (`cache_240x320/`), so the landscape cache
is untouched and the 320x240 build path is byte-identical (no crop is ever
applied when aspects match). Record `"crop": "slide-3:4"` in `meta.json`
anyway. Disk: 54k x 230 KB = 12.4 GB, the same as today's cache; both
coexist at ~25 GB until the landscape one is deleted.

A `crop=False` constructor flag builds `cache_240x320_lb/` (letterbox with
top/bottom bars) for the desktop measurement in §6 only.

### 2.2 `bbox_data`

`SynthBBox` wraps `CubeKeypointDataset(input_size=(320,240))` and pools by
2. It inherits the crop for free once it asks for `INPUT_WH`. Changes:

- `BOX_WH = (INPUT_WH[0] // 2, INPUT_WH[1] // 2)`, and `GRID_W, GRID_H`
  derived from a probe of `_blocks` (as `FaceKPCenter` does) instead of the
  literals `10, 8`.
- `_pillarbox` -> `_bars(x, box, target_aspect)`: same code, generalised to
  crop a window of the *other* orientation and pad on the axis that needs
  it. With a portrait input the phone case has no bars, so the augmentation
  now simulates the **desktop** case (4:3 window, top/bottom bars) at
  p ≈ 0.15, down from 0.45.
- `_has_bars` checks row 0 as well as column 0.
- `NegDir` (COCO negatives): COCO photos are mostly landscape and will
  letterbox with top/bottom bars, which is the desktop geometry, not the
  phone's. Add a random 3:4 crop at p ≈ 0.6 so negatives look like empty
  phone frames.

### 2.3 `augment.py`

`_portrait_sim` (crop a narrow window, side bars) is replaced by
`_landscape_sim`: crop a 4:3 window at full width, scale it to fit the
input's width, top/bottom bars, p ≈ 0.15. This is the mirror image of today
and covers the desktop webcam. `_zoom_crop` (stage-2 crop training) reads
`img.size` and is shape-agnostic. Photometric/GPU augmentation is
shape-agnostic.

## 3. The floor: same range, expressed as a fraction of frame height

The scanning-range DECISION is physical ("as far as a person can hold a
cube"), and the commit that set it (`04b5822`) records both forms: 36.8 px
at 320x240 *and* bounding sphere 0.266 of the frame height. The second form
is orientation-free and is the one to keep.

Was the calibration photo portrait? The commit does not name it, but every
candidate is: `data_real` is 104 x 3000x4000, 44 x 480x640, 9 x 640x480, and
the smallest-cube frames in both real sets are all 3000x4000 (the faces
nearest 36.8 px: `img_real000017` at 37.3 px, `img_real000128` at 38.3). For a
portrait photo the letterbox is height-limited in both inputs, so frame
height maps to 240 px today and 320 px after, and the 4/3 factor is exact,
not a guess. (Had the photo been landscape 4:3 the factor would have been
0.75, which is why the brief was right to ask.)

| quantity | today (320x240) | after (240x320) | as a frame fraction |
|---|---|---|---|
| arm's-reach longest face edge | 36.8 px | 49.1 px | 0.153 of frame height |
| `MIN_FACE_EDGE_PX` (targets.py, color.ts) | 32 | **42.7** (use 43 in web) | 0.133 |
| floor in stride-16 cells | 2.0 | **2.67** | |
| pixels per face at the floor | 1024 | 1820 (1.78x) | |
| generator far-regime `fill` | 0.27 | **0.27, unchanged** | fill is bounding-sphere radius / half frame height |
| face edge per unit fill | 138.5 x fill | 184.7 x fill | |
| gap between fill floor (0.27 -> 49.9 px) and ignore floor | 18% | 17% | preserved |
| cubebox "in range" (silhouette long side) | 32 px at 160x120 | 42.7 px at 120x160 | |

So: `targets.py` gets `MIN_FACE_EDGE_FRAC = 32 / 240` and derives
`MIN_FACE_EDGE_PX = MIN_FACE_EDGE_FRAC * INPUT_WH[1]`; `scene.mjs` changes
only its comment; the web floor moves to 43 and is cross-checked against the
sidecar (§5). The `dataset_target_stats` collision warning (">2% centre-cell
collisions -> stride 8") should drop, not rise: face centres are 1.33x
further apart in cells.

What the phone-clip figures in the brief become: "25% of frames below the
floor" does **not** become 0% — a cube below 0.133 of the frame height is
still further than arm's reach, wherever the input's pixels are. What
changes is that a cube *at* the floor is now 2.67 cells instead of 2.0, and
the 30-45 px bin (the localizer's worst) becomes 40-60 px, which today's
size-bin table says is the difference between IoU 0.797 and 0.846. The gain
is accuracy at every distance, not distance. If the intent is also to extend
the range, that is a separate decision and would mean lowering the fraction;
it is not proposed here (open question 4). Also worth confirming: whether the
1000 scored frames were 480x640 app frames or 720x1280 video (batch7 is the
latter, which today wastes 58% of the input, so the brief's 44% figure would
understate the clips and overstate what the app sees).

## 4. Order of operations and the training recipe

Dependency that decides the order: `SynthBBox` is built **from the facekp
cache**. There is no cubebox-only path that avoids building `cache_240x320/`,
so the cubebox step is the cheapest end-to-end test of the crop policy, the
cache, the augmentation flip and the export/sidecar/web chain.

**Step 0 — one source of truth for the shape.** `train/shapes.py` with
`INPUT_WH = (240, 320)`, `BOX_WH`, `MIN_FACE_EDGE_FRAC`. Every script that
carries its own `INPUT_WH = (320, 240)` imports it (train, diagnose,
dump_failures, viz_nms, predict, dump_decode_fixture, bench_local,
bench_compile, check_fast_path, check_gpu_augment, check_targets;
bbox_eval/score_frames, bbox_vs_faces, roboflow_audit). Eval/export scripts
take the shape **from the checkpoint** (`ckpt["input_wh"]`, which both
`train.py` and `train_bbox.py` already write) with a `(320, 240)` fallback,
so every old checkpoint still exports and evaluates at its own shape.

**Step 1 — cubebox.** `train_bbox.py --out runs/box9p` (50 epochs, ~18 min,
plus a one-time cache build of a few minutes). Compare with box6 on
`data_real_val` via `bbox_rows.py` (§6). Deploy on its own if it is at least
as good: `cubebox.ts` reads the shape from the sidecar and returns a box in
source px, so stage 1 can go portrait while stage 2 is still landscape.

**Step 2 — facekp fine-tune from `v4base`.** The backbone's features do not
care about the grid's aspect and the cube-size range it must cover (49 px to
full frame) is inside what it trained on; what is new is the scale
*distribution*, and 30 epochs at lr 1e-4 on the portrait cache is the
cheapest way to move it. Then the proven real recipe: 15 epochs, lr 5e-5,
`--data ../data_v4,../data_real*150 --init <that> --select real`. Total
~25 min. **One from-scratch 150-epoch run (~45 min) as the reference**, to
answer "did the fine-tune carry landscape habits" once; deploy whichever
`--select real` prefers. Fine-tune first because it gives the signal in a
quarter of the time and the pipeline (cache, aug, export, web) is the part
most likely to be wrong.

**Step 3 — export, deploy, phone.** `export_onnx.py` reads `input_wh` from
the checkpoint, writes `input.shape [1,3,320,240]` and `output.shape
[1,9,20,15]`. The web `FaceDetector` already sizes its canvas from the
sidecar, the EP benchmark cache key includes the shape (so it re-benchmarks
once), the heat overlay uses `tensor.dims`. Nothing in `web/src` hardcodes
the numbers (grep: the only hits are unrelated constants). Re-verify fps on
the phone via `/autoscan.html`.

**Step 4 (conditional) — portrait tranche.** If step 2's real numbers show
a gap the crop cannot close, `generate.mjs --width 480 --height 640 --count
10000 --out ../data_v4p` locally, add it as a second `--data` root, repeat
step 2. Not scheduled until measured.

## 5. Compatibility: what hardcodes 320/240 or 160/120

Grep of both trees, comments excluded.

**`web/` — nothing to change for the shape.** `facekp.ts`, `cubebox.ts` take
`input.shape` from the sidecar; `autoscan-main.ts` derives the scale from
`detector.iw/ih`; tracker, rectify, colour work in source px. Only:
- `color.ts MIN_FACE_EDGE_PX = 32` -> 43. It is compared at **model-input
  scale** in both callers (`identify.ts` measures the letterboxed quads;
  `autoscan-main.ts` multiplies the box by the letterbox scale), so it must
  follow the model. Proposed: the sidecar carries `minFaceEdgePx`,
  `FaceDetector` exposes it, both callers read it from the detector, and the
  constant in `color.ts` stays as the no-model default with a test that it
  equals the deployed `facekp.json`. `facePlan`'s use of the same constant
  is a colour-sampling rule and out of scope; it just inherits the value.
- `web/test/identify.test.ts` builds a synthetic 320x240 frame; its faces
  are sized against the floor, so re-check sizes when the floor moves.
- `web/test/fixtures/facekp-maps.json` carries `inputWh` and `shape`; the
  decode test is parameterised by the fixture, so it keeps passing against
  the old dump. Add `facekp-maps-portrait.json` from the new model
  (`dump_decode_fixture.py`, after step 0). `rectify-real.test.ts` works in
  frame px on PNGs: unaffected.
- `facekp.ts` header comment `(B,9,15,20)` -> `(B,9,20,15)`.

**`model/` — every occurrence, all covered by step 0:**
`train.py:29`, `diagnose.py:39`, `dump_failures.py:36`, `predict.py:31`,
`viz_nms.py:33,179`, `dump_decode_fixture.py:8,30`, `bench_local.py:20,35`,
`bench_compile.py:49,58`, `check_fast_path.py:29`, `check_gpu_augment.py:25`,
`check_targets.py:27`, `dataset.py:159` (default arg), `model.py:35,93,169,
196,257,363` (defaults, harmless but should follow `shapes.py`),
`bbox_data.py:57,165`, `train_bbox.py:43` (`GRID_W, GRID_H = 10, 8`),
`export/export_onnx.py:47`, `bbox_eval/score_frames.py:13-14`,
`bbox_eval/bbox_vs_faces.py:21,23,73`, `bbox_eval/roboflow_audit.py:16,18`.
`export_bbox.py`, `bbox_measure.py`, `bbox_rows.py`, `aspect_test.py`
already take the shape from `BOX_WH` or the sidecar.

**Old checkpoints:** `input_wh` is in every checkpoint written by the current
`train.py` and `train_bbox.py`. With export reading it (fallback 320x240),
`v4ft1` and `box6` still export exactly as they do today.

**Generator:** no change beyond the `scene.mjs` comment; `--width/--height`
already exist; `Makefile` gains a `data-v4p` target when step 4 happens.

## 6. Measurement

All before/after pairs are `v4ft1`/`box6` (deployed, landscape) vs the new
portrait runs. Size bins are defined **as fractions of frame height** so
they compare across shapes: far = 0.133-0.188 (32-45 px today, 42.7-60
after), mid = 0.188-0.25, near = > 0.25.

| what | script | before | after |
|---|---|---|---|
| facekp `real_px`, F1, per batch, on `data_real_val` | `train.py` log / `diagnose.py` | 3.31 px mean / 3.03 median, 4 missed of 73 | |
| facekp far-bin `real_px` and misses | `diagnose.py` with the bin | | |
| facekp synthetic `val_px` on the portrait cache | `train.py` | (v4base 2.58 on landscape cache) | |
| **desktop cost**: portrait model on `cache_240x320_lb` (landscape val letterboxed) vs `v4ft1` on `cache_320x240` | `diagnose.py --letterbox` | | |
| desktop sanity: detections on the 10 landscape `cube-frame-*` fixtures (unlabelled; count + agreement with v4ft1) | small script | | |
| cubebox `real_iou`, in-range < 0.7 rate, per-edge sd | `train_bbox.py` log, `bbox_measure.py` | 0.846, 3.4% | |
| cubebox size bins on `data_real_val` | `bbox_rows.py` | 0-30: 0.496, 30-45: 0.797, 45-60: 0.846 (box3) | |
| phone clips: obj / faces / size per frame, far-bin share | `score_frames.py` (after step 0) | 25% below floor, 50% at 32-45 | |
| batch7 (279 frames, 720x1280), once labelled | `diagnose.py --data` | | |
| phone fps, both EPs | `/autoscan.html` status line | 60 fps wasm (M4) | expect the same: 76.8k px either way |

Caveat on `data_real_val`: only 3.9% of its faces are in the far bin at
portrait scale (3 faces). The far bin is what this change is for, and the
val set can barely see it; the phone clips and a labelled batch7 are the
measurement that counts, and batch7's 16:9 frames still get 30 px side bars
at 3:4 (that is the video's aspect, not the app's).

## 7. Files touched (implementation plan, in order)

1. `model/train/shapes.py` (new): `INPUT_WH`, `BOX_WH`, `MIN_FACE_EDGE_FRAC`.
2. `model/train/dataset.py`: slide-crop in `_build_cache` when source aspect
   > target aspect; `crop` flag and `_lb` cache suffix; `meta.json` records
   the policy. `CACHE_VERSION` unchanged (the 320x240 path is byte-identical).
3. `model/train/targets.py`: `MIN_FACE_EDGE_PX` derived from the fraction.
4. `model/train/augment.py`: `_portrait_sim` -> `_landscape_sim`, p 0.15.
5. `model/train/bbox_data.py`: `BOX_WH` from `shapes`, `_bars` generalised,
   `_has_bars` both axes, `NegDir` 3:4 crop. `train_bbox.py`: grid by probe.
6. `model/export/export_onnx.py`, `export_bbox.py`: shape from the
   checkpoint, `minFaceEdgePx` in the facekp sidecar.
7. Every script in §5 imports `shapes` / reads the checkpoint.
8. Run cubebox (step 1), measure, deploy.
9. Run facekp fine-tune + scratch reference (step 2), measure, export.
10. `web/src/color.ts` 43 + sidecar plumbing; `identify.test.ts` sizes;
    new decode fixture; `facekp.ts` comment. `npm test`.
11. Phone: fps and a real scan via `/autoscan.html`.
12. `model/README.md` "Scanning range" and "Stage-1" sections, `MILESTONES`
    note, `gen/scene.mjs` comment. Delete `cache_320x240/` dirs when the
    landscape models are no longer being compared against.

## 8. Open questions (settle before coding)

1. **Portrait-only confirmed?** Desktop pays 0.75x linear; measured in §6
   before accepting; dual export stays the escape hatch. Recommend yes.
2. **Crop policy for the 16% of renders wider than the window:** cut the
   sides (proposed: it is the close-up regime and mirrors the phone) vs
   letterbox just those frames with top/bottom bars (keeps every corner, at
   desktop scale). Recommend cut.
3. **Portrait tranche now or after measuring the crop model?** Recommend
   after; it is ~25 min local either way.
4. **Floor semantics:** same physical range, floor 42.7 px (proposed), or
   is extending the range beyond arm's reach also wanted? Recommend no; if
   yes, it is a change to `MIN_FACE_EDGE_FRAC`, not a side effect.
5. **Were the 1000 scored phone frames 480x640 or 720x1280?** Changes how
   the 25%/50% figures transfer to the app.
6. **Web floor from the sidecar (proposed) or just bump the constant?**
7. **Fine-tune from `v4base` plus one scratch reference run** (~70 min
   total), or fine-tune only?
