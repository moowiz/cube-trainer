# MILESTONES.md

Each milestone ends with something you can run on a phone. Don't start the next one until the "done when" holds.

**Where things stand (2026-09-14):** M0-M7 done. The app is a two-stage
detector (stage-1 cube localizer -> stage-2 anonymous face quads on the
crop, M4b below) feeding an evidence-log colour solver with an exact
constrained decoder (M7, `docs/colour-pipeline-design.md`); the phone locks
real scrambles. M8 hardening is mostly landed but its real-room checklist has
never been run as a checklist. Work in flight is the solve coach
(`docs/solve-tracking-design.md`): recordings and measurements exist, no
move reader yet. Deployed models: `cubebox` = box17, `facekp` = kpft8
(`model/README.md` "Deployed").

**Update (2026-09-16):** a GAN356 i Carry E smart cube is on order. It is a
labelling instrument, not the product: ground truth for the camera move
reader and training data for a video move model, plus the timer that
replaces csTimer so that every desk solve records itself. The plan is
M9-M13 below; decisions and design in `docs/smart-cube-design.md`, the
landscape and the full feature catalogue in
`docs/smart-cube-trainer-survey.md`. **Current milestone: M9** (superseded
by the 2026-09-22 update below).

**Update (2026-09-19):** the cube arrived; it connects and records
(M9 all but its written-down numbers), the timer is in daily use with
csTimer's history imported (M10's timer half). Tap-to-fix is dropped as a
requirement: a refused or wrong lock is rescanned. Next: M10's
calibration and reader numbers, then M11. **M13's synthetic half was
pulled forward on 2026-09-19** (the reader cannot be calibrated until
the detector sees layers rather than hands); the work list and handoff
are in `docs/twist-head-plan.md`.

