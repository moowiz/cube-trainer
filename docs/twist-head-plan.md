# The twist head (M13): where it stands and what comes next

Handoff written 2026-09-20. Read `MILESTONES.md` (M13), `docs/smart-cube-design.md`
section 5 (the design and the two findings that changed it) and
`model/README.md` "Layer twist" (the data and the label contract) first;
this file is the work list, in order, with the commands and the decision
points. Say colours, not letters, in anything you write down (CLAUDE.md).

## 1. What exists (all on `main`, commits `b6901b1`..`e96793f` plus this one)

**Data.** `D:\cube-data\model\data_v6` (WSL: `model/data_v6`, a symlink):
21,000 renders at 480x640, seed 61, `--cornerBias 0.4 --twist 0.3 --rest 0.12`.
Audited by `model/train/check_twist.py --data model/data_v6`: 1,437 negatives,
8,194 twisted (5,767 mid-turn uniform 0-90 deg, 2,427 at rest 2-20 deg),
4,286 of the mid-turn ones motion-blurred (median 5.5 deg of sweep), 3,426
with a hand aimed at the layer, no label without an image. Rendered on the
Windows box with full Chrome; the blur (sub-frame averaging, only the layer
smears) verified by eye on `img_018003` (red layer at 88 deg, 18.7 deg sweep).
`data_v5` (54k, no mid-turn layers; its 22% rest misalignments convert to
twist labels automatically) stays in every run's `--data`.

**Model side** (`model/train/`): `train.py --twist` adds 8 channels to the
centre head (6 class logits + cos/sin of 4x the angle), `targets.py` builds
the per-quad targets under all four cyclic corner shifts, `model.py` has the
loss (class under the shift the corners chose), `decode_maps(with_twist=True)`,
`center_metrics` twist counts, `load_center_weights` (a kpft checkpoint
initialises a twist run, twist channels fresh), `--head-lr-mult`.
`check_targets.py` round-trips perfect twist maps under every shift;
`check_twist.py` verifies the sign and adjacency conventions against the
geometry. `dataset.py` reads the label's `twist` field (cache version 4: the
first run rebuilds every label cache, several minutes for v5). A 36-image CPU
overfit reaches corner 1.5 px, twist F1 1.00, class 1.00, angle 0.4 deg at
300 epochs (`runs/twist-smoke`), so the pipeline learns what it is given.
`export/export_onnx.py` exports the 17-channel model and describes the
channels in `facekp.json` under `output.twist`; the app's decoder ignores
the extra channels, so a twist model can be deployed today without the app
reading it (parity 2e-6, verified). `twostage.py` returns the twist per quad.

**Measurement** (`tools/solve/twist_audit.py`): scores a checkpoint's twist
channel against the smart cube's move log on any recording, no labels
needed - per threshold turns seen and rest false alarms, per layer, class
mix, angle sweeps, detector coverage on its own, `--strips` for the frames.
Verified end to end with the deployed kpft8 (coverage only) and the overfit
checkpoint (every path); 12 ms/frame on the desktop CPU.

**Generator** (`model/gen/`): `--twist F --rest F`, body-frame corners for
non-turning faces, a hand on the layer, sub-frame blur, `visualize.mjs`
draws the twist. Uses full Chrome on Windows and chrome-headless-shell on
Linux (the only Chrome that starts in the WSL sandbox; see
`docs/wsl-sandbox.md`, last section, which also explains `--workers 0`).

## 2. The contracts, in one place

- **Label field** (synthetic and real): `"twist": null | {"face": "R", "deg": 37.2 | null, "mode", "blurDeg"}`;
  `face` = the turning OUTER layer by its centre's letter in the standard
  scheme (white U, red R, green F, yellow D, orange L, blue B); `deg` =
  clockwise seen from outside that face, `null` = unknown (cube-labelled
  frames); `"face": "?"` = masks the frame out of the twist loss (slice,
  wide turn, rotation, unsure). No field = a static cube.
