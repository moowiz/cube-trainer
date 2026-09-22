> Archived 2026-09-22: the investigation this hands off was done (model/README.md "Stage-1 cube localizer"); `model/PORTRAIT-DESIGN.md` is the current design. Kept for the measurements it quotes.

# Stage-1 cube localizer (`cubebox`) — handoff, 2026-09-12

Written at the end of a session that investigated the report *"the bounding box
seems too small and misses the corners of the cubes."* Everything below is
either measured (numbers quoted) or explicitly flagged as unproven.

Scope: stage 1 only. The stage-2 face-keypoint model was not touched.
Nothing is committed. `git status` will show the changed files in §3.

---

## 1. What is actually wrong

### The "systematic undersize / up-left bias" reading is REFUTED

Against the 37 hand-labelled photos in `model/data_real_val` (ground truth =
axis-aligned hull of every visible face's corners, which for a convex cube is
the silhouette), the model that was deployed at the start of the session
(`box3`) measured:

```
IoU mean 0.790  median 0.888
width / true   median 0.997
height / true  median 0.985
per-edge inset (+ = predicted edge sits inside the truth):
  left -0.008   top -0.006   right +0.012   bottom +0.017
  sd:   0.140        0.191        0.204         0.183
```

The median box is the right size and sits in the right place. There is no
up-left bias and no systematic shrink. **The problem is variance**: the
per-edge standard deviation is 14–20% of the box, so a long tail of frames
clips the cube while the median frame is fine. Mean IoU 0.790 vs median 0.888
is that tail.

### Where the variance comes from — four causes, each measured separately

**(a) The head. This is the primary cause.** `TinyBox` is 5 stride-2 conv
blocks → global average pool → MLP → 5 numbers. GAP discards *where*
everything was, so the MLP has to reconstruct a box from channel means. On
`data_v4` val frames with **no occluder at all** — fully in-distribution,
nothing hard about them — it reaches only **IoU 0.833, with 12.9% of frames
below 0.7**. That is the design's ceiling, not a data problem.

**(b) The Roboflow COCO labels use a different box convention.** Audited with
`scratchpad/roboflow_audit.py`: the stage-2 keypoint model was run on 393
Roboflow images where it finds ≥2 faces, and the hull of its quads (same
silhouette convention as our labels) compared against the COCO box:

```
             n    IoU vs silhouette   w/sil med   h/sil med   frac IoU<0.8
detector   264        0.730 (med)        1.159      1.142         72.3%
paffi       29        0.734              1.197      1.064         89.7%
rubix       99        0.789              1.170      0.968         62.6%
POOLED     393        0.756              1.165      1.027         71.2%
```

Those human boxes run ~16% wide and disagree with our convention at median
IoU 0.756. At `--coco-rep 8` they were **~29% of the training mixture**, so
the regressor was being fit to a blend of two conventions. Caveat: the
reference underestimates when the keypoint model misses a third face, so the
"16% wide" figure is an upper bound — but the *disagreement* is real and the
variance it injects is the point, not the sign.

**(c) Train/inference preprocessing mismatch.** `bbox_data` reduced the
320x240 cache to 160x120 with `x[:, ::2, ::2]` — nearest-neighbour
decimation, which aliases sticker edges. The browser's `drawImage` downscale
does not. Feeding the deployed box3 model a `::2`-decimated input instead of
a smooth one moved **median IoU on data_real_val from 0.888 to 0.959**: the
model had been trained on a sharper, aliased image than it is ever shown at
runtime.

**(d) No portrait pillarbox in the synthetic half.** The app feeds 480x640
portrait, which letterboxes into 160x120 as a 90x120 content window with 35 px
grey bars each side. Every synthetic image is 640x480 landscape and fills the
canvas edge to edge. Controlled A/B on the *same* synthetic val images —
landscape vs a centred 3:4 crop, which has identical scale (both letterboxes
are height-limited at 0.25) so only the bars differ:

```
             IoU mean   IoU med   IoU<0.7   w/t med   h/t med
landscape      0.811     0.843     16.0%     1.002     0.997
portrait       0.787     0.819     19.4%     0.964     0.977
```

A systematic **~4% width shrink** — the one effect that genuinely matches the
user's "too small" wording, though it is small next to (a).

### The hand-occlusion hypothesis: real, but NOT the mechanism proposed