**Update (2026-09-22):** M9 and M10's timer/rig half are done; M10's
calibration (twenty cube-labelled recordings, the reader's numbers) is
still open, and M11/M12 have not started — M11's `web/src/analysis/`
does not exist yet. In between, the last-layer trainer grew into its own
milestone off the plan (M10b below, shipped 2026-09-21), and M13's twist
head cleared its accuracy bars on `data_v6` (2026-09-20) but is not wired
into the app yet. A repo-wide maintenance pass
(`docs/maintenance-plan.md`) landed 2026-09-22: dead code and duplicated
helpers stripped, the deploy shrank 115 MB -> 35 MB, and CI now runs the
headless checks and ruff. **Current milestone: M10's calibration,
alongside M13's next step.**

---

## M0 — Skeleton ✅ (done 2026-09)

Vite + TypeScript project in `web/`. Camera feed rendered to a canvas. FPS counter. HTTPS dev server (camera requires it). Deployable as static files.

**Done when:** the app opens on a phone, shows the rear camera at ~60 fps, and `npm test` runs one trivial test.

---

## M1 — Grid overlay scanner (the baseline product) ✅ (done 2026-09)

Fixed 3x3 grid overlay on the video. Sample 9 cells per frame. Lab conversion + k-means classification. Scan six faces in U R F D L B order with an on-screen prompt. Face locks after N stable frames. Full state assembled, validated with cubejs, solution displayed. Tap any sticker to override.

This is the fallback path that must keep working forever.

**Done when:** you can scan a scrambled cube in a normally lit room and get a valid state on the first try most of the time, and cubejs produces a solution.

**Watch for:** red/orange split. If k-means merges them, seed centroids from the six centers instead of random init.

**Exit evidence:** a scrambled scan (fixture `cube-scan-1789102641416`, known scramble) classified 54/54 first try with zero corrections in kitchen evening light. Beyond the bar: exposure-normalized + center-anchored k-means (seeded from centers, per the watch-for) so a strong color cast (blue monitor as main light, fixture `…2942492`) degrades to 43/54 + low-confidence tap-to-fix instead of failing. Known limit: white vs blue under monitor-only lighting is separable only by absolute lightness — graceful degradation is the intended behavior there.

---

## M2 — Test harness and debug tooling ✅ (done 2026-09)

Save-frame button that dumps the current `ImageData` plus the detected sticker colors to `web/test/fixtures/`. Debug panel with Lab and HSV views, cluster centroids, per-sticker confidence. Unit tests for `color.ts` and `state.ts` against fixtures.

**Done when:** a color misread can be reproduced from a fixture in a test without a camera.

**Exit evidence:** "Save debug frame" / "Save scan report" buttons + a phone→repo upload loop (Claude Fixture Inbox artifact); 12 real fixtures in `web/test/fixtures/` with a data-driven test driver; every lighting failure so far (underexposure, backlit, duplicate face, monitor cast) was reproduced from a fixture and fixed test-first. 66 tests.

---

## M3 — Synthetic data generator ✅ (signed off 2026-09-12; realism judged good enough once M5 existed)

In `model/gen/`: render a stickered and a stickerless cube with random scrambles, random camera pose (all three-face views), random lighting (including warm light and glare), random backgrounds (COCO or similar, plus procedural grids/tiles as hard negatives). Output image + per-face 4-corner labels + visibility flags. Target 20k images.

**Done when:** rendered images look plausible next to phone photos of your cubes, and labels visualize correctly when drawn back on the image.

**Decision to make here:** Blender (better realism, slower iteration) vs Three.js headless (faster, easier to match the web renderer). Default to Three.js unless realism is clearly the bottleneck.

**Status (2026-09-11):** generator built (Three.js in headless Chrome), 38k
images rendered across framing/lighting regimes, labels verified two ways
(overlay viz + center-sticker classification). The realism half of the "done
when" is NOT met — the user's verdict: "fairly obviously rendered images."
Proceeding anyway: geometric transfer to real frames already works partially,
and M5 fine-tuning is the designed realism compensator. Revisit (Blender or
better materials/noise) only if M5 can't close the gap.

**Status (2026-09-12):** generator v4/v5 pass reviewed against real phone
photos and signed off: real-scale hands (palm + forearm + fat fingers),
clutter, hard cast shadows, corner-on pose knob, varied center logos,
GAN tile profile, misaligned layers, auto-exposure floor. Details and
measured rates in `model/README.md`; the full ~54k `data_v4` root is
generated on a rented box per `model/cloud/RUNBOOK.md`.

---

## M4 — Face keypoint model ✅ (accuracy and speed bars met 2026-09-13; superseded in the app by M4b)

Small keypoint detector (MobileNetV3 or similar backbone, heatmap or direct-regression head) predicting up to 3 faces × 4 corners + per-face confidence. Train on synthetic data. Export to ONNX, int8 quantize, verify it loads in `onnxruntime-web`.

**Done when:** on a held-out synthetic set, mean corner error < 3 px at 320x240 input, and the ONNX model runs in the browser on a phone at ≥15 fps (measure, don't guess).

**Watch for:** WebGPU availability. Benchmark both `webgpu` and `wasm` providers; if wasm is too slow, shrink the model before optimizing anything else.

**Status (2026-09-11):** pipeline complete end-to-end — 38k-image training,
ONNX export with parity gates, browser runtime (`scan.html`, debug panel) verified in
headless Chrome (webgpu 6.1 ms / wasm 10.9 ms per inference on desktop).
**Speed bar met:** measured on the user's phone 2026-09-11 — 60 fps on the
wasm EP, 4x the >=15 fps bar. Accuracy: median 3.4 px on
held-out synthetic but mean 8.9 px — a tail of two characterized failure
modes: near-face-on close-ups regress a ~45°-rotated "hedge" quad (corner-
order ambiguity of a lone square face), and heavily foreshortened U/D faces.
Known open items: beat the tail (candidates: rotation-canonical corner
parameterization or heatmap head, more close-up data, M5 real-frame
fine-tune) and int8 (dynamic quantization shifts corners ~33 px — the fp32
model is deployed; static QDQ is the TODO).

**Update (2026-09-12) — anonymous-quad head, `--head center`.** Both open
items above are now settled, one fixed and one closed as "won't fix":

- *Diamond / identity-slot averaging: **FIXED at the root.*** The head is now
  fully convolutional CenterNet-style (`FaceKPCenter`): faces are peaks in a
  face-center heatmap and corners are offsets from the peak cell, with **no
  face identity in the model at all**. The diamonds came from six NAMED
  output slots forcing the loss to commit to an identity on views where it is
  genuinely ambiguous; with anonymous quads there is nothing to average.
  `web/src/detect/identify.ts` names each quad from its center sticker color
  instead, which is what the fixed-scheme renders were teaching anyway — and
  unlike the model, it can keep updating its idea of each color as the light
  changes. `diagnose.py` now reports `rot20%` so a regression is measurable
  rather than eyeballed.
- *Accuracy: **2.2x better at equal epochs.*** On the same data and recipe
  as the legacy baseline `runs/long4`, the center head reads 4.46 px val
  corner error at epoch 20 where long4 read 9.74 — and 4.46 is what long4
  reached after all 150 epochs. Detection F1 is 0.953 once faces further
  away than a person can hold a cube are excluded (DECISION 2026-09-12, see
  model/README "Scanning range"). The residual is FORESHORTENING, not corner
  accuracy and not distance: faces squashed below 1/4 aspect are missed 28.5%
  of the time against 4.6% for face-on ones. That is the third face of a
  corner-on view - the pose `--cornerBias 0.4` and `data_v4` already exist to
  supply, so the fix is the run that is already planned.
- *int8: **closed, superseded.*** Dropping the dense layer did not rescue
  quantization — static QDQ on the fully convolutional graph still misses the
  1 px gate. It no longer matters: the same change took the fp32 download
  from **24.5 MB to 4.66 MB** (6.27M → 1.19M params), which was the whole
  point of wanting int8.

Cost: inference is only ~10-15% slower than the legacy head (alternating
rounds on an idle box: webgpu 6.6 vs 5.9 ms, wasm 17.0 vs 14.6 ms), so the
60 fps should hold - re-verify on the phone via `/scan.html`.
Depthwise-separable fuse convs in the neck are the lever if it ever misses.

**Update (2026-09-13) — the full data_v4 run, and the accuracy bar is MET.**
`runs/v4base`, 150 epochs from scratch on the 54k `data_v4` (45 min local,
16 s/epoch - the cloud was never needed): **val_px 2.58**, real_px 3.89,
detection F1 0.979. The "done when" bar is mean corner error < 3 px, so it
is met - but read it with its caveat: `val_px` for this head is the mean over
*matched* faces, and 3.4% of in-range faces were not detected at all, which
shows up in F1 rather than in the mean.

Then `runs/v4ft1` (15 epochs, lr 5e-5, real photos x150, `--select real`):
**3.31 px mean / 3.03 median on `data_real_val`**, 4 missed faces of 73, zero
false positives. Deployed - see M5.

**A decode bug was worth more than any of it.** Two thirds of every miss
(126 of 201) was a face the model HAD found and the decoder threw away: the
3x3 max-pool NMS keeps a cell only if it is the brightest within one cell of
itself, a radius frozen at 16 px however big the cube is, while the spacing
between a cube's three face centres shrinks with the cube. At 43 px per face
the centres sit ~1.8 cells apart and the stronger face's Gaussian is still
rising as it crosses the weaker face's own centre cell. Deduplicating on the
decoded quads instead, with a radius of half the kept quad's mean edge:
**missed 201 -> 77, F1 0.979 -> 0.989**, no retraining. `train/viz_nms.py`
draws the mechanism; `train/dump_failures.py` draws the failures themselves.

Foreshortening remains the weakest class (21.6% missed below 1/4 aspect,
down from 28.5%) and is the thing to attack next in M5/M8, not corner
accuracy.

---

## M4b — Two-stage detector ✅ (designed 2026-09-12, deployed 2026-09-13)

Not in the original plan; added when the single full-frame model's range
floor and portrait input were measured to be the bottleneck. Stage 1
(`cubebox`, `model/train/train_bbox.py`, dense head at 160x120, real IoU
selects best.pt) finds the cube's box in the frame; stage 2 (`facekp`,
`--head center`, 256x256) reads up to three anonymous face quads off the
padded box. Design and measurements: `model/PORTRAIT-DESIGN.md`,
`model/README.md` "Always two-stage". App side: `web/src/detect/twostage.ts`,
stage-1 ROI/heatmap overlays in the debug panel, stage-1 misses counted in
every capture.

**Done when (retro-fitted):** stage 2 on stage 1's box beats the full-frame
model on the held-out real photos, on a phone at >= 15 fps. Met: kpft1 on
the crop vs v4ft1 full-frame (README table), phone at ~15-20 detections/s
with inference in an ORT worker (COI service worker for wasm threads).

**Known limits (measured, not fixed):** a cube of ~80 px in a 640 frame is
~20 px in stage 1's input; against a grid-like background (plaid shirt,
keyboard, tiles) stage 1 collapses - batch 10 was labelled for exactly this
and took the held-out slice from IoU 0.56 to 0.86. The far/small/cluttered
case remains the weakest thing in the val set. Stage-1 misses are the main
cause of detection gaps in solve recordings; a fallback (run stage 2 on the
last box when stage 1 misses within ~0.5 s) is designed, not built.

