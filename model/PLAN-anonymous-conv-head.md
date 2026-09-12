# Plan: anonymous-quad convolutional head for the face detector

Status: approved by the user 2026-09-12, not started. Hand this file to the
implementing agent. Read `CLAUDE.md`, `MILESTONES.md`, and `model/README.md`
first; everything below assumes that context.

## 0. Why (one paragraph)

The current detector is MobileNetV3-Small (0.93M params, fine) followed by a
flatten + fully-connected regression head that is 5.27M of the model's 6.27M
params (`model/train/model.py`, `nn.Linear(128*8*10, 512)`). That head is
position-specific (every feature cell has private weights, so position and
scale generalization must be learned from data), it is the layer that makes
int8 quantization fail (README "Quantization finding"), it is ~24 MB of the
25 MB download, and its six named output slots (U R F D L B) force the loss
to commit to a face identity, which on symmetric corner-on views averages
competing hypotheses into diamond/hedge quads (README, MILESTONES M4 status,
session notes on "identity-slot multimodal averaging"). The generator renders
every cube in the fixed standard scheme, so "identity" is really center
color, which the web pipeline can read directly (pipeline step 7 already
identifies faces from centers).

Decision: replace the head with a fully convolutional, anonymous-quad head
in the style of CenterNet ("Objects as Points", Zhou et al. 2019,
arXiv 1904.07850). Faces are detected as peaks in a face-center heatmap;
the four corners are regressed as offsets from the peak cell. No face
names in the model. The web app names each quad from its center color.

Two independent halves. The model half ships a new checkpoint and ONNX;
the web half teaches the app to read it. Do the model half first; the web
half is gated on a checkpoint that beats the current numbers.

## 1. Model half (`model/`)

### 1.1 Architecture (`train/model.py`)

Add a class `FaceKPCenter`. Keep `FaceKP` untouched so old checkpoints
still load, export, and diagnose.

Backbone: `mobilenet_v3_small(weights=DEFAULT).features`, split at index 9.
Measured shapes for a 240x320 input:

| tap | layers | shape (C,H,W) | stride |
|---|---|---|---|
| s16 | `features[:9]` | (48, 15, 20) | 16 |
| s32 | `features[9:]` | (576, 8, 10) | 32 |

Neck (produces a stride-16 map with global context):

```
s32 -> Conv1x1(576->96) + BN + Hardswish -> F.interpolate(size=(15,20), bilinear, align_corners=False)
cat([s16 (48ch), up (96ch)]) -> 144ch
-> Conv3x3(144->96, pad 1) + BN + Hardswish
-> Conv3x3(96->96,  pad 1) + BN + Hardswish
```

Head: `Conv1x1(96 -> 9)`. Output tensor `(B, 9, 15, 20)`:

- channel 0: face-center heatmap **logit** (sigmoid at decode, like today)
- channels 1..8: corner offsets `x0,y0,x1,y1,x2,y2,x3,y3` in **cell units**
  (1 cell = 16 input px), relative to the center of the cell they sit in.
  Linear output, unbounded (corners outside the frame are legal).