Tested objectively on 700 `data_v4` val frames using the generator's own
`meta.hasHands` (a clean randomized split — the generator places hands
independently in ~50% of scenes), so no judgment calls and no hand-classifying
by eye was needed:

```
group               n     IoU mean/med   <0.7    w/t med  h/t med   median per-edge inset
hands             362      0.758/0.786   28.7%    0.988    0.986    L+.012 T+.011 R+.007 B+.015
no hands          338      0.832/0.872   13.0%    0.995    0.987    L+.004 T+.002 R+.005 B+.009
3+ fingers        264      0.747/0.771   31.1%    0.983    0.984    L+.013 T+.011 R+.008 B+.022
clutter           160      0.781/0.822   21.9%    1.009    0.995    L-.008 T-.000 R-.001 B+.007
no occluder       263      0.833/0.873   12.9%    0.990    0.987    L+.004 T+.004 R+.008 B+.011
```

Occluders cost ~0.075 IoU and **double the bad-frame rate**. But the median
per-edge insets and the median w/t and h/t are essentially identical between
the groups. **The box does not stop at the fingers; it just gets noisier.**
That is consistent with cause (a): a global-average-pooled regressor sums a
large skin-coloured distractor into the same channel means it reads the box
out of, with no way to say "that region is hand". Non-clutter occluders show
the same effect, which the "hand occlusion eats the box" story does not
predict.

Also relevant: box3 was trained on `data_v3`, which predates the hands render
pass entirely — it had never seen a hand.

### Two things that are NOT bugs

- **The decode in `web/src/detect/cubebox.ts` is correct.** It mirrors the
  training parameterisation exactly (letterbox to 160x120, pad rgb(114,114,114),
  sigmoid objectness and cx,cy,w,h, multiply by input w/h, map back through the
  letterbox). Both measurement scripts reproduce it independently and agree with
  torch. **The file was not modified.**
- **The bbox target convention in `bbox_data.SynthBBox` is correct.** It is the
  hull of all visible faces' corners = the silhouette. Synthetic labels are pure
  projected geometry (occlusion never changes them) and the hand-labelling
  convention explicitly clicks estimated occluded corners. The convention
  problem is in the *COCO* source, not here.

### Out-of-scanning-range frames are a red herring

IoU on data_real_val is monotonic in cube size:

```
  size bin (gt long side, px at 160x120)   n   box3 mean IoU   med w/t
    0- 30 px                                6      0.496        1.214
   30- 45 px                               10      0.797        0.967
   45- 60 px                               16      0.846        0.998
   60-999 px                                5      0.947        0.991
```

The worst frames are far-away cubes where the box comes out much too **big**.
But the project's own scanning-range DECISION (README, 2026-09-12) puts the
floor at a cube bounding sphere of 0.266 of frame height ≈ **32 px** in the
160x120 input, so the entire 0–30 bin is out of scope. Report the in-range
number alongside the raw one; the raw mean is dominated by frames nobody will
ever scan.

---

## 2. Runs

`box1`, `box2`, `box3` predate this session (see `git log` for `a9ec59b`).
They trained on `data_v3` + Roboflow at `--coco-rep 8`. **`data_v3` no longer
exists on disk**, so none of them is reproducible — that alone forced a
retrain onto `data_v4`.

| run | head | data | what changed | val_iou | real_iou | real_bad |
|---|---|---|---|---|---|---|
| box1 | gap | data_v3 + coco×8 | v1, L1 box loss | 0.651 | — | — |
| box2 | gap | data_v3 + coco×8 | added GIoU term | — | — | — |
| box3 | gap | data_v3 + coco×8 | **was deployed** | 0.822 | — | — |
| box4 | dense | data_v4 + real×40 + coco×4 | new head, new aug, coco objectness-only | 0.892 | 0.834 | 0.135 |
| box5gap | gap | same as box4 | **ablation**: old head, everything else new | 0.850 | 0.810 | 0.135 |
| box6 | dense | same | Gaussian cell target instead of box plateau | 0.886 | **0.846** | 0.108 |
| box7 | dense | same | peak-normalized Gaussian, 80 epochs | 0.895 | 0.835 | 0.108 |
| box8 | dense | same | + darkening augmentation (0.45× floor) | 0.891 | 0.828 | 0.108 |

