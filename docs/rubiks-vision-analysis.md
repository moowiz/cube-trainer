# rubiks-vision: analysis of a comparable project (2026-09-13)

Source: https://gitlab.com/gillis.oldfeldt/rubiks-vision-public (MIT, one
author, last touched 2026-08-04, ~19k lines). Live demo:
https://rubiks-vision.pages.dev/. Clone it into a scratch directory to read
the code; file paths below are relative to that clone. Nothing from it is
vendored into this repo yet.

This document is for agents working on this repo: what that project does,
how it differs from ours, what is worth taking, and what is not. The verdict
is at the end; the recommended actions are concrete and ordered.

## 1. What it is

Same target as ours: a browser-only Rubik's cube scanner on onnxruntime-web
(WebGPU, wasm fallback), no colour setup, outputs a validated 54-facelet
string. Three parts:

- `packages/rubiks-vision/` - the scanner as an npm package (runtime).
- `example/` - a Preact demo app (HUD, tap-to-fix net, session recorder).
- `training/` - Blender/Cycles synthetic data + ultralytics yolo11n-pose
  training + a PyTorch colour-model trainer. `CONVENTIONS.md` at the root is
  the shared geometry contract between TS and Python (worth reading on its
  own: face frames, facelet formula, the 24 rotations, label format).

Two ONNX models ship in the package:

- `cube-pose-384_a8b.onnx` (16 MB, fp32): yolo11n-pose, one class "cube",
  **54 keypoints = every sticker centre**. 384 input on WebGPU, 320 on wasm.
- `scanner_t320_sliced_fp16.onnx` (24 MB, fp16): a 12-layer d=256
  transformer that reads the 27 visible stickers (deskewed 32x32 patches)
  jointly and emits per-sticker colour logits plus a *discovered* 6-colour
  palette. No colour scheme is fed.

## 2. Architecture side by side

| | rubiks-vision | ours |
|---|---|---|
| Detector | whole cube as one object, 54 sticker-centre keypoints | two-stage: cube box (stage 1) + per-face anonymous 4-corner quad (stage 2) |
| Symmetry in the loss | min over the **24 cube rotations** of the 54-point relabelling (`training/symloss.py`) | min over the 4 cyclic shifts of a face quad - same idea, smaller group |
| Geometry per frame | full 6-DoF PnP (Levenberg-Marquardt) on the 54 points; a 24-fold "gauge" (which physical face is which) is held by tracker continuity | per-face homography to a 90x90 canvas; orientation from shared edges + tracker carry |
| Colour | learned transformer over all 27 patches, slot attention discovers the palette per frame | Lab k-means / ordinal clusters + centre exemplars, no model (`web/src/detect/colorid.ts`) |
| Evidence | per-slot accumulated log-probs; "windows" (fixed view + segment) glued by a joint search over 24 rotations x 720 colour permutations (`seedEvidence.ts`) | frame-level votes keyed by colour cluster, consensus after re-alignment (`web/src/assembly.ts`) |
| Final decode | exact min-cost assignment with 9-per-colour + distinct centres, then 2-swap legality search, plus a "delta certificate" (`exactDecode.ts`) | `assembleState` -> `resolveByPieces` (greedy bounded flips) -> `validateState` |
| Validation | own `validateState` (piece existence, corner chirality, twist, flip, parity) | same rules, `web/src/state.ts` |
| UX contract | hold a corner-on 3-face view and turn slowly; **1- and 2-face views get no colour and no overlay** | any face order; dead-on single faces allowed; M1 grid fallback |
| Camera | 1280x720 ideal, sampling canvas capped at 640 wide, `requestVideoFrameCallback` | 640x480 |
| Training data | Blender Cycles + Poly Haven HDRIs + a GAN356 CAD replica + ISP degradation stack + near-miss distractors; **synthetic only**, no real-photo fine-tune | Three.js headless (54k) + hand-labelled real photos (the biggest single win we measured) |
| Model budget | ~40 MB, no phone fps reported | facekp is small; measured 60 fps wasm on the user's phone |