---

## M5 — Real-data fine-tune ✅ (the loop is the product; 670 labelled frames as of 2026-09-14)

**Status (2026-09-14):** 670 hand-labelled real frames in ten batches
(`stephens_photos/batch*/`, 530 train in `model/data_real`, 140 held out in
`model/data_real_val`, val slices carved as contiguous time blocks for clip
batches). Both stages are trained with real data oversampled (`*80` for
stage 1, `*150` for the stage-2 fine-tune) and best.pt selected on the real
val split. The loop (`check_labels` -> `import_labels --source-prefix` ->
fine-tune ~15 epochs -> `export_*` -> commit) is documented in
`model/README.md` "M5 labeling workflow" and has run ten times; it is how
every new room, cube and camera angle gets absorbed. Deployed:
box17 + kpft8 (kp4 base). Real-photo corner error 3.84 px mean at the 256
input (~8 source px median), 8 of 280 val faces missed, 0 false positives
on cube-less frames.

The history below is kept because its decision (ship a per-batch
regression for a removed tail) is still the precedent for deploy gates.

### 2026-09-13: v4ft1 deployed over the gate (superseded by the two-stage models)

Hand-label 200–400 real frames (your two GANs, several rooms, both scheme orientations). Fine-tune. Re-export.

**Done when:** the detector finds faces on the M2 fixture frames without manual alignment.

**Status (2026-09-13, morning):** 199 hand-labelled real frames existed
(157 train / 42 held-out val, zero overlapping source photos - verified).
`runs/v4ft1` was exported and deployed to `web/public/models/` (fp32,
4.66 MB, replacing the legacy `ft7`); the two-stage models replaced it the
same evening.

**THE DEPLOY GATE WAS NOT MET AS WRITTEN, AND SHIPPING ANYWAY WAS A
DELIBERATE CALL (user, 2026-09-13).** The gate was "per-batch `real_px` no
worse than `ft7` on any batch". Mean px per batch on `data_real_val`:

| batch | ft7 (was deployed) | v4ft1 (now deployed) |
|---|---|---|
| batch1 | 2.91 | 3.51 |
| batch2 | 2.62 | 2.57 |
| batch3 | 3.34 | 2.67 |
| batch4 | 2.77 | 3.73 |
| batch5 | 43.57 | **2.95** |
| batch6 | 17.73 | **3.66** |

It regresses 0.6 px on batch1 and 1.0 px on batch4 while removing ft7's
catastrophic tail on batch5/6 (that tail is the legacy head's diamond
failure; ft7's p90 on real photos is 34 px against v4ft1's 4.9). Do not
"fix" this discrepancy by re-running the gate and reverting - it was
examined and accepted.

