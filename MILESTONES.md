# MILESTONES.md

Each milestone ends with something you can run on a phone. Don't start the next one until the "done when" holds.

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

## M3 — Synthetic data generator

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

## M4 — Face keypoint model

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

## M5 — Real-data fine-tune  🔶 (fine-tuned and DEPLOYED 2026-09-13; the deploy gate was overridden - read below)

Hand-label 200–400 real frames (your two GANs, several rooms, both scheme orientations). Fine-tune. Re-export.

**Done when:** the detector finds faces on the M2 fixture frames without manual alignment.

**Status (2026-09-13):** 199 hand-labelled real frames exist (157 train /
42 held-out val, zero overlapping source photos - verified). `runs/v4ft1` is
exported and deployed to `web/public/models/` (fp32, 4.66 MB, replacing the
legacy `ft7`).

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

## M6 — Tracking + rectification in the app  🔶 (code complete 2026-09-12, awaiting phone verification via /scan.html)

Wire the detector into `web/`. Kalman filter on corners. Run detection every 2–3 frames, interpolate. Homography warp each face to 90x90. Feed rectified faces into the M1 sampling/classification path.

**Done when:** you can hold the cube at any angle and see the overlay stick to the faces smoothly; sticker colors populate without the fixed grid.

---

## M7 — Any-order state assembly  🔶 (code complete 2026-09-12: orient.ts + assembly.ts + autoscan page; awaiting phone verification)

Center-sticker face identification. Use adjacency of co-visible faces to orient each face's 9 stickers correctly in the global frame. Per-sticker voting across frames. Lock on convergence + cubejs validation. Highlight low-confidence stickers for tap-to-fix.

**Done when:** you can scan a scrambled cube by just turning it around in view with no prompts, and get a valid state.

---

## M8 — Hardening  🔶 (glare rejection, cube-less hard negatives in generator, grid-mode fallback done 2026-09-12; real-room checklist + low-end perf pass pending)

- Glare handling: drop samples where L is saturated, weight votes by confidence.
- Hard-negative retraining with background grids.
- Low-light behavior.
- Graceful degradation: if detection confidence stays low for N seconds, offer the M1 grid mode.
- Performance pass on a low-end phone.

**Done when:** it works in your kitchen, bathroom, and outdoors, on both GANs, and on a friend's stickerless cube.

---

## Later / maybe (post-M8 — everything above stays 3x3-only until then)

- **Cube-pose fit (geometry tier 2 — DO after the two-stage detector lands,
  per user 2026-09-12).** Fit a full rigid cube (rotation + translation +
  rough focal, ~6-7 DOF) to all tracked corners by Gauss-Newton on
  reprojection error, then read idealized corners off the fitted cube.
  Gives: perfect shared-vertex consistency (supersedes the tier-1 fusion in
  orient.ts fuseSharedCorners), occluded-corner prediction, pose-level
  tracking instead of 12 independent corners, and the mid-turn machinery
  the solve coach needs (mid-turn = pose fit + one rotated layer). Gate it
  with the seam veto like faces are gated today.

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

- **Solve coach (the long-term product).** Phone camera watches a full solve;
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

## Maintenance ledger (2026-09-13 overnight pass)

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
- **Two colour paths.** The grid scanner (M1) classifies with
  centre-seeded k-means over six captured faces (`assembleState`); the auto
  scanner names each detected face from centre exemplars (`identify.ts`)
  and then hands the per-sticker medians to the same `assembleState`. The
  building blocks are shared (`normalizeFaceCells`, `CENTER_MIN_DIST`,
  `kmeans`, `validateState`), the *decision* is made twice. Unifying means
  the grid scanner naming faces from exemplars too - a behaviour change to
  the proven fallback, so not done unattended.
- `bbox_eval/roboflow_audit.py` needs a full-frame stage-2 checkpoint; kept
  as the record of the audit, will not run against the crop model.
- `check_labels.py` flags opposite faces both visible as a *problem*; with
  the anonymous head it is only a slot-naming slip. Downgrade to a note.
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