Philosophically the two designs are the same: the detector is deliberately
gauge-free (it may output the cube/face in any symmetric relabelling) and
orientation is resolved downstream by continuity and evidence. The real
difference is granularity - whole cube vs per face - and everything else
follows from that.

## 3. What the whole-cube pose buys them, precisely

**Within a continuous track, sticker identity is geometry, not colour.**
Once a 6-DoF pose exists, every visible sticker projects to a fixed physical
slot. Face orientation falls out of the pose for free, and which face is
which never depends on reading the centre colour. That removes two bug
classes we have paid for in `web/src/assembly.ts`: in-plane rotation mixing
between frames (the "frames, not cells" rewrite, DECISION 2026-09-13), and
the centre-colour -> whole-face cascade (one ambiguous red/orange centre
misfiles nine stickers). Their colour errors stay per-sticker.

Fine print, all verified in the code:

- **It only holds within a track.** On every re-acquisition the 24-fold
  gauge is lost. They glue the new segment to the old one by colour-evidence
  overlap: a search over 24 rotations x 720 colour-column permutations
  scored by agreement with committed evidence. Across a track break they are
  doing what we do, with a bigger search (`seedEvidence.ts`, 924 lines).
- **They refuse the views we support.** `seedScanner.ts` feeds colour only
  when `visibleFaces(pose).length === 3`; the overlay paints nothing on 1-
  or 2-face views because the pose is ambiguous there (4-fold and 2-fold) -
  exactly as it is for us. They solved dead-on faces by forbidding them.
- **The 54 interior points are what make edge-on views tractable** (their
  stated reason for moving from 8 corners to 54 centres), and occluded
  points are predicted *through* with lower confidence and kept in the fit,
  weighted. This is the mechanism behind their robustness, not the PnP.

## 4. What the complexity costs them