Investigated, so nobody re-derives it: batch1's regression is a single
outlier face (+6.58 px, a quad drawn 19% too large on a partly occluded
face); its median delta is -0.02, i.e. a tie. batch4's is real but uniform,
+0.90 median over 8 faces from 3 photos, quads drawn 3-7% too small. Ruled
out: memorisation by ft7 (train->val gap is comparable for both models),
file type, face size, and foreshortening. Most likely just the training
mix - batch4 is 11 of 157 real training photos while batch6 is 73, and the
fine-tune oversamples real data 150x. More batch4-like photos is the lever,
not a model change.

---

## M6 — Tracking + rectification in the app ✅ (phone-verified 2026-09-13)

Wire the detector into `web/`. Kalman filter on corners. Run detection every 2–3 frames, interpolate. Homography warp each face to 90x90. Feed rectified faces into the M1 sampling/classification path.

**Done when:** you can hold the cube at any angle and see the overlay stick to the faces smoothly; sticker colors populate without the fixed grid.

**As built:** alpha-beta filter per corner with the state kept at
measurement time (`detect/tracker.ts`); the view is delayed by the measured
detector latency so every overlay is drawn on the frame its corners came
from (`framering.ts`); detection cadence is adaptive; sampling runs in a
worker on detection frames only (`colour/sampler.ts`). Coasting tracks are
drawn dashed. The tracker follows *the quad at a place*, not a face: a track
survives re-grips and turns and can hop faces while the cube is rotated in
hand (measured on solve recordings, `docs/solve-tracking-design.md` 7).
Duplicate tracks on one face happen and are vetoed downstream.

---

## M7 — Any-order state assembly ✅ (redesigned and phone-verified 2026-09-13)

Center-sticker face identification. Use adjacency of co-visible faces to orient each face's 9 stickers correctly in the global frame. Per-sticker voting across frames. Lock on convergence + cubejs validation. Highlight low-confidence stickers for tap-to-fix.

**Done when:** you can scan a scrambled cube by just turning it around in view with no prompts, and get a valid state.

**As built - not as first written.** The first implementation (centre
exemplars naming faces, per-cell voting, `assembly.ts`) was taken to a
phone for a day and judged structurally fragile
(`docs/colour-pipeline-postmortem.md`); it was replaced the same day by the
evidence-log solver in `web/src/colour/` (`docs/colour-pipeline-design.md`):
every reading is logged with a quality weight, letter-free shared-edge
pairings link co-visible quads, and a worker solves the whole log as a pure
function - per-track robust aggregation, six-colour palette + per-frame
illumination fitted under the cube's constraints, tracks grouped into faces
with a co-visibility veto, letters and rotations from geometry, an exact
constrained decoder (nine per colour, distinct centres, legality search)
with a runner-up delta certificate. The lock fires only on the certificates.
Ensemble of colour embeddings (lab-norm default) after a dark webcam session.

**Evidence:** the phone locks real scrambles (the on-screen scramble + "I
applied it" box makes every capture its own truth); 12 evidence-log captures
in `web/test/fixtures/evidence/` replay through `colour-replay.test.ts`
(never answers wrong; the monitor-lit day-one capture is must-refuse); the
labelled photos double as a colour test set ("colour bank"). 268 tests.

**Still true:** the auto path refuses instead of guessing and has no
per-sticker override; tap-to-fix went with the grid scanner (2026-09-14)
and was dropped as a requirement 2026-09-19: a refused lock is rescanned.

---

## M8 — Hardening  🔶 (every item landed in some form; the real-room checklist has not been run)

- Glare handling: ✅ readings carry a glare weight (blown-to-white, clip
  fraction, censored channels); nothing is gated, everything is weighted.
- Hard-negative retraining with background grids: ✅ procedural grids in
  the generator, cube-less real frames imported as stage-1 negatives by
  default, Roboflow/COCO negatives for stage 1. Grid-like backgrounds
  (plaid, keyboard) still cost stage-1 recall at small cube sizes (M4b).
- Low-light behaviour: ✅ 2026-09-13 dark-scene pass - SNR (brightness)
  weight on readings, lab-norm embedding, exposure steering with a manual
  fallback, a "too dark" hint. Webcams drop to 15 fps in dim rooms, which
  halves everything downstream; light is still the cheapest fix.
- Graceful degradation: the grid scanner (M1) was removed 2026-09-14 when
  the scanner became the trainer's Scan tab (`index.html?tab=scan`,
  `ui/scanner.ts` mounted by `trainer-main.ts`; a lock hands the cube to
  the EO trainer in its own frame, `handoff.ts`). With no model file the
  tab says so and nothing scans.
- Performance pass: ✅ inference in an ORT worker (own worker; ort-web's
  proxy died under Vite), COI service worker for wasm threads, colour
  pipeline on detection frames only, adaptive detect/solve cadence, 12 Hz
  sampling cap. Field numbers from a mid-range Android are still not written
  down anywhere - do that.

**Done when:** it works in your kitchen, bathroom, and outdoors, on both GANs, and on a friend's stickerless cube.

