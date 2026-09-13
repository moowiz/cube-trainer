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
..\.venv\Scripts\python train.py --head center --data ../data --overfit 50 --epochs 600 --batch 16 --lr 1e-3
    # pipeline correctness check. Center head verified 2026-09-12: 0.50 px
    # (the legacy head reached 2.07 px on the same check).
..\.venv\Scripts\python train.py --head center --data ../data --epochs 30 --out runs/base
cd ..\export
..\.venv\Scripts\python export_onnx.py --ckpt ../train/runs/base/best.pt
    # -> web/public/models/facekp.onnx + facekp.json (pre/post-processing metadata)
```

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

## Training performance

Measured on the first 20k run (RTX 4070 SUPER): ~116 s/epoch at ~164 img/s,
GPU 3D utilization ~7% in a sawtooth — the run is **dataloader-bound**, not
GPU-bound. The tax is decoding full 640x480 PNGs per epoch only to resize
them to 320x240.

Fix, in order of payoff:

1. **Pre-decoded cache** — DONE: `dataset.py` lazily builds
   `data/cache_320x240/` (memory-mapped uint8 images + label tensors,
   rebuilt when the label count changes) and reads samples from it;
   augmentation runs on the cached input-size images.
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