Initialize the heatmap bias to `-2.19` (prior prob 0.1, CenterNet's trick)
so early training is not dominated by the negatives.

Param budget for the whole neck+head: about 0.25M. Total model about 1.2M.
Record the measured count in README when done.

Add `--head {legacy,center}` to `train.py` (default `center`), store
`"head"` in every checkpoint dict, and make `predict.py`, `diagnose.py`,
`export_onnx.py` build the right class from that key (fallback `legacy`
when the key is absent).

### 1.2 Targets (`train/dataset.py` or a new `targets.py`)

Labels stay exactly as they are on disk and in the cache (`conf (6,)`,
`corners (6,4,2)` normalized, `valid (6,)`). Build the dense targets on
the fly per batch on the GPU (cheap: 15x20 grid) from those tensors, so the
cache format and `--data` handling do not change. Per sample:

- A face is a positive iff `conf == 1 and valid == 1`. Hidden faces
  (`conf == 0`) contribute nothing: the old `hidden_weight` corner
  supervision goes away. A face with `conf == 1 and valid == 0` (visible
  but unlabeled, which the labeling convention forbids) must not be treated
  as a negative either: count them at dataset build and print the count;
  if it is nonzero, mask the loss in a 3x3 neighbourhood of the
  hand-estimated center. Simplest is to assert zero and fix labels.
- Face center = intersection of the quad's diagonals (not the mean of the
  corners; a projected square's diagonal intersection is the true center).
  Convert to grid coordinates `(cx/16, cy/16)` at input scale.
- Heatmap target: CenterNet Gaussian splat at the center with
  `sigma = clamp(0.25 * sqrt(face_area_in_cells), 0.8, 3.0)`, max-merged
  across faces.
- Offset targets are supervised at every cell whose Gaussian value is
  `>= 0.5`; at cell `(i, j)` the target for corner `k` is
  `corner_k_in_cells - (j + 0.5, i + 0.5)`. Store as `(B, 8, 15, 20)` plus a
  weight map `(B, 15, 20)` equal to the Gaussian value there, and a
  per-cell "which face" index so the loss can take the rotation-invariant
  minimum over the 4 cyclic shifts of that face's quad, exactly as
  `keypoint_loss` does today (cyclic shifts only, no reflections).
- Two faces whose centers share a cell: keep the larger-area face at that
  cell. Print how often this happens on `../data` val (expect well under
  1%); if it is higher than 2%, raise the grid to stride 8 before doing
  anything else.

### 1.3 Loss (`train/model.py`)

```
heat_loss  = CenterNet penalty-reduced focal loss (alpha=2, beta=4), summed and divided by the number of positive faces in the batch (min 1)
off_loss   = SmoothL1(beta=0.3 cells) over supervised cells, min over the 4 cyclic shifts, weighted by the Gaussian value, divided by total weight
loss       = heat_loss + 1.0 * off_loss
```

Return `(loss, heat_loss, off_loss)` so `train.py` can log both. Tune the
`1.0` only if one term is more than 5x the other after epoch 3.

### 1.4 Decode (single source of truth: `train/model.py::decode_maps`)

Input `(B, 9, H, W)` raw maps. Steps:

1. `heat = sigmoid(maps[:, 0])`.
2. NMS: `keep = (heat == max_pool2d(heat, 3, stride 1, pad 1))`.
3. Take the top `K = 6` kept cells per image by score.
4. For each kept cell `(i, j)` with score `>= thresh`:
   `corner_k = ((j + 0.5 + off_xk) * 16 / 320, (i + 0.5 + off_yk) * 16 / 240)`
   in normalized image coordinates, `off` read from channels `1..8` at
   that cell.
5. Return, per image, a list of `{score, quad (4,2) normalized}` sorted by
   score descending.

Default `thresh = 0.3` for evaluation, exposed as an argument. The
TypeScript decoder in the web half must mirror this function line for
line; write it so a fixture test can compare the two (dump one val image's
raw maps and the Python decode to `web/test/fixtures/`).

### 1.5 Metrics (`train/model.py`, keep the log line format)

`train.py` prints `epoch  train_loss  val_loss  val_px  val_conf_acc
real_px` and `watch.py` parses those exact keys. Keep the keys, redefine
the two anonymous-aware ones:

- `val_px` / `real_px`: match decoded quads (score `>= 0.5`) to
  ground-truth visible+valid faces greedily by centroid distance (there are
  at most 3 of each, so greedy is fine), only accepting a match whose
  centroid distance is under 50% of the GT face's mean edge length. Error
  is the rotation-invariant corner error over matched pairs at 320x240, as
  today. Unmatched GT faces count as misses and do not enter the pixel mean
  (they show up in the next metric).
- `val_conf_acc`: F1 of face detection at score 0.5 under the same
  matching. Say so in a comment and in README so nobody compares it with
  old runs' visibility accuracy.

`diagnose.py` and `predict.py` switch to `decode_maps` and drop face names
(draw all quads in one color; annotate score). Keep the per-batch breakdown
on `data_real_val` working; it is the yardstick that decides deploy.

### 1.6 Training runs, in order (each has a pass/fail gate)

1. **Overfit sanity**: `train.py --head center --data ../data --overfit 50
   --epochs 600 --batch 16 --lr 1e-3`. Gate: `val_px` reaches about 2 px
   (legacy head reached 2.07). If it stalls above 4 px, the targets or
   decode are wrong; fix before going on.
2. **Short proxy comparison on existing data** (the only comparison run;
   no parallel legacy run is needed because `runs/long4` IS the legacy
   baseline on this exact data). 20 epochs on `../data` with long4's recipe
   (AdamW, OneCycle, lr 3e-4, batch 64; `train=72147 val=3853` as the
   first log line of `runs/long4-console.log` shows). Note OneCycle over
   20 epochs anneals faster than over 150, which slightly favors the short
   run; use `--epochs 150` and stop it after epoch 20 to keep the schedule
   identical, or accept the small bias. Gate, against long4's curve:

   | epoch | long4 val_px | long4 val_conf_acc |
   |---|---|---|
   | 5 | 20.22 | 0.827 |
   | 10 | 14.40 | 0.915 |
   | 20 | 9.74 | 0.946 |

   Pass if center-head `val_px` at epoch 20 is at or below 10.7 (long4 +
   1 px) and detection F1 is at or above 0.95. Also run `diagnose.py` on
   the epoch-20 checkpoint and confirm the >100 px close-up class has no
   diamond quads. Run this on the cloud box (RUNBOOK sections 1-2; ~80 s
   per epoch locally, so about 30 minutes on a 24-vCPU box, a few dollars)
   or locally overnight if the box is not up; either is fine. `--init` from
   a legacy checkpoint is not possible (different head) and not wanted.
3. **Full run, cloud only**: the planned data_v4 from-scratch run (README
   "DECISION 2026-09-12 — consolidate synthetic data"; `--cornerBias 0.4`;
   `model/cloud/RUNBOOK.md` section 4) with `--head center`. Do NOT run a
   legacy twin; the proxy above plus long4's full curve is the comparison.
   Then fine-tune: `--data <v4>,../data_real*150 --epochs 15 --lr 5e-5
   --select real` (this one runs locally, ~10 min, because it needs the
   private real photos that never go to the cloud).
4. Deploy gate: per-batch `real_px` on `data_real_val` no worse than the
   deployed `ft7` on any batch, and better on the corner-on / close-up
   batches. Never edit `data_real_val`.

Resource rules apply (`CLAUDE.md`: 8 workers, ~56% CPU ceiling, no
detached launches, orphaned worker cleanup, log to
`runs/<name>-console.log`, dashboard on 8123).

### 1.7 Export (`export/export_onnx.py`)

- Build the model from `ckpt["head"]`. Output name `maps`, static shape
  `(1, 9, 15, 20)`. Keep the torch-vs-ORT parity assert on the raw maps.
- Sidecar `facekp.json` gains:

```json
"head": "center-v1",
"output": {
  "name": "maps", "shape": [1, 9, 15, 20], "stride": 16,
  "channels": "0: face-center heatmap logit (sigmoid me); 1..8: corner offsets x0,y0..x3,y3 in cells, relative to the cell center",
  "decode": "3x3 max-pool NMS, top 6, corner = ((j+0.5+offx)*stride/W, (i+0.5+offy)*stride/H); quads are ANONYMOUS - name them by center color",
  "cornerOrder": "cyclic, winding consistent; starting corner arbitrary"
},
"anonymous": true
```

  Keep `cropTrained`, `run`, `checkpoint`, `precision`, `valPx` as today.
- Re-run the static QDQ int8 attempt through the existing measured-shift
  gate. It is expected to pass now (no dense layer). If it passes, ship
  int8 and record the size; if not, ship fp32 as today and do not block on
  it.

## 2. Web half (`web/`)

Blast radius is deliberately small: only `detect/facekp.ts` learns the new
output, and one new module names quads. Tracker, orient, autoscan, voter,
and assembly keep receiving `DetectedFace` with a `FaceId`.

### 2.1 `detect/facekp.ts`

- Read `meta.head`. `undefined`/`"legacy"`: current path, unchanged.
  `"center-v1"`: run the session, then decode `maps` with a TypeScript
  mirror of `decode_maps` (section 1.4). Map corners back through the
  letterbox and ROI exactly as today. Produce `DetectedQuad { conf, corners }`.
- Add `detectQuads(source, roi)` returning anonymous quads. Keep `detect()`
  as the public API: for anonymous models it calls `detectQuads` then
  `nameQuads` (below) and returns `DetectedFace[]`, dropping quads that
  cannot be named. Expose the unnamed quads on the result too
  (`DetectResult.quads`) for the debug overlay.
- Fixture test: load the dumped raw maps from section 1.4 and assert the TS
  decode equals the Python decode to 1e-4.

### 2.2 New `detect/identify.ts`: `nameQuads(frame, quads) -> DetectedFace[]`

Face identity = center sticker color, which is what the model was learning
anyway (fixed-scheme renders).

- For each quad: `warpQuad(frame, quad, 90)`, sample the center cell (the
  existing `sampleGridCells` index 4, or `samplePatch` at 45,45) to Lab.
  Reject if `isGlareSample` or `isFaceTooDark`.
- Assign a `FaceId` by nearest exemplar in the normalized space
  `assembleState` uses (`normalizeFaceCells` / `CLUSTER_L_WEIGHT`), with
  the same duplicate threshold `CENTER_MIN_DIST`. Exemplars: a small
  `CenterExemplars` class that starts from the default scheme
  (`DEFAULT_SCHEME_HEX` converted to Lab via `srgbToLab`) and, once a
  quad is seam-verified and confidently named, replaces that face's
  exemplar with a running median of observed centers. This is exactly item
  2 of `web/src/color-notes.md` ("center stickers are free labeled
  exemplars") and stays consistent with "centers define the scheme": the
  defaults only break ties before any real center has been seen.
- Within one frame, two quads may not receive the same `FaceId`; if two
  compete, keep the one with the smaller distance and drop the other (log
  it in the debug panel). Opposite faces can never be co-visible; if the
  naming produces an opposite pair in one frame, drop the lower-confidence
  one.
- Cross-frame stability comes from the existing `FaceTracker` (keyed by
  `FaceId`, with its centroid gate); a mis-named quad fails the gate and is
  ignored, as a wrong detection is today.

Non-standard color schemes (e.g. white opposite blue) are out of scope; the
default-scheme prior assumes the standard arrangement, the same assumption
the trained model has always made.

### 2.3 Debug view (`CLAUDE.md`: every processing step is visible)

In the detect/autoscan debug panel: draw the 15x20 heatmap as a translucent
overlay, draw raw anonymous quads in grey with their score, and the named
quads in scheme colors as today. Show the current center exemplars as six
swatches.

### 2.4 `web/scripts/check-detect.mjs`

Make it read `meta.head` and count decoded quads for the anonymous model so
the headless benchmark keeps working for both model generations. Report ms
for webgpu and wasm; the new head should be no slower (fewer FLOPs in the
head, a few more in the neck).

### 2.5 Phone check

`/autoscan.html` on the user's phone: overlay sticks to faces, faces are
named correctly on a scrambled cube, corner-on views no longer draw
diamonds, fps at or above the current 60 on wasm. That is the M6/M7
verification the milestones are already waiting on.

## 3. Do not change

- Backbone choice, input size 320x240, optimizer, schedule, augmentation
  (`augment.py` including `_zoom_crop`), the dataset cache format, the
  labeling conventions, `data_real_val`.
- Corner-order convention: cyclic-shift-invariant, winding-consistent, no
  reflections.
- Web contract downstream of `detect()`: `DetectedFace { face, conf,
  corners }` stays so tracker/orient/assembly do not move.

## 4. Record when done

- README: new architecture paragraph, measured params, val/real numbers for
  legacy vs center on the same data, int8 outcome, and the redefinition of
  `val_conf_acc`.
- MILESTONES M4 "known open items": mark the diamond/identity-averaging
  item and the int8 item with their outcomes.
- Commit and push; pushing `main` deploys the new model to Pages.