- **What the head predicts, per quad** (stage 2's quads are anonymous):
  class `none` / `self` (this quad is the turning layer) / `edge k` (the
  layer across the quad's k-th edge, decoded corner k -> k+1, is turning);
  angle as (cos 4a, sin 4a), i.e. the angle MOD 90: a layer at +30 is the
  same picture as one at -60. Direction comes from the sweep across frames
  (0, 20, 50, 80 clockwise; 0, 70, 40, 10 the other way), never from one
  frame. `targets.NEIGHBOUR` maps face letters to edges; deg > 0 moves every
  neighbour's bordering row from its corner k+1 toward its corner k.
- **Corners during a turn:** the turning face's quad is the rotated layer;
  every other face keeps its body-frame corners (the frame of the six
  stickers that did not move). Label real mid-turn frames the same way.
- **Sidecar** (`web/public/models/facekp.json`, written by the export):
  `output.shape [1,17,16,16]`, `output.twist = {channels [9,17], classes
  [...], classChannels [9,15], angleChannels [15,17], angle: a = atan2(sin,
  cos)/4}`; `head` stays `center-v1`, `points` 4.
- **Cube time -> frames** (design doc 8, `tools/solve/cube_latency.py`):
  fitted send time T = slope * tRaw + offsetLsq (least squares); the layer
  stopped at T - 5 ms; a turn lasts ~120-250 ms (median 176). The audit uses
  [T - 355, T + 25] ms as the turn and > 600 ms from every turn as rest.

## 3. Work next, in order

### Step 1 - train (Windows, GPU; ~15 min then ~1 h 15)

From `model\train` (PowerShell; start `..\.venv\Scripts\python watch.py`
for http://127.0.0.1:8123 unless it is already up). The quick look first:

```
..\.venv\Scripts\python train.py --data "D:\cube-data\model\data_v6,../data_v5,../data_real*150" --init runs/kpft8/best.pt --twist --head-lr-mult 10 --epochs 15 --lr 5e-5 --select real --out runs/tw-ft1 > runs\tw-ft1-console.log 2>&1
```

then the real run and its real-photo fine-tune:

```
..\.venv\Scripts\python train.py --data "D:\cube-data\model\data_v6,../data_v5" --twist --epochs 150 --out runs/tw1 > runs\tw1-console.log 2>&1
..\.venv\Scripts\python train.py --data "D:\cube-data\model\data_v6,../data_v5,../data_real*150" --init runs/tw1/best.pt --twist --epochs 15 --lr 5e-5 --select real --out runs/twft1 > runs\twft1-console.log 2>&1
```

The epoch line adds `tcls`/`tang` (the two loss terms) and `tw_f1` /
`tw_cls` / `tw_deg` on synthetic val (a face read as turning vs not; the
right edge or self among turning faces; angle error mod 90 in degrees).
`real_tw_*` appears only once real frames carry twist labels.

What to check: `real_px` must stay at kpft8's level (3.84 px mean on
`data_real_val`, 8 of 280 faces missed) - if adding the head costs more than
~0.3 px there, lower `twist_weight` in `model.center_loss` (0.5, 0.5) or
train the head alone on top of frozen kpft8 before deciding anything about
the twist. `--select real` picks best.pt on corners only; look at `tw_*` at
that epoch yourself. Expect `tw_f1` well above 0.9 and `tw_deg` under ~5 on
synthetic val; if not, something is wrong before any real-frame question.

**Step 1 result (2026-09-20).** The quick look failed and the real run
passed, and the difference is instructive:

- `tw-ft1` (kpft8 + fresh head, lr 5e-5): `tw_f1` 0.31, `tw_deg` 10.1 after
  15 epochs. Two causes. The class loss was 92% `none` per epoch (the real
  photos x150 are half the epoch, all static) and the head learned that
  prior: 70% of turning val faces read `none`. Fixed by balancing the two
  halves of the class loss per batch (`model.center_loss`). Re-run as
  `tw-ft2`: `tw_f1` 0.57 - but the angle head never moved in either run
  (every face read ~0 deg = the mean of (cos 4a, sin 4a)): kpft8's features
  do not carry the angle and a 5e-5 fine-tune does not grow it. The corners
  paid for the attempt too (val_px 3.06 -> 3.57).
- `tw1` (from scratch, balanced loss, 150 epochs, 2 h 50 at 1250 img/s):
  `tw_f1` 0.90, `tw_cls` 0.85, `tw_deg` 3.0, val_px 3.10. On data_v6 val
  faces: 1.2% of static faces read turning, 12% of turning faces read
  `none` (mostly the <= 5 deg ones the ramp down-weights), `self` 58/63,
  edges ~85% right modulo one consistent cyclic shift (the corner order the
  metric already accounts for), angle error 4.5 deg mean / 2.1 median (6.7
  on >= 12 deg). Both bars met. **The head needs the backbone trained with
  it; do not fine-tune a twist head onto a corner checkpoint again.**

### Step 2 - the measurement (WSL or Windows; a minute per solve)

```
model/.venv/bin/python tools/solve/twist_audit.py recordings/2026-09-19-105604 --ckpt model/train/runs/tw-ft1/best.pt --strips 12
model/.venv/bin/python tools/solve/twist_audit.py recordings/2026-09-20-141443 --ckpt model/train/runs/tw-ft1/best.pt --strips 12
model/.venv/bin/python tools/solve/twist_audit.py recordings/2026-09-19-094131 --ckpt model/train/runs/tw-ft1/best.pt --strips 12
```

(Windows: `..\.venv\Scripts\python` with the `--box` path if `runs/box17`
is elsewhere.) Output in `<session>/twist-audit/<run>/summary.md`,
`audit.json`, `strips/`. Repeat with `twft1`. Read it in this order:

1. **Coverage** (turns with at least one quad): if it is low, the hand
   problem of `docs/solve-tracking-design.md` 10.2 is still upstream of
   everything and the twist verdict is about the detector, not the head.
2. **Recall given a quad at p >= 0.5 vs the rest false-alarm rate.** A
   usable channel has recall well over 0.5 with a FAR under ~0.1 on rest
   frames that carry a quad. The per-layer table says which layers this
   camera setup never shows.
3. **Sweeps**: the fraction of seen turns whose angle runs monotonically.
   This is what timing and direction would come from; if turns are seen but
   sweeps are rare, the reader gets "a turn happened near here on layer X"
   and nothing finer, which is still useful.
4. **Strips** for a dozen turns: is the magenta on the turning layer or on
   the fingers?

**The decision (design doc 5.3):** at least half the turns readable on at
least one frame -> step 3. Under half -> step 3B. Write the numbers into
`docs/smart-cube-design.md` 5.3 either way.

### Step 3 - the app reads the twist (when the audit says yes)

a. `web/src/detect/facekp.ts`: read `meta.output.twist`; in `decodeMaps`
   gather the 8 channels at each kept cell (channel-major, `maps[(c) * n +
   cell]`), softmax the six, `deg = atan2(sin, cos) / 4 mod 90`; extend
   `DetectedQuad` with `twist?: {probs, cls, twistCls, pTwisted, deg}` in
   the quad's own corner order (mirror `model.py decode_maps` /
   `twostage.py`). Regenerate the parity fixture from the twist checkpoint
   (`model/train/dump_decode_fixture.py --ckpt runs/tw-ft1/best.pt --data
   ../data_v6`) and extend `web/test/facekp-decode.test.ts` to compare the
   twist read too. Stage-2 cost goes 9 -> 17 output channels on the same
   trunk: negligible, but confirm the phone number in the debug panel.
b. Carry it into the evidence: `QuadObs` in `web/src/colour/types.ts` gets
   `twist?` (same shape, already in the track's corner order), set in the
   sampler path (`colour/sampler.ts`, `sample.worker.ts`). The evidence log
   is the capture format, so captures then hold the twist and the
   `moves-replay` fixtures can score it; bump the capture version note in
   design doc 7.
c. The reader: an emission term in `web/src/moves/anchor.ts` `frameCost`
   (the reader's per-frame evidence under a hypothesised state; the beam
   and transitions live in `moves/reader.ts`). A track's face letter and
   rotation are known from the anchoring, so a twisted read `edge k` on
   track X names a layer; a hypothesis that turns that layer across this
   frame interval pays less, one that turns a different layer while a
   confident read says "this one" pays more, and a confident read on rest
   frames of a hypothesis with no turn nearby pays a bounded amount (a flat
   cap, like the occlusion veto - a finger must never buy a move). The
   angle sweep (monotone across frames) places the turn in time. Keep the
   certificates untouched; the twist is one more channel, not a new
   decision.
d. The M13 numbers: `web/test/moves-replay.test.ts` fixtures
   (`test/fixtures/solves/*.json`, built by `web/scripts/cube-fixture.ts`
   from a recording with the cube as truth) with and without the channel:
   turns read / true, false turns, gaps, timing error, certificate
   calibration. Into `docs/solve-tracking-design.md` 10.2.
e. Deploy: `export_onnx.py --ckpt runs/twft1/best.pt --data ../data_v6`
   (deploy gate precedent in MILESTONES M5: per-batch `real_px` vs the
   deployed model), commit `web/public/models/facekp.*`, push (Pages).

### Step 3B - the video-window model (when the audit says no)

Design doc 5.2 B: a short window (8 frames) of the stage-1 crop at ~128 px
-> which turn (18 + none) and its progress. The generator already animates
the layer for the blur (`scene.mjs`, `turnLayer` in the render block): a
clip renderer is that loop with one PNG per step and a fixed scene, plus a
moving hand. Labels per clip come from the same `twist` field per frame.
Real clips come free from the recordings (the audit's turn windows are the
positives). Do not start this without the audit's numbers in the design doc.

### Step 4 - real mid-turn labels (the user's side, in progress)

Frames from the recordings inside a turn's window get `{"face": X, "deg":
null}` (the cube gives the layer and direction, not the angle), frames
outside get `null`, and the frames at a window's edges `"face": "?"`.
Corners on mid-turn frames follow the convention in section 2.
`model/train/import_labels.py` passes the field through; `web/label.html`
has no twist selector yet (add one if hand labelling these; a per-frame
face picker plus "?" is all it needs). Hold out whole recordings, never
frames of a recording that is in the training set. Once such frames exist
in `data_real_val`, `real_tw_*` appears in the epoch line by itself.

## 4. Gotchas

- In the WSL sandbox: `puppeteer.launch` must be `headless: 'shell'`
  (already so on Linux), `train.py` needs `--workers 0`, there is no GPU,
  and anything launched with `&` dies when the command ends - use the
  harness's background mode. Push with `tools/wsl/push.sh`.
- The first training run after this change rebuilds every label cache
  (CACHE_VERSION 4, `twist` in `targets.npz`); `data_v5`'s 16 GB crop cache
  takes several minutes on 8 workers. Not a hang.
- Windows: a killed `train.py` leaves DataLoader workers holding the log
  file (CLAUDE.md "Hard-won facts").
- `runs/twist-smoke*` are 36-image overfits, useful only as plumbing
  stand-ins; their audit numbers mean nothing.
- `check_twist.py --data` flags a turning face sharing a corner with a
  neighbour as a convention break; near 90 deg that is expected (exempted
  from 2026-09-20).
- `--head-lr-mult` scales the whole last 1x1 conv, corner channels
  included; it exists for the fine-tune's fresh twist channels and is
  untested at scale.
- Slice and wide turns (M, r, ...) are outside the first head: a real frame
  mid-M gets `"face": "?"`, and the audit counts the cube's M as a turn it
  cannot see. The GAN reports outer-layer quarter turns; check what it sends
  for a slice before reading a per-layer table too literally.

## 5. Open questions

- Hands. The synthetic hands are capsules and the real turning hand covers
  the layer. The audit's coverage and strips answer whether the layer is
  ever visible enough; the fallback is step 3B, not more finger realism
  (the 2026-09-12 sign-off).
- The angle's use. Mod 90 with direction from the sweep is what a single
  frame supports; if sweeps turn out rare, the reader uses the class alone.
- Rest misalignments. Synthetic `rest` twists of 2-9 deg are supervised at
  a ramped weight (`targets.TWIST_RAMP_DEG`) while real static photos with a
  slightly misaligned layer are `none`. If the head fires on every resting
  cube at p ~0.3, raise the ramp's lower end rather than the threshold.