**Status:** not verified as a checklist. Kitchen evening (M1 fixture) and
the desk/living room (batches 7-10) lock; outdoor clips exist for the
sticker cube (batch 8) as detector data only; bathroom and a third cube are
untested. Run the checklist with the scramble box ticked so each attempt is
a fixture, then close this.

---

## M9 — Cube in the loop ✅ (2026-09-19, desktop; the phone was dropped from the done-when. Design: `docs/smart-cube-design.md` 3)

Every consumer of moves (drills, follow mode, the live view, later the
timer and the analysis) takes a `MoveSource`; the smart cube, the camera
reader, the typed moves box and a capture replay are the four sources.
`web/src/smart/`: adapter over `smartcube-web-bluetooth` (MIT), the
two-clock timestamp fit, the belief vs the cube's own report, resync three
ways (solved / a scan lock / a fix alg), JSONL capture + replay. A live
view of the app's belief (3D + net, animated per move, source badge) in the
scan sheet's dock and as its own sheet. Drills fill their moves box from
the source, start the timer on the first turn and Check themselves when
`stage.ts` says the target holds.

Everything but the adapter's first run can be built before the cube
arrives (the camera reader as a source gives follow mode the live view
today). The cube has no gyro: the view is in the trainer's hold.

**Done when:** the i Carry E connects on the phone and on desktop Chrome;
each turn shows on the live view within ~100 ms; a deliberately drifted
cube is resynced from a scan lock; a captured session replays through the
tests; the EO drill completes itself from cube turns.

**Status (2026-09-16):** built and checked without the cube (design doc 3,
"Built"): a synthetic capture replays through the page and the EO drill
arms, boxes, times and checks itself; the Cube sheet draws the belief.
What remains is the cube's first run (design doc 8) on both devices.

**Done (2026-09-19):** the cube (GAN Gen4, `GANicE2` sw 2.9) connects
on desktop Chrome with no MAC dialog; the report latency measured on
camera is +5 ms after the layer comes to rest (`tools/solve/cube_latency.py`,
three recordings agree); 98 turns at speed lost none; a drifted cube
resyncs from its own report after a reconnect, and "Solved" resets the
cube's firmware state too (it had drifted on its own once). Two real
captures are fixtures (`web/test/fixtures/smart/icarrye-*.jsonl`) and
`smart.test.ts` replays them. The numbers are in the design doc's
section 8. The phone was not tested and is not planned (the cube is a
desk instrument).

---

## M10 — Timer and recording rig (design doc 4)

The "Solve" tab replaces csTimer: random-state scrambles, scramble
following with a misturn fix, inspection, auto start/stop, penalties,
ao5/12/50/100, PBs, a graph, IndexedDB sessions with the full move stream
per solve, csTimer import/export. On the desktop with the webcam on, every
timed solve records itself: `.webm` + evidence log + cube events on one
clock (capture v2, design doc 7). Once per cube and device: the cube's
report latency and skew measured on camera. `moves_fixture.py --truth
cube`. Then the first honest calibration of `web/src/moves/` over the
labelled recordings (turns read, false turns, gaps, timing error,
certificate calibration), written into `docs/solve-tracking-design.md`.

**Done when:** csTimer is retired with its history imported; twenty
solves exist as cube-labelled recordings; the reader's numbers are written
down.

**Status (2026-09-17): the timer half is built.** The Solve tab
(`web/src/timer/`): random-state scrambles from the solver worker
(prefetched), scramble following on a smart cube with the applied prefix
underlined and an off-track warning, inspection from the moment the
scramble is matched (WCA +2 / DNF), the first turn starts and solved
stops, beeps, next scramble by itself; Space for a dumb cube; sessions,
ao5/12/50/100, mo3, best averages, +2 / DNF / delete, csTimer import and
export. The store (`web/src/store/`): IndexedDB always, with an optional
Firestore sync (Google sign-in, per-user rules in `firebase/`, the SDK
loaded only when sync is on). Checked headless: a replayed capture arms
the timer at its own scramble, times the undo from the cube's stamps and
saves the solve with its turns. **2026-09-17, later:** the recording
rig's sink half is built and wired: the dev server's `/__recording`
route, the page's ordered stream and session layer (`web/src/rig/`,
`web/src/app/rig.ts`), and the scan sheet's Record streams video chunks,
the cube's events and the evidence log into `recordings/<session>/` when
the sink exists (the deployed site still downloads); the timer files each
solve's window into the session. Not yet: the latency calibration, the
fixture tool's cube truth, the reader numbers - all need the cube.
**2026-09-19:** the cube has arrived and csTimer's history is imported;
cube-labelled recordings are accumulating under `recordings/`. The
latency calibration is done (+5 ms, design doc 8); one Record button
records through the scanner and the dev server cuts a clip per solve;
`scripts/cube-fixture.ts` builds a reader fixture from a session with
the cube as truth and the palette fitted from the evidence (no lock).
The first such fixture says the reader cannot be calibrated yet: the
detector's quads on a desk solve are mostly hands
(`docs/solve-tracking-design.md` 10.2). Still open: twenty such
recordings (five exist), and the detector's hand problem before the
reader's numbers mean anything.