`pose/poseTracker.ts` is 2390 lines with ~50 tuned constants: tracking
tiers (FULL / PARTIAL / POSITION / LOST) with multi-frame hysteresis, a
parallel always-on "continuous estimator", separate display and capture
poses, focal-length sweeps, seeded re-acquisition. All of it exists because
a single rigid pose has to survive every frame of hand-held video, and a
wobble of a few degrees flips which of 24 gauges the evidence lands in.
`seedEvidence.ts` then exists to repair what the tracker could not hold.
The comments record the failures that forced each piece ("one margin-2.8
merge -> coverage locked at 27/54 with 48 self-reinforcing boundaries").

Plus 40 MB of models that must download on a phone, and a 12-layer
transformer per accepted frame; they publish no phone frame rate. Our bar
(CLAUDE.md) is >=15 fps end-to-end on a mid-range Android on wasm. Expect
their stack to miss it.

## 5. The exact decoder, explained (`exactDecode.ts`, ~300 lines, pure)

This is the single most portable piece, and it is exactly item 3 of
`web/src/color-notes.md` ("9-per-colour turns classification into
assignment... Hungarian if greedy isn't enough") already built.

**Input.** A 54x6 matrix `conf[slot][colour]`: per sticker slot, how much
evidence says it is each of six abstract colour ids 0..5. (Colour -> face
letter is decided last, from the centres.)

**Step 1 - costs.** `C[s][c] = -log(conf[s][c] / rowSum)`, floored at 1e-9
so nothing is infinite. Cost 0 = certain, ~0.7 = 50/50, ~20 = "definitely
not". Costs add across slots, so "most likely cube" = "cheapest
assignment". An unobserved slot is an all-zero row: free to be anything,
the constraints decide it. Per-slot argmin is the naive answer (what a
nearest-centroid classifier does) and happily yields 10 reds and 8 oranges.

**Step 2 - exact balanced assignment.** Constraints: exactly 9 of each
colour, and the six centre slots (4, 13, 22, 31, 40, 49) carry six distinct
colours. Centres and non-centres decouple (each colour owns exactly one
centre whatever the bijection, so the other 48 slots always need exactly 8
of each colour):

- centres: brute-force the 720 permutations, keep the cheapest;
- the 48 others: a min-cost transportation problem (48 sources of 1 unit,
  6 sinks demanding 8 each, edge cost `C[s][c]`), solved exactly by
  successive shortest augmenting paths (`transport()`). Milliseconds.

This is where "looks red, but red already has 9 confident members"
resolves itself: a tenth red claimant evicts whichever current red is
cheapest to move to orange - the most ambiguous one, by
`C[s][orange] - C[s][red]`. No thresholds. It is the pairwise "compare the
two ambiguous patches to each other" intuition enforced over all 54 at
once, which also attacks white-vs-yellow and the monitor-light
white-vs-blue limit.

**Step 3 - legality.** Nine-of-each can still contain a non-existent corner
(red-orange-white), a duplicated edge, a twisted corner, or a parity
violation - the `validateState` rules. So they search outward from the
balanced optimum for the cheapest assignment that *is* legal:

- a move is a 2-slot colour swap (preserves the counts for free; swaps that
  collide two centres are skipped);
- the cost delta of a swap is exact and local:
  `C[i][a[j]] + C[j][a[i]] - C[i][a[i]] - C[j][a[j]]`;
- from each state generate the 120 cheapest of the 1431 swaps;
- best-first search (min-heap on total cost, `seen` set), capped at 30,000
  pops. Because pops come off in nondecreasing cost, **the first legal
  state popped is the cheapest legal cube reachable** - the answer moves as
  far from the raw evidence as it must and no further.

`changed` = slots that differ from the naive argmax. Their gate:
`changed > 4` -> "scan looks unreliable, rescan".

**Step 4 - delta certificate.** Keep popping (up to 12,000 more) until a
*second* legal cube appears; `delta = cost(second) - cost(best)`. That is
"how wrong would the evidence have to be for a different cube to be the
real one". Near zero = two legal cubes fit almost equally (typically a
red/orange or white/yellow pair) - the case a scanner should refuse rather
than guess. In the shipped code `DELTA_ABSTAIN_FLOOR = 0` because they had
only two calibration points; the gate is designed but not armed. `legal`,
`changed <= 4` and the alignment margins do the real work.

**Step 5 - letters.** The colour on the U centre is "U", etc. Centres are
distinct by construction, so this is a bijection; output is a 54-char
URFDLB facelet string.

**Versus ours.** `assembleState` -> `resolveByPieces` is a greedy version
of steps 2-3: cluster, name, then flip a bounded number of stickers until
validation passes. The differences: the 9-per-colour constraint is enforced
exactly and globally rather than repaired afterwards; the legality search is
ordered by evidence cost so the fix it picks is the most plausible one, not
the first found; and it produces a confidence number instead of pass/fail.
The input contract (54x6) is something `StickerVoter` can produce from its
per-cluster votes once clusters are named (`nameClusters` in
`web/src/detect/colorid.ts`). Note the aliasing case: several clusters may
map to one colour; sum their votes into that colour's column.

## 6. Other pieces worth taking (all separable from the pose architecture)

**Quality gates before evidence goes in** (`seedScanner.ts`,
`color/sampler.ts`). Colour is fed only from frames that are 3-face,
square-on (`scannability >= 0.42`, i.e. the weakest visible face's
view-dot clears 0.35 and ramps to 0.50), slow (`angularSpeedDeg <= 90`),
not freshly re-acquired (`tracker.recovered` veto), and sharp
(variance-of-Laplacian `blurScore >= 40`, ~40 lines). Comment: "everything
else poisons the accumulation on real video." We gate on detector
confidence; blur and motion gates are cheap and target our phone-clip
smears.

**Sampling tricks in their classical path** (`color/sampler.ts`):
- centre stickers: sample four patches offset +/-0.22 of a cell and take
  the median - dodges the logo;
- speculars: drop the brightest decile of pixels before the per-channel
  median instead of a hard threshold (a hard 250/250/250 cut is applied
  too);
- per-face von Kries white balance anchored on the brightest
  low-saturation patch (white is the only near-neutral colour on a cube),
  chroma factors clamped to [0.6, 1.4] so a bad anchor cannot wreck
  saturated colours.

**Evidence-commit discipline** (`seedEvidence.ts` header comments). Their
lessons match ours, phrased more sharply: commit a window's placement only
when best - second-best margin clears a floor (`COMMIT_MARGIN_MIN = 10`,
provisional floor 5); never re-derive a committed decision (an anchor switch
folded two faces together live); keep un-anchorable windows *pending* and
out of the merged evidence rather than merged at a guess; a junk window of
< 8 frames may never become the anchor; stitching across a relabel is
fail-closed. The margin-based commit is the cleaner formulation of our
vote-gated adjacency.

**Runtime engineering** (`ort.ts`, `detect/detector.ts`, `camera.ts`,
`seedScanner.ts`):
- wasm: `ort.env.wasm.proxy = true` (session in a worker so the main thread
  keeps painting) and `numThreads = min(hardwareConcurrency, 8)`. Both need
  `crossOriginIsolated` (COOP/COEP headers). We run `numThreads = 1` on
  GitHub Pages because it cannot send those headers
  (`web/src/detect/facekp.ts`). A `coi-serviceworker` shim injects them
  client-side and works on Pages - measure phone fps with it.
- code-split ORT: literal `import("onnxruntime-web/webgpu")` vs
  `import("onnxruntime-web/wasm")` so only one chunk ships (24 MB vs 11 MB
  of wasm).
- WebGPU probe calls `adapter.requestDevice()` and destroys it, not just
  `requestAdapter()`: blocklisted GPUs return an adapter but no device and
  ORT then aborts mid-load with a bare numeric error.
- `createImageBitmap(video)` once per frame; run detection and colour
  sampling on that same bitmap and paint it to the presentation canvas, so
  overlay and samples are frame-exact.
- HEAD-check the model URL's content-type: Vite's SPA fallback returns
  200 + HTML for a missing `.onnx`.
- `replayUrl`: feed a recorded clip through the *live* pipeline, looping,
  with a wrap guard that resets the tracker (the frame teleports). We have
  phone clips (batch 7); an in-browser replay harness turns them into
  end-to-end regression tests.
- `requestVideoFrameCallback` with a rAF fallback (older iOS Safari has no
  rVFC and the pipeline never runs without the fallback).

**Training diagnostics** (`training/symloss.py`). `perm_wins`: a 24-bin
histogram of which relabelling won the min each epoch, logged as "n/24
perms used, top: ...". A healthy run exercises many bins. Our 4-shift
version would show whether the anonymous-quad head actually uses its
freedom or one shift dominates (a label-direction bias).

**Synthetic data** (`training/synthgen/`):
- `isp_post.py`: a label-safe, pixel-only, pure-numpy phone-camera stack -
  auto-exposure anchor -> motion blur -> downscale/upscale softness ->
  chromatic aberration -> **4:2:0 chroma subsampling** -> luma-dependent
  sensor noise -> JPEG round-trip. `model/train/augment.py` has blur, noise
  and JPEG; chroma subsampling and chromatic aberration are missing and
  both plausibly matter for colour edges.
- `distractor_builder.py`: near-miss negatives - single-colour rounded
  boxes, 2x2 cubes, 4x4 checkerboard cubes, stacked books, dice, post-it
  stacks. A shopping list for stage-1 false positives beyond our tiles and
  keyboards.
- `train_scanner.py` `color_aug`: the same per-sample white-balance /
  exposure / gamma / saturation transform is applied to the patches *and*
  the reference palette, with a severity continuum so near-neutral is
  densely covered. That is how a colour model learns constancy. "SATURATION
  IS NOT AN IDENTITY" - no pastel classes; pastel is desaturation aug.
- geometry-aug bans: no flips at all (a mirror is not a cube rotation), no
  rotation, no perspective; multi-scale comes from the affine scale gain +
  mosaic inside the fixed train size, never from varying the input size.
  Make sure our augmentation never mirrors a quad.

## 7. Things not to copy, and why

- **The 6-DoF tracker.** See section 4. The payoff (section 3) only holds
  within a track and requires forbidding 1-/2-face views.
- **The learned colour model as-is.** Their finding (`train_discover_real.py`
  docstring): "clustering fails because shading/glare smear colours
  together; a network that understands the cube's global lighting can pull
  them apart" - 97-98% per frame, palette discovered per frame. It is the
  full realisation of our relative-classification idea. But it is a 24 MB
  transformer; it needed colour-family-balanced renders (pastel / neon /
  dark / muted / lowcon / brand / warm / cool families with a mixture
  prior) plus the constancy augmentation above; and its palette row order
  turned out to be view-dependent ("cold read"), which forced the whole
  window / re-anchoring machinery. If we ever train a colour model, the
  recipe is documented there; the architecture is `Scanner` in
  `train_scanner.py`. Not now.
- **"Synthetic only" training.** Contradicts our measured 58 -> 4.6 px
  from 22 real photos. Their yolo11n is COCO-pretrained end to end
  (backbone and head plumbing), which likely narrows the sim-to-real gap
  more than our ImageNet MobileNetV3-Small does. Not evidence to drop real
  data.
- **The model budget.** 40 MB is not acceptable on a mid-range phone over
  mobile data, and CLAUDE.md's fps bar rules out yolo11n + a 12-layer
  transformer on wasm.
- **The delta gate as shipped** is unarmed (floor 0). Do not cite it as a
  calibrated abstain.

## 8. Verdict

Keep the per-face architecture. Most of what makes their scans lock cleanly
is separable from what makes their code complex - roughly 80% of the value
for ~5% of the code. The one genuine architectural gain (geometric sticker
identity within a track) removes bugs we have fought, but only for corner-on
views, and there are cheaper routes to most of it that keep dead-on
single-face scanning alive:

1. when 2-3 quads are in frame, fit a cube pose *from our quads* (we already
   match shared edges in `web/src/detect/orient.ts`; a rigid fit adds a
   consistency check and yields all three orientations at once);
2. add 9 sticker-centre outputs per face to the anonymous-quad head. No
   relabelling: centres follow from the quad by homography for synthetic
   and hand-labelled data alike. A 13-point homography with per-point
   confidence is more finger-tolerant than 4 corners, and that is where
   their edge-on robustness really comes from.

If phone testing shows tracker-carried orientation on dead-on frames is what
keeps breaking locks, the right fix is their UX rule (ask the user to show a
corner), not their architecture. That is a product decision and it is cheap.

## 9. Recommended actions, in order

1. Port `exactDecode.ts` (MIT) behind `StickerVoter` as the lock step, fed
   by a 54x6 matrix built from per-cluster votes after `nameClusters`; keep
   `validateState` as the legality oracle. Add a blur gate
   (`blurScore`-style) and a motion gate in front of the voter. Run on the
   existing fixtures first (`web/test/fixtures/`).
2. Try `coi-serviceworker` on Pages; measure phone wasm fps with threads.
3. Log a 4-bin "which cyclic shift won" histogram per epoch in
   `model/train/train.py`.
4. Add chroma subsampling + chromatic aberration to `model/train/augment.py`;
   add their distractor kinds to `model/gen/` negatives.
5. In-browser clip replay for the batch-7 phone clips.
6. Later, if orientation remains the failure point: quad-based cube fit,
   then sticker-centre outputs on the quad head.