`val_iou` for box1–3 is on the `data_v3` val split and for box4–8 on the
`data_v4` split — **not comparable across that line**. `real_iou` (IoU on
`data_real_val`, never trained on) is the cross-run yardstick, and it did not
exist before this session; box3's equivalent was measured after the fact with
`scratchpad/bbox_measure.py` at **0.790 mean**.

### Measured on the held-out labelled photos (the number that matters)

```
run              IoU mean    med   <0.7  in-range mean  in-range<0.7  min obj
box3 (was live)     0.790  0.888  32.4%      0.851         20.7%       0.91
box5gap             0.808  0.866  13.5%      0.860          3.4%       0.48
box4                0.835  0.875  13.5%      0.873          3.4%       0.54
box6  <- deployed   0.846  0.875  10.8%      0.879          3.4%       0.07
box7                0.835  0.869   8.1%      0.869          3.4%       0.21
box8                0.825  0.871  10.8%      0.878          0.0%       0.18
```

**box6 is the best and is what is currently exported and deployed.** Mean IoU
0.790 → 0.846; frames below IoU 0.7 32.4% → 10.8%; **in-range frames below 0.7
20.7% → 3.4%**. Per-edge sd collapsed on two edges (top 0.191 → 0.082, right
0.204 → 0.083) and improved on bottom (0.183 → 0.110); left is unchanged
(0.140 → 0.139).

On the 8 real app frames in `scratchpad/inbox2` (reference = hull of the
stage-2 keypoint quads): mean IoU **0.769 → 0.874**, worst frame **0.670 →
0.790**, and every one of the 8 improved. Objectness 0.98–1.00 on all 8.

### Honest caveats on those numbers

- **box4 / box6 / box7 / box8 are within noise of each other.** 37 photos;
  CLAUDE.md's own rule is that 1–2% differences on this set are noise. Do not
  read the box6-vs-box7 ordering as a finding. What *is* outside noise is the
  whole group vs box3, and box5gap vs the dense runs.
- **The ablation is the one clean attribution.** box5gap is identical to box4
  in data, augmentation and schedule and differs only in the head: real_iou
  0.810 vs 0.834, val_iou 0.850 vs 0.892. So roughly: the data +
  augmentation + coco fixes buy 0.790 → 0.810, and the dense head buys
  0.810 → 0.834–0.846. Both halves matter; neither alone is the fix.
- **The median got slightly worse** (0.888 → 0.875), i.e. the previously-good
  close-up frames each gave up 0.05–0.10 IoU while the bad ones gained
  0.2–0.7. That is the trade the heavier geometric augmentation and the
  soft-argmax averaging make. It is a good trade for this bug, but it is a
  real regression on the easy cases and worth attacking (see §4).

### Dead ends

- **box4's flat inside-the-box cell target.** Weighting every cell over the
  cube equally in the read-out let rim cells — which only see part of the cube
  — drag big close cubes ~3% small. The Gaussian target (box6) fixed it.
- **box7: peak-normalizing the Gaussian + 80 epochs.** The theory was that a
  Gaussian target whose sampled peak is 0.6–0.9 drags down the exported
  objectness (`max` over cells) and explains the dark-frame miss. It did not:
  min objectness went 0.07 → 0.21, still a miss. And synthetic val_iou kept
  climbing (0.901) while real_iou drifted down — mild overfit to synthetic, so
  **80 epochs is not better than 40–50**. The normalization is still in the
  code and is harmless/principled; the 80 epochs are not worth repeating.
- **box8: darkening augmentation.** The theory was that `data_v4`'s
  auto-exposure floor (which re-renders near-black scenes brighter, 5.4% of
  them) stripped the dim frames the model needs. Extending the brightness
  multiplier down to 0.45× did **not** recover the dark photo's objectness
  (0.18). The change is still in `bbox_data._augment`; it is plausible but
  **unproven and currently has no measured benefit** — a candidate for
  reverting.

### The one open regression

`img_real000053` — a dim, dead-on, single-face, *landscape* 640x480 photo of a
cube against a lit monitor (cube luminance 64 against a median of 108 across
the set) — fell from objectness **0.99 under box3 to 0.07 under box6**, i.e. a
flat detection miss. It is the only photo in the set below the 0.5 threshold.

What is known: **box5gap shows it too (0.48)**, so it is *not* the dense head —
it is the data or the augmentation change. The darkening augmentation did not
fix it (box8: 0.18). The same photo also loses IoU in every new run
(0.951 → 0.659 under box6).