**Housekeeping before M11 - DONE 2026-09-17** (`docs/housekeeping-plan.md`
has the status; the list below is what was proposed): (1) wrap the camera
reader as a `MoveSource` and route follow mode through the same driver
the cube uses, so the drills and the timer can be fed by the camera and
M13 lands into one code path (half a day; the structural one); (2) rename
`smart/sync.ts` (the belief reducer) to `smart/belief.ts` so it stops
colliding with `store/sync.ts`, fold the three download helpers into one,
and move the frame relabel helpers out of `follow.ts` next to
`cube/frame.ts` (an hour); (3) split the wiring out of `main.ts` (scanner
bridge, smart cube + driver + live view, sync UI) into `app/*` modules
(an hour); (4) route drill attempts into the solve store instead of the
trainers' in-memory result arrays, which M11's per-case memory and M12
need anyway (an hour, plus a record shape decision); (5) check whether
`public/{scan,autoscan,bbox,detect,scanner}.html` are still used by the
tooling and prune the dead ones.

---

## M10b — Last-layer reference and voice trainer ✅ (2026-09-21, off the plan)

Not in M9-M13; built once the last-layer drills existed to hang it on.
`web/src/ll/`: a case reference sheet (pictures, algs with their triggers,
the chain from one case to its partner) with a star that makes any of a
case's algs the drill's main one (`favs.ts`, in the store, synced); a
voice (`hear.ts` parses the spoken answer: it reads the alg, or asks the
case and listens) that says an alg by its named chunks - a trigger, a
commutator, a conjugate - or move by move per chunk, as the settings say;
a repeat mode (the algs over and over from wherever the cube is, no
scramble); and per-case practice stats off the store's attempts. The
drill follows a smart cube's scramble the way the Solve tab does.

**Done when:** a case can be practised start to finish by voice with no
screen taps, and starred algs and per-case stats persist and sync.

---

## M11 — ZZ analysis and coaching (design doc 6.1)

`web/src/analysis/`, pure functions over a solve record, tested on
recordings: phase splits from `stage.ts` predicates (EO, EOCross, pairs
1-4 in solved order, OCLL, PLL, AUF) with time / moves / TPS / recognition
vs execution each; pauses located in phase and pair; EO and EOCross
compared to optimal for the scramble, pairs and last-layer algs to their
tables, executed alg identified up to AUF with misturns; case tagging into
a per-case memory; the bottleneck card against the user's own median;
trends per session. A replay scrubber over the live view.

**Done when:** every solve in the store shows its splits and the card,
and a week of solves has a trend line.

---

## M12 — Planning drills and cube-judged drills (design doc 6.2)

EOCross planning (unlimited timed inspection, optional declared plan,
judged: solved / moves vs optimal / planned vs executed / inspection vs
8 s), EOCross+1 (planned slot vs done, the transition pause), and
recognition vs execution per attempt in the four stage tabs feeding the
per-case memory.

**Done when:** a planning session's attempts are stored with their
verdicts and the stage tabs show recognition and execution separately.

---

## M13 — Video move model (design doc 5; start once M10 has a few dozen solves)

A twist head on stage 2 (which layer is mid-turn, which way, how far),
trained synthetic-first (the generator's layer twist opened to 0-90
degrees, motion blur, hands) and fine-tuned on cube-labelled frames,
consumed by the beam reader as one more evidence channel; the video-window
model is the fallback if the single-frame twist signal is too weak under
blur. Exported inside `facekp.onnx`, the camera becomes a complete
`MoveSource`, the cube goes in a drawer.

**Done when:** on held-out real recordings the reader with the twist
channel beats the M10 baseline on turns read, false turns and gaps, and a
phone follows a real solve without the cube.

**Started early (user, 2026-09-19), the synthetic half.** The first
cube-labelled fixture showed the detector's hand quads drown the reader
before M10's numbers mean anything, and the twist head sees the layer, not
the stickers. Built: the generator renders a layer mid-turn (0-90 deg,
motion blur by sub-frame accumulation, a hand on the layer; `--twist`),
labels carry a `twist` field, non-turning faces keep body-frame corners
(`model/README.md` "Layer twist"); `train.py --twist` adds the head (per
QUAD - none / self / which edge borders the turning layer - plus the angle
mod 90, since a single frame cannot tell +30 from -60), with metrics and a
round-trip check; `export_onnx.py` describes the channels in the sidecar
and the app's decoder ignores them until it reads them. 2026-09-20:
`tools/solve/twist_audit.py` scores a checkpoint's twist channel against
the cube's move log on any recording (design doc 5.3, "The measurement"),
so the plan-B question is answered by a run, not by labels. `data_v6`
is rendered (21k, 2026-09-20). **Handoff and work list:
`docs/twist-head-plan.md`** - train (`tw-ft1`, `tw1`), audit, then either
the app-side channel or the video-window model. Not yet: the run,
`facekp.ts` decoding the twist, the reader's twist channel, real mid-turn
labels (in progress, user).

**2026-09-20, later: the run.** `tw1`, trained from scratch on `data_v6`,
clears both bars (class F1 0.90, mean angle error 3.0°). Still not yet:
`facekp.ts` decoding the twist channel and the reader reading it, real
mid-turn labels for a fine-tune, and the app-side-channel vs
video-window-model call `docs/twist-head-plan.md` leaves open.

---

## Later / maybe (post-M8 — everything above stays 3x3-only until then)

- **Trainer extras, written down (2026-09-16), not now:** lookahead tools
  (metronome with adherence, TPS cap, pause flags, blind execution), LLM
  commentary over the abstract solve record (opt-in), alg spaced
  repetition and bigger last-layer sets (COLL / ZBLL), gestures on the
  cube. Catalogue with sizes: `docs/smart-cube-trainer-survey.md` 3. No
  social features. **Algs sheet shipped 2026-09-20** (`web/src/algs/`,
  the 📖 button, `?tab=algs`, a home-screen shortcut): the other puzzles'
  cheat sheet - 2x2 Ortega, 4x4 / 5x5 parities, centres and edges with
  pictures off an n×n model (`cube/nxn.ts`, every alg checked by test),
  Pyraminx / Skewb / FTO as text, checked once against cubing.js.
  Installable as a PWA since 2026-09-17 (manifest +
  icons; the isolation service worker satisfies the install check);
  offline caching of the app is NOT done and is the expensive half
  (precache ~35 MB of wasm and models inside the isolation worker, plus an
  update prompt) - do it only when the app must open with no network.

- **Timer extras csTimer has (written down 2026-09-17, not now),** in the
  order they would matter: ~~a time trend graph with the averages as
  lines~~ (shipped 2026-09-20: `timer/graph.ts`, the Graph button on the
  Solve tab) and a distribution histogram (~1 h); subset scrambles for timed sessions
  (EOCross solved, last layer only, EO solved) from a constrained
  random-state generator with parity tests (~3 h); a picture of the
  scrambled state for hand scrambles (net renderer exists, ~30 min); a
  previous-scramble button (matters more with next-by-itself, ~30 min);
  solve details (copy the scramble, edit a comment, the move list) and
  sessions renamed / deleted (~1 h); manual splits by Space for a plain
  cube (low: the cube, and later the camera, give splits). Not copying:
  inspection, the keyboard virtual cube, other puzzles, StackMat, online
  competitions, csTimer's cross / EOLine solvers (the trainer's do more).

- **Cube-pose fit - MEASURED 2026-09-13, scope narrowed.** Fitting a rigid
  cube (rotation + translation, focal fixed per camera) to the 2-3 detected
  quads does NOT sharpen corners: against hand labels the raw corners are
  2.97 px and the snapped ones 3.25, because the labels themselves only fit
  a pinhole cube to ~2.1 px - the model floor is at the detector's noise
  (same verdict as seam refinement). It DOES recover the cyclic order of the
  visible faces (26/26 photos right-handed with a visibility check against
  the Necker mirror) and gives a per-frame consistency residual that flags
  junk quads and merges duplicate tracks. Keep it for the solve tracker's
  anchoring, not as a corner refiner; no pose head at training time on this
  evidence. Tool and numbers: `tools/solve/cubefit.py`,
  `docs/solve-tracking-design.md` 9.

- **Other puzzles (2x2-5x5, Skewb, Pyraminx, Megaminx).** Surveyed in
  full 2026-09-17: `docs/other-puzzles-survey.md` (per puzzle, the
  `Puzzle` abstraction everything needs, training data, an order with
  estimates). The 2026-09-12 note below still holds for the cubes.