Consequence in the app is graceful: `autoscan-main.ts` falls back to the
previous ROI / full frame when `locate()` returns null. But it is a genuine
regression against box3 and it is unexplained. **If you want zero misses
today, `box4/best.pt` is the only new checkpoint with none (min obj 0.54) at a
cost of 0.011 mean IoU — that cost is within noise, so box4 is a completely
defensible deploy instead of box6.**

---

## 3. Files changed / created

Changed (all uncommitted, all working):

- `model/train/bbox_data.py` — rewritten. `avg_pool2d` instead of `[::2,::2]`;
  zoom/translate and portrait-pillarbox geometric augmentation; a `box_valid`
  flag added to the sample contract; `CocoBBox` defaults to `box_valid=0`.
  Sample tuple is now **4-wide** `(x, obj, box, box_valid)` — any other caller
  of these datasets must be updated.
- `model/train/train_bbox.py` — added the `DenseBox` head and
  `build_box_model()`, `--head dense|gap`, per-cell auxiliary loss with a
  size-scaled Gaussian target, `--coco-box`, `--real-val`, `--select real|val`,
  and `real_iou` / `real_bad` / `val_iou` / `val_bad` on every epoch line.
  Checkpoints now record `head` and `real_iou`.
- `model/export/export_bbox.py` — rebuilds from `ckpt["head"]` (absent ⇒
  `gap`, so old checkpoints still export), writes `head` and `realIou` into
  the sidecar, default `--ckpt` moved to `runs/box4`.
- `web/public/models/cubebox.onnx` — **box6**, dense head, 641 KB (was 785 KB
  gap / 0.20M params; dense is 0.16M params but the graph carries the reduction).
- `web/public/models/cubebox.json` — sidecar; note it now carries `head` and
  `realIou`.

Created:

- `model/train/runs/box4`, `box5gap`, `box6`, `box7`, `box8` + their
  `-console.log` files.
- This file.

Deliberately **not** changed: `web/src/detect/cubebox.ts` (the decode is
correct and the dense head's exported output is bit-compatible with it),
`model/README.md` (the findings above were never folded in — **do that**),
anything in `web/src/` the user was editing.

Nothing is in a broken state. `cd web && npm test` → **125 passed**.
No orphaned `spawn_main` workers are running; box8 exited cleanly on its own
and the `watch.py` dashboard is stopped.

### Analysis scripts (in the session scratchpad — copy them out if you want them)

`C:\Users\moowi\AppData\Local\Temp\claude\C--Users-moowi-Documents-GitHub-cube-stuff\2a9cf3f7-a320-4b99-8651-4cb8ca3f9aaf\scratchpad\`

| script | what it does |
|---|---|
| `bbox_measure.py` | per-edge signed error + IoU of the **deployed** onnx on a labelled root |
| `bbox_rows.py` | same, per-photo rows + size bins; takes an onnx path as argv[3] |
| `bbox_vs_faces.py` | unlabelled frames, keypoint quads as the silhouette reference, writes a contact sheet |
| `sheet_val.py` | annotated contact sheet of a labelled root (green = truth, red = prediction) |
| `occl_test.py` | the hands/clutter/shadow/corner-on split on synthetic val |
| `aspect_test.py` | the landscape-vs-portrait controlled A/B |
| `roboflow_audit.py` | the COCO-box convention audit |

These are the evidence for every number above. They live in a temp directory
and **will be deleted** — move the ones you care about into `model/train/`.

---

## 4. What to try next, in priority order

1. **Explain the `img_real000053` objectness collapse.** It is the only
   outright regression and it is unexplained. Concrete next step: run box3 and
   box6 on that image with each augmentation family disabled in turn, and
   diff `data_v3` vs `data_v4`'s luminance histograms. Suspicion (untested):
   `data_v4`'s auto-exposure floor removed the dim tail, but the darkening
   augmentation not fixing it argues against that, so look at the
   *landscape + single-face + dead-on* combination too — the geometric
   augmentation may have made full-frame landscape cubes rarer in effect.
2. **Recover the median.** 0.888 → 0.875 says the easy close-up frames each
   lost a little. Cheapest probes: narrow the zoom range from 0.72–1.3 to
   0.85–1.15; lower the pillarbox probability from 0.45; sharpen the read-out
   with a softmax temperature. Each is a 15-minute run.
3. **Label more real photos, especially dim and far ones.** Every remaining
   failure on `data_real_val` is one of ~5 photos and the whole set is 37. The
   measurement is at the edge of what it can resolve — this is the single
   biggest lever on confidence in any future comparison.
4. **Re-audit the Roboflow decision.** `--coco-box` is off, so those ~985
   images now train objectness only. Nobody has measured whether putting their
   boxes back at a low weight (say 0.25) helps or hurts; the audit only
   established that their convention differs.
5. **Suspected but untested:** the `data_real*40` oversampling is arbitrary —
   157 photos at ×40 is ~6k of a 60k mixture, and nobody swept it. Also
   untested: whether the dense head wants stride 8 instead of 16 for small
   cubes (the grid is 10x8; a 32 px cube covers ~2x2 cells).
6. **Do not add a scale-up fudge factor.** The labelled ground truth says the
   median box is the right size (w/t 1.029, h/t 0.993 under box6). And the
   crop path already pads generously — `autoscan-main.ts` calls
   `padBox(hit.box, 0.45, ...)` — so a 5% inset is not what is clipping stage
   2. If a residual inset ever *is* the problem, argue it from the error
   distribution first.

---

## 5. Commands to resume

All paths relative to `model/`. Python is `model\.venv\Scripts\python.exe`.

**Launch a run** (as a session background task — detached `Start-Process`
launches silently fail on this machine; see CLAUDE.md):

```
cd model\train
..\.venv\Scripts\python.exe train_bbox.py ^
    --data "../data_v4,../data_real*40" --coco ../roboflow --coco-rep 4 ^
    --head dense --epochs 50 --workers 8 --out runs/box9 ^
    > runs/box9-console.log 2>&1
```

~21 s/epoch (60,392 train samples, 8 workers — that is within the ~12-worker
/ ~80% CPU ceiling; do not raise it). A 50-epoch run is ~18 minutes.
`--head gap` reruns the old architecture for an ablation.
`--select real` (default) picks `best.pt` on `data_real_val`, never trained on.

**Watch it:**

```powershell
Get-Content C:\Users\moowi\Documents\GitHub\cube_stuff\model\train\runs\box9-console.log -Wait -Tail 10
```

Dashboard (probe port 8123 first — a second launch just fails to bind):

```
cd model\train && ..\.venv\Scripts\python.exe watch.py     # http://localhost:8123
```

**Export a checkpoint** (writes `web/public/models/cubebox.onnx` + `.json`):

```
cd model\export
..\.venv\Scripts\python.exe export_bbox.py --ckpt ../train/runs/box9/best.pt
```

**Evaluate the deployed model:**

```
cd model
.venv\Scripts\python.exe <scratchpad>\bbox_measure.py data_real_val
cd train
..\.venv\Scripts\python.exe <scratchpad>\bbox_vs_faces.py <scratchpad>\inbox2 out.png
```

`bbox_rows.py` takes an onnx path as a third argument, so you can score a
checkpoint without deploying it — export it to a scratch `.onnx` first with:

```python
import torch; from train_bbox import build_box_model
ck = torch.load('runs/box9/best.pt', map_location='cpu', weights_only=True)
m = build_box_model(ck['head']); m.load_state_dict(ck['model']); m.eval()
torch.onnx.export(m, torch.zeros(1,3,120,160), 'box9.onnx',
                  input_names=['image'], output_names=['box'],
                  opset_version=17, dynamo=False)
```

**Then always:** `cd web && npm test` (125 tests).

### Resumability of the runs

`train_bbox.py` has **no `--resume`** — that flag exists on `train.py`, not
here. Every `runs/box*/last.pt` and `best.pt` is a plain state-dict checkpoint
with no optimizer or scheduler state, so a run can only be *restarted*, not
continued. None of box4–box8 was interrupted; all five ran to their full epoch
count and exited cleanly, so there is nothing half-finished to rescue. If you
want to continue from one, add `--init` (it does not exist yet either) or just
rerun — a 50-epoch run is 18 minutes.

**If you ever do kill a run:** on this machine that leaves orphaned
`spawn_main` DataLoader workers holding the `runs/<name>-console.log` handle,
and the next launch dies with "file is being used by another process". Hunt
them with:

```powershell
Get-CimInstance Win32_Process -Filter "Name like 'python%'" |
  Select-Object ProcessId, CommandLine
```

and kill anything whose command line contains `spawn_main`.