- **Other cube sizes (2x2–5x5).** Assessed 2026-09-12: the detector output
  (4 corners + visibility per face) is size-agnostic, and the grid checker
  generalizes to seams at 1/N (it can even infer N by counting seams). Odd
  cubes (5x5) keep fixed centers, so they're mostly "parameterize the
  generator, render mixed-N data, fine-tune" — plus per-size solver/validator
  libraries (cubejs is 3x3-only, and the facelet-string conventions with it).
  Even cubes (2x2, 4x4) have no reliable centers — center-color face identity
  (pipeline step 7, the model's six named output slots) is false there, so
  identity must be inferred globally from corner-piece constraints in the
  assembler: a real redesign of the identity/assembly layer, though not of
  the NN. The rotation-agnostic corner convention already points this way.

- **Solve coach (the long-term product) - IN FLIGHT.** Design:
  `docs/solve-tracking-design.md` (epochs between turns, move hypotheses
  scored against the locked start state's palette, belief sets, gaps
  recovered by a depth-3 search; 3 visible faces make every single move
  identifiable). Decided 2026-09-13: the reader runs *after* the solve
  (10 s later is fine) - a decoder over the whole recording with both
  endpoints known, not a live filter. Built so far: in-app solve recording
  (`Record` on scan.html: camera .webm + evidence log on one clock, `Moves`
  + "I applied it" for truth; solve mode keeps logging past the lock),
  headless clip replay, log survey, quad-over-video overlay, rigid-cube fit
  (`tools/solve/`). Measured on seven webcam solves: the natural chest-high
  face-on grip shows ONE face with fingers on 2-4 stickers and turns happen
  inside the hands; camera ABOVE and cube CLOSE shows 2-3 faces most of the
  time; after batch 10 a 28 s solve has ~4 sampled frames per turn and one
  detection gap. 2026-09-14: `web/src/moves/` built (design doc section
  10) - a beam Viterbi reader over the sampled frames with per-track
  face / rotation / illumination memory, a flat-cost occlusion veto,
  evidence-derived timing windows, bursts and certificates; reads the
  synthetic solve 20/20 at ~3 ms/frame live (solve worker, ticker in the
  result panel, trace in the debug panel); the two dim-room recordings
  are `hard` fixtures it cannot read (one lit face), so the next step is
  recordings from above and close with `Moves` truth, then calibration.
  2026-09-14 (late): **follow mode** shipped (design doc section 11) -
  with "follow my solve" on, the scan sheet docks in a corner after the
  lock, the reader runs live, `web/src/follow.ts` turns lock + read turns
  into the trainer's scramble and the stages advance as the cube crosses
  them (loaded once, at each boundary); the colour solver keeps re-reading
  the epoch since the last read turn, so pausing to show the cube re-locks
  it in full and a lock that disagrees with the reader replaces it. Runs
  end to end on recordings; the reader-driven switch awaits a real
  follow session in good light. 2026-09-21: the same follow on the smart
  cube, no lock needed (design doc 3.4, `app/cubefollow.ts`; a setting, on
  by default; the Solve tab chooses for itself - stay, or follow with the
  timer running underneath); `check-smart.mjs` replays a solve through EO
  -> F2L -> OCLL -> solved, a hand scramble, and a timed solve both ways.
  Hands are an occlusion mask, not a signal (design doc 8). The original sketch:
  phone camera watches a full solve;
  the app reconstructs the move sequence with timestamps, segments it into
  method phases (ZZ: EO / F2L / LL), computes objective metrics (move count,
  TPS, pause map, rotations), and hands that structured record — moves and
  numbers, never video — to an LLM with a well-crafted prompt for nuanced
  feedback. Move capture rides on M6–M8 tracking: read state between turns
  and diff; short occlusion/blur gaps are recoverable by searching the move
  graph between two cleanly-read states (few-move gaps have near-unique
  reconstructions). Programmatic layer computes facts (incl. solver-computed
  optimal-phase comparisons); LLM does interpretation — not the arithmetic.
  Note: an LLM call is a deliberate exception to "everything client-side";
  keep it opt-in and send only the abstract solve record.

- Scanning a cube mid-solve for a "where am I" trainer (a stepping stone to
  the solve coach).
- Offline PWA install.

## Maintenance ledger (2026-09-13 overnight pass; re-checked 2026-09-14)

Done: `model/ruff.toml` + `npm run lint` (ESLint, typescript-eslint) both
clean; `bbox_eval/common.py` replaces seven copies of the ONNX localizer
wrapper; `test/helpers.ts` replaces the duplicated synthetic-cube
projection and LCG in the vitest suites; `scan.html` replaces four camera
pages (`detect/models.ts`, `debug/dump.ts`, `debug/selftest.ts` hold what
each page used to carry); `check_targets.py` no longer samples overlapping
quads (decode dedup merged them by design); `import_labels.py` keeps
cube-less labels as negatives by default (`--drop-negatives` opts out).

Flagged, not fixed (each needs a decision or is out of scope for a night):

- **Legacy FC head** (`model.py keypoint_loss/pixel_error/conf_accuracy`,
  the `--head legacy` branch of `train.py`, `export_onnx.py`'s
  `faces` output, `facekp.ts`'s non-anonymous decode). Exists only so
  pre-2026-09-12 checkpoints load. Nothing trains it; ~300 lines across
  both trees. Delete once `v4ft1` is no longer a reference number.
- **Two colour paths: resolved 2026-09-14** by removing the grid scanner
  and its k-means assembly (`state.ts assembleState` and friends, their
  tests and grid-capture fixtures). One path remains: the evidence-log
  solver (`web/src/colour/`). `identify.ts` survives only for the overlay's
  face colours and the hint text.
- `bbox_eval/roboflow_audit.py` needs a full-frame stage-2 checkpoint; kept
  as the record of the audit, will not run against the crop model.
- `check_labels.py` still flags opposite faces both visible as a *problem*
  (it did again for batch 10's `w00021`); with the anonymous head it is only
  a slot-naming slip. Downgrade to a note.
- `facekp-decode.test.ts` is coupled to the deployed model: the fixture is
  re-dumped on every export (`dump_decode_fixture.py`). Fine as a parity
  gate, but a red suite between export and dump is expected, not a bug.
- `bench_local.py` trips ruff F821 (the `del` at the end of `run()` makes
  the closures look unbound); suppressed per-file in `ruff.toml`.
- `_has_bars` / `_has_side_bars` in `bbox_data.py` detect letterboxing by
  an exact pad value on one row/column. Correct for the uint8 caches, but
  would silently stop firing if the pad colour ever changed.
- The `export_onnx.py` int8 path is still gated off (dynamic quantization
  shifts corners ~24 px); fp32 ships. Static QDQ calibration is the fix.
- **Solve logs are not colour-solver fixtures.** `colour-replay.test.ts`
  picks up every file in `web/test/fixtures/evidence/`; a solve recording's
  log mixes states and belongs in `web/clips/solves/` (gitignored) until
  `moves-replay.test.ts` exists.
- **Sampling stops at the lock** by design; solve mode (`?solve=1`, or while
  recording) is the exception. The first three solve recordings logged
  nothing after the lock because of this.
- `watch.py` parsed epoch lines with a fixed regex and never charted a
  stage-1 run (fixed 2026-09-14, generic key-value parsing); `train_bbox.py`
  now writes `meta.json` like `train.py`.
