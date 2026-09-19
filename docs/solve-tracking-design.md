# Watching a solve: design thoughts (2026-09-13)

Status: the reader exists (`web/src/moves/`, 2026-09-14, section 10) and
reads the synthetic solve end to end, live and offline; on the two recorded
solves it reads the first turns and then drifts, for reasons the diagnostics
name (one lit face). Sections 0-9 are the design as written before it, kept
as the record of why; section 10 says what was built, where it departs, and
what the numbers are. Written while the 16-point grid head trained. Read `colour-pipeline-design.md` first; this builds on its
evidence log and solver and does not repeat them. The product goal is the
"solve coach" entry in `MILESTONES.md` (Later): the phone watches a solve
and produces a move record with timestamps. This document is about the
move record only - phase segmentation, metrics and any LLM layer sit on top
of it and are not discussed.

## 0. The idea in one paragraph

The current pipeline assumes the cube never changes: one append-only
evidence log, one solve over all of it. A solve breaks that everywhere
(after an `R`, cell 2 of a track is a different sticker), so the log has to
be cut into **epochs** - stretches during which the cube is rigid and
static - and the solver run per epoch. The thing that makes this tractable
is that we never read a mid-solve state from scratch: once the start state
is locked, the state after each epoch is `previous · m` for a short move
sequence `m`, so the per-epoch problem is not "which of 6^54 colourings"
but "which of 18 moves (or 270 two-move, 4050 three-move sequences) best
explains the two or three faces I can see". That is a hypothesis test
against an already-fitted palette, it needs only a handful of frames of
evidence per epoch, and it has a natural certificate (cost margin to the
runner-up). Watching the layer physically turn is a secondary cue for
timing and tie-breaking, not the primary reader - fingers cover the
turning layer exactly when it moves.

## 0.1 Not live (decided 2026-09-13)

The move record does not have to appear while the solve happens. The
phone records (camera stream + evidence log, `Record` on scan.html) and the
reader runs afterwards; a result **ten seconds or so after the last turn is
fine**. Everything below is to be read with that in mind:

- The reader is a **decoder over the whole recording**, not a filter. The
  belief set of section 2.3 is propagated forward *and backward*; an epoch
  that is ambiguous on its own is settled by later evidence, and a move
  is recorded when the smoothed belief clears the margin, not when the
  frame arrives.
- **Both endpoints are known.** The start state is the lock; the end state
  is solved (or a later lock). Every hypothesised sequence must connect
  them, which prunes gaps far harder than depth-3 search alone.
- Heavier per-epoch work is allowed: sequence priors (section 8), flow on
  the rectified faces, re-reading selected frames from the recording at
  full resolution. What is *not* allowed is a second full detector pass
  over the video on the phone: at ~15 detections/s live, re-detecting a
  60 s solve costs ~60 s. The live log is the input; the recording is
  consulted for chosen frames.
- Perf budget (2.1, 6) is therefore about the *live* log's density, not
  the reader. The reader runs in the solve worker, once.
- Still client-side: the recording never leaves the phone.

## 1. Is the state even observable from what the camera sees?

Measured with cubejs (`scratch: observ.cjs`, `gaps.cjs`; 300 random states,
300 last-layer states built from OLL/PLL algs, 300 F2L-ish states; the two
scripts are trivial to re-create from this description):

| visible faces | single move: indistinguishable from "no move" | single move: two moves with the same visible outcome | states with any single-move ambiguity |
|---|---|---|---|
| U F R (corner-on grip) | 0 / 5400 | 0 / 45 900 pairs | **0 / 300** (random, LL and F2L alike) |
| U F (two adjacent) | 6 / 5400 | 9 / 45 900 | 15 / 300 random, 2 / 300 LL |
| F R | 5 / 5400 | 7 / 45 900 | 11 / 300 |
| U only | 909 / 5400 | 941 / 45 900 | 300 / 300 |

Visible stickers changed per move: mean 8.6 with three faces, 5.7 with two,
minimum 1-3. Every face turn moves stickers on four adjacent faces, so
any two adjacent visible faces see every turn including the hidden
faces' (a `D` turn shows in F's and R's bottom rows; a `B` turn in U's top
row).

Gaps (several moves between two clean epochs), canonical sequences with no
two consecutive turns of the same face, 60 random states each:

| gap length | sequences | visible U F R: outcome shared with a sequence reaching a *different* state | visible U F |
|---|---|---|---|
| 2 | 270 | **0.0 %** | 0.3 % |
| 3 | 4050 | **0.1 %** | 1.3 % |

(The raw "outcome shared with another sequence" rate is 20 % / 36 %, but
almost all of it is commuting moves - `U D` and `D U` reach the same state.
That is an ordering ambiguity in the move *record*, not a state ambiguity,
and it is resolved by timing or left as `[U D]` unordered.)

Conclusions that shape everything below:

- **Three visible faces make single moves unambiguous, always.** The
  corner-on grip is the natural one for most of a solve, and it is also
  the pose the detector is weakest on (foreshortened third face, see
  `model/README.md`). Third-face recall matters more for this feature
  than for scanning.
- **Two faces are almost enough; one is useless.** With one face visible
  the app must say "I can't see enough" rather than guess.
- **Gaps of up to three moves are recoverable** by searching the move
  graph from the last certain state - the state, not necessarily the
  order. Beyond three the search still works (18·15^k, ~60 k at depth 4)
  but the visible evidence stops pinning the answer and the honest output
  is "N moves happened here, unrecorded".

## 2. What changes and what does not

Unchanged and reused as-is: detector, tracker, sampling, reading weights,
the evidence-log format, the colour embeddings, the palette and
illumination fit, the exact decoder (for the start state), `validateState`,
cubejs move application.

New, all under `web/src/moves/` and all pure functions of the log so the
replay test remains the development surface:

```
EvidenceLog  --segment.ts-->  epochs [{frames [a,b), transition in/out, tracks}]
             --anchor.ts--->  per epoch: visible quads -> 54-slot addresses
                              (orientation from centre colours, corner order by min cost)
             --hypo.ts----->  candidate states {previous · m} for |m| <= L
             --score.ts---->  cost(state | epoch evidence, fixed palette) per candidate
             --record.ts--->  MoveRecord: moves with t0/t1, margins, gaps, belief sets
```

### 2.1 Epoch segmentation (`segment.ts`)

A transition is a stretch of detection frames during which some layer is
moving. Three signals, all already in the log or one line away:

1. **Track deaths and births in a burst.** The detector is trained on
   rigid faces; a face whose top row is sliding is a bad quad, the tracker
   loses it and re-acquires a new track when it stops. `TrackEvent` already
   records this. Cheap and strong, but late (the death registers after
   `COAST_MAX_MS`).
2. **Residual jump per (track, cell).** Each epoch's per-cell aggregate is
   a robust median; a CUSUM on the residual of new readings against it
   fires when three or more cells of one track jump together (a row or
   column - an adjacent face turned - or the whole face minus centre - the
   face itself turned). This is the precise timing source: it fires on the
   first post-turn frame, ±1 detection frame.
3. **Motion weight collapse.** `speed` and `blur` in `QuadObs` already
   zero the reading weights during the turn; a run of near-zero-weight
   frames on an otherwise steady track is a transition candidate.

Rule: an epoch is closed when signal 2 fires on any track or signal 1
fires on two tracks; frames from the last clean frame to the first clean
frame after are the transition and get weight 0 for every track. Epochs
shorter than `MIN_EPOCH_FRAMES` (2) are merged into a gap (section 2.4).

Speed budget: a 4-TPS solver turns every 250 ms; at 15 detections/s that
is ~3 frames per epoch, of which one may be the transition. **Solve mode
must run the detector every frame**, not every 2-3 as scanning does, and
the 60 fps interpolation matters less than the 15-20 fps of real
detections. This is the perf item to measure first on the phone.

### 2.2 Anchoring visible quads to slots (`anchor.ts`)

After the start lock the palette is frozen (`Commitments`) and the state's
centre colours are known, so naming is a lookup, not the geometric
letter-recovery of the static solver:

- **Orientation** of the cube in the frame: each visible quad's centre
  cell reading, classified against the frozen palette, gives its letter
  directly (centres never move under face turns). Two visible centres fix
  one of the 24 orientations; one centre plus the pairing geometry fixes it
  too. Whole-cube rotations (`x y z`) therefore cost nothing: they change
  which tracks exist, not the state, and the next epoch simply re-anchors.
- **Corner order** of a track (its unknown rotation `k` in 0..3): not
  resolved separately - folded into the hypothesis score as `min over k`,
  exactly as the training loss does. With 8-9 stickers of evidence per
  face the wrong rotations cost far more than the right one.
- Output per epoch: for each of the 54 slots, the aggregated
  `(value, n_eff)` from whichever tracks were anchored to it, or nothing.

Slice moves (`M E S`) and wide moves are two face turns plus a rotation;
since rotations are free, the hypothesis set is the 18 face turns and the
record can re-express `R L'` + `x'` as `M'` later if timing shows them
simultaneous.

### 2.3 Hypotheses and scoring (`hypo.ts`, `score.ts`)

- Belief: a **set** of candidate states with weights, not a single state.
  It starts as `{locked start}` and after each epoch is
  `{s · m : s in belief, |m| <= L}` re-weighted by evidence and pruned.
  L = 1 in steady state, grown to 2-3 only when no depth-1 candidate
  explains the epoch (section 2.4).
- Score of a candidate = sum over observed slots of the per-slot cost of
  the candidate's colour under the frozen palette - the same 54x6 cost the
  decoder already computes, restricted to the slots this epoch saw.
  Illumination gain per frame is still fitted (it is cheap and the light
  changes as the hands move).
- Certificate: cost margin between the best candidate and the best
  candidate with a *different state* (commuting-order duplicates are the
  same state and share the entry). A move is **recorded** when the margin
  clears `MOVE_MARGIN` and the winning candidate's changed slots were
  actually observed with `n_eff >= 2` (a move whose evidence is "nothing
  visible changed" is not evidence of that move - it is evidence of no
  move on the visible faces, and the hidden alternatives stay in the
  belief).
- The identity hypothesis (no move) is always in the set; false
  transitions (a hand passing, a re-grip that kills tracks) resolve to it
  at zero cost.
- Ties on visible slots (rare, section 1) keep both states in the belief;
  the next epoch that shows a differing slot collapses it. The record
  shows the span as "one of {R, R2}" until then.

### 2.4 Gaps

When an epoch has too little evidence (occlusion, blur, two turns inside
one frame interval) it is merged with its neighbours into a gap, and the
next clean epoch is scored against depth-L sequences from the belief,
L rising 1 → 2 → 3 until a candidate clears the margin. Cost is small
(4050 sequences × ≤27 observed slots, in the solve worker). At depth 3
with three faces visible the *state* is determined 99.9 % of the time
(section 1); the record stores the recovered sequence with its order
flagged wherever moves commute, and the gap's timestamps as a span.

If nothing clears the margin at depth 3 the belief is declared lost: the
record gets an "unrecorded, >= 4 moves" span, the UI asks for a clean
view, and a fresh full read (the existing scanner, all six faces) re-seeds
the belief. That is the honest failure and the one to count in testing.

### 2.5 Timing

`t0` of a move = the transition's first frame (signal 2 above), `t1` =
first clean frame after; resolution one detection frame (~50-70 ms).
Pauses are the epochs themselves. For TPS-style metrics this is enough;
finer timing would need the mid-turn geometry of section 4.

### 2.6 The record

```ts
interface MoveRecord {
  start: string;                     // locked facelets
  items: ({ kind: 'move'; move: Move; t0: number; t1: number; margin: number }
        | { kind: 'unordered'; moves: Move[]; t0: number; t1: number }   // commuting, order unknown
        | { kind: 'gap'; minMoves: number; t0: number; t1: number }      // unrecorded
        | { kind: 'reseed'; facelets: string; t: number })[];
  end: string | null;                // facelets if the belief is a singleton
}
```

Everything downstream (phases, metrics, any LLM prompt) consumes this and
nothing else. Uncertainty is in the record, not hidden.

## 3. Hard cases, and what handles each

| case | what happens | handled by |
|---|---|---|
| Fingers cover the turning face during the turn | those frames are the transition, weight 0 | 2.1; nothing is read mid-turn by design |
| Last layer: U is one colour, only the side stickers of the top layer change under `U` | 3-6 visible stickers still change (section 1: LL states have zero single-move ambiguity with three faces) | 2.3 scoring on the observed slots |
| Re-grip / whole-cube rotation without a move | all tracks die, new ones are born on other faces | identity hypothesis; re-anchor from centres (2.2) |
| Two turns in one frame interval (fast TPS) | epoch too short → gap | 2.4 depth-2 search, 0 % state ambiguity |
| Long occlusion (cube dropped, out of frame) | depth 3 fails | declared lost, reseed (2.4) |
| Only one face visible (cube held flat to the camera) | nothing distinguishes most moves | UI: "tilt so I see two faces"; belief carries every hypothesis, collapses on the next good epoch |
| Red/orange under warm light | same slots contested as in scanning | the frozen palette was fitted on the full start scan; per-slot cost is soft, margin certificate refuses rather than guesses |
| Wrong start lock | every subsequent epoch scores badly | a run of epochs where no depth-1..3 candidate clears the margin is the signature; fall back to reseed and flag the start |

## 4. Mid-turn geometry: secondary, later

The "cube-pose fit + one rotated layer" item in MILESTONES (fit a rigid
cube to all corners, then a single layer angle) would give the turning
layer and direction directly and sub-frame timing. It is the right *second*
source: it breaks the rare visible-slot ties (an `R` vs `R'` both changing
the same slots to different colours is already distinguishable by colour;
what geometry adds is `R` vs `R2` when the R face is hidden - the layer
angle at the last visible frame). It should not be the primary reader
because the layer being turned is the one under the fingers, and because
it needs the detector to keep reporting a face while it shears, which it
is not trained to do (and should not be - a sheared face is a bad quad for
colour). Do it after 2.1-2.4 exist and only if the gap rate measured on
real solves says single-frame epochs are common.

## 5. What to build first, and how to test it without a phone

1. **Synthetic solve fixture** (`test/moves-synthetic.test.ts`): a cubejs
   random state, a random 20-move sequence, the existing synthetic evidence
   generator (`test/helpers.ts`, `colour-synthetic.test.ts`) producing 2-5
   frames per epoch from 2-3 visible faces with realistic noise, dropped
   frames and occlusion, and a transition of 1-2 garbage frames between
   epochs. The reader must return the sequence (up to commuting order) with
   every move above the margin. This is the primary development loop;
   it exists before any phone time.
2. `segment.ts` + `anchor.ts` + `hypo/score.ts` + `record.ts` in the solve
   worker, depth 1 only.
3. **Phone capture with truth**: the debug capture already holds the whole
   log; add an "I applied: <alg>" field (the scramble checkbox pattern)
   and drop captures into `test/fixtures/evidence/` - `moves-replay.test.ts`
   picks them up. Ten short real captures (3-6 moves each, corner-on grip,
   then two-face grip, then a deliberate fast burst) are the calibration
   set for `MOVE_MARGIN` and the gap rate.
4. Gaps (2.4), belief sets, the record's unordered/gap items.
5. UI: solve mode toggle after lock; a move ticker; "tilt so I can see two
   faces"; the lost/reseed prompt. Detector every frame in this mode.
6. Only then: mid-turn geometry (section 4), if the numbers ask for it.

## 6. Open questions

- Detector every frame at ≥15 fps on the target phone with the two-stage
  pipeline: measured on 2026-09-13's perf pass? If not, the epoch budget
  in 2.1 is the first thing to re-plan.
- How often does the tracker actually drop the turned face vs. keep a
  wrong quad through the turn? Decides whether signal 1 or 2 leads.
- Per-frame sampling placement is the noise floor for thin epochs (2-3
  frames get no temporal averaging). The 16-point grid head was tried the
  same day and did not move it (`model/README.md`, cell-centre error 2.58
  vs 2.69 px); the floor is kpft3's ~2.6 px at the 256 crop, ~11 source
  px, ~7.6 in the far bin.
- Whether to keep scanning and solve mode as one session (start lock →
  moves) or let the user start mid-solve with a fresh six-face read.
  The record format supports both via `reseed`.

## 7. What the first three recorded solves taught (2026-09-13, evening)

Three full solves recorded in the app (`Record` on scan.html: the camera
stream as `.webm` plus the evidence log on the same clock; solve mode keeps
logging past the lock). Desktop webcam, 640x480, backlit by a window, the
cube ~110-130 px across; ~30 s of scanning to the lock, then 28-34 s of
solving each, ending solved. Clips and replay logs live in
`web/clips/solves/` (gitignored); tooling in `tools/solve/`
(`replay_clips.py` drives headless Chrome, `survey_log.py` summarises a log,
`overlay_log.py` draws the tracked quads on the video frames - the last one
is what actually answered the questions below).

Numbers over the solve stretch of each clip (detector on ~27 of 30 fps):

| clip | frames with a cube | 1 / 2 / 3 faces | gaps > 0.25 s | median epoch | second face viewCos |
|---|---|---|---|---|---|
| 1 | 71 % | 67 / 27 / 6 % | 10 (median 0.57 s) | 0.73 s | 0.50 |
| 2 | 72 % | 62 / 25 / 13 % | 10 (0.53 s) | 1.77 s | 0.48 |
| 3 | 44 % | 65 / 26 / 9 % | 18 (0.67 s, max 2.0 s) | 0.55 s | 0.50 |

What this says, against the assumptions in sections 1-3:

1. **The natural grip shows one face.** Camera at chest height looking up,
   cube held facing the solver: the front face is square-on, the second
   face when present is the bottom or top at viewCos ~0.5, three faces
   appear only during a deliberate tilt (clip 1, 50.1-50.6 s: a clean
   corner-on view, tracked perfectly for half a second). Section 1 says
   one face is useless and two adjacent are nearly enough; the recordings
   sit at the useless end. **Camera placement is the first lever**, not
   the solver: a phone propped ~45 degrees to the side and above the cube
   sees U F R for most of a solve without the solver changing their grip.
   Measure that before building anything in section 2.
2. **Fingers cover 2-4 stickers of the visible face at all times** (thumbs
   along the bottom row, fingers over the top row), and the quality
   weights do not know: a finger reads as a plausible sticker with w ~0.2-
   0.7 (the survey counts a median 7-8 "readable" cells per quad; the video
   shows 4-6). Skin is warm and low-chroma and will pass for orange or red
   under the frozen palette. **An occlusion term is needed before per-slot
   costs mean anything** - either a skin/non-sticker classifier on the
   patch (chroma + texture + the patch's distance to the six palette
   colours) or a per-cell "matches no palette colour" veto in the scorer.
3. **Turns happen inside the hands.** Most turns produce no detection gap
   at all (a `U` flick leaves the front quad still; only the top row
   changes, under the fingers). The ~10 gaps per solve are re-grips, where
   both hands wrap the cube for 0.3-0.9 s and every track dies; there is no
   mid-turn geometry to observe (section 4 is moot for this grip). So
   signal 1 (deaths/births) marks re-grips, not moves; signal 2 (residual
   jump) has to carry the moves, and it fires on the very cells the fingers
   sit on. With the front face square-on, a `U` shows as 3 stickers of the
   top row changing - the same 3 stickers a thumb crosses.
4. **A track is the quad at a place, not a face.** Track #87 in clip 1
   survived a re-grip and a turn (49.5-52.4 s); tracks in the scanning
   phase lived 6-7 s while every face was shown in turn. Anchoring (2.2)
   must re-run per epoch from the centre colour and must not carry a
   track's identity across an epoch boundary.
5. **Noise floor.** Consecutive-frame per-cell Lab distance within a
   track: p50 2.9, p90 14, p95 28, p99 70 - a heavy tail from fingers,
   glare and quad slips. A per-cell CUSUM at 18 Lab over 3-frame windows
   fired 87 times in 26 s of *scanning* (no moves). The residual detector
   in 2.1 needs robust window medians over 5+ frames and a persistence
   requirement, or it will call a move on every finger.
6. **Mid-turn junk quads exist** (clip 1, 51.4 s: a wide rectangle fitted
   to the sliding top layer). They are one or two frames long and low
   conf; the transition weighting in 2.1 should also drop quads whose
   aspect ratio or area jumps from the track's running median.
7. Epoch budget (2.1) holds on desktop: 0.5-1.8 s median epochs at 27
   detections/s. Unmeasured on the phone; still the first perf item.

Truth: none of the three has per-move truth (scramble not applied, no
moves typed). The `Moves` field and `I applied it` exist for the next
round; the scripted 3-6 move takes from section 5.3 are still the
calibration set to record, **with the camera at the side-above angle**.

### 7.1 Fourth recording: camera side-above (2026-09-13, late)

Webcam raised to look down at the cube in the lap: the view is right (U F R
legible together in most still frames) but the detector collapsed - faces
in 13 % of frames on replay, stage-1 objectness p50 0.35 (37 % of frames
>= 0.5), one face when anything. Causes, all domain: cube ~80 px in the
640 frame (~20 px in stage 1's 160x120 input), a plaid shirt behind it in
every frame, tungsten light with the webcam at 15 fps and motion blur.
Live cadence was not the problem. Response: batch 10 = 59 stills from the
clip in `stephens_photos/batch10/` (extract_frames --dup 0 --long-side 640;
the whole-frame duplicate hash kills small-cube clips) to label and
fine-tune both stages on; and a runtime fallback worth measuring - when
stage 1 misses while a track died < 0.5 s ago, run stage 2 on the last
padded box anyway. Cheaper still: cube closer to the camera, more light.

### 7.2 Fifth and sixth recordings, and the batch-10 detector (2026-09-14)

Clip 5 (camera above, cube close, plain background, 30 fps) with the old
detector: 71 % of ticks found the cube, faces per frame 14 / 55 / 30 % -
the regime section 1 assumes, so camera placement is settled: **above and
close**. Clip 6, a 28 s solve in the same setup at 15 fps (dim room), live
with the old detector vs replayed with box17 + kpft8 (batch 10 labelled from
clips 4-5):

| | old (box13 + kpft7) | new (box17 + kpft8) |
|---|---|---|
| frames with a face | 133 (4.7/s) | 232 (8.1/s) |
| faces per frame 1 / 2 / 3 | 39 / 38 / 23 % | 3 / 27 / 71 % |
| gaps > 0.25 s | 20, 13.1 s of 28.5 | 1, 0.3 s |
| stage-1 misses | 29 % of ticks | 4 % |

With the new detector this solve has ~4 sampled frames per turn at ~2 TPS
and essentially no detection gaps, so the epoch budget of 2.1 holds even at
15 fps. What has not changed: corner precision, ~10 % of the edge against a
rigid-cube fit on these blurred 100 px faces (the side faces visibly
overshoot the silhouette), and the finger occlusion of section 8. The
reader's inputs are now: dense, three-faced, imprecise, partly covered.

## 8. Hands: occlusion, not a signal (2026-09-13)

Section 7 shows the fingers cover 2-4 stickers of the visible face at all
times and every turn happens inside the hands. Three ways to deal with it,
in the order to try them:

1. **Fingers as an occlusion mask (do first).** A per-cell veto: a patch
   that is warm, low-chroma, textured and matches none of the six frozen
   palette colours is *unknown*, not the nearest colour. Then the epoch's
   evidence for a slot is the **union over its frames**: the fingers shift
   between turns, so across a 0.7 s pause more stickers get exposed than in
   any one frame (4-6 per frame in the recordings; likely 7-9 per epoch).
   Cheap, and a prerequisite for every per-slot cost in 2.3 meaning
   anything. Test: the survey's "readable cells" must drop to what the
   video shows.
2. **Sequence prior (the offline lever).** A solve has grammar: cross,
   F2L pairs, one of 57 OLLs, one of 21 PLLs, with AUFs between. An
   n-gram / alg-library prior over move sequences (from reconstruction
   corpora or a CFOP program's solutions) is the language model to the
   colour evidence's acoustic model, and with both endpoints known (0.1)
   the decoder is a beam search over sequences scored by evidence x prior.
   It resolves the one-face ambiguities of section 1 that the evidence
   cannot. Person-specific only in the method; no training on the user.
3. **Row/column flow on the rectified face.** A 90 degree turn at 30 fps
   spans ~6 frames; on the 90x90 warp the turning row/column shears while
   the rest is still. 2D flow on the warp gives which layer of the visible
   face moved and which way - section 4's mid-turn geometry at row level
   without a 3D fit. Fingers weaken it on the top/bottom rows; partial rows
   still carry direction. A tie-breaker for `R` vs `R'` vs `R2`, and a
   timing source.
4. **Hand pose (last, if ever).** Browser hand landmarkers exist, but two
   interleaved hands around a 60 mm object with one half hidden is their
   worst case, and landmarks are not moves: mapping finger trajectories to
   `U'` is per-solver (finger tricks differ) and needs labelled moves to
   learn from - a smart cube's move log would be that truth. Weeks for an
   uncertain, person-specific reader. Only as a direction/layer
   tie-breaker once 1-3 exist and the numbers say it is needed.

Underneath all four: the camera angle (section 7, item 1). Side-above
placement turns most of the one-face epochs into two- or three-face ones
and is free.

### 8.1 Hand pose: measured (2026-09-15)

Summary and the moves-from-clips question: `docs/hand-pose-experiment.md`.
Item 4 was an assumption; `tools/solve/hands_survey.py` tested it. MediaPipe
HandLandmarker (1.0.1, `hand_landmarker.task`, two hands, VIDEO mode, CPU)
over the eight webcam solve recordings, landmarks aligned with each replay
log by `recording.startedAt`; overlays in `web/clips/solves/hands-*.mp4`.

| clip | setup | fps | both hands | one | none | longest two-hand run |
|---|---|---|---|---|---|---|
| 1789348802837 | chest height, face-on | 30 | 89 % | 10 % | 0 % | 40 s |
| 1789348884643 | chest height, face-on | 30 | 72 % | 27 % | 1 % | 20 s |
| 1789348960376 | chest height, face-on | 30 | 70 % | 20 % | 10 % | 31 s |
| 1789360474064 | far, dim (cube ~55 px) | 15 | 79 % | 21 % | 0 % | 6 s |
| 1789361029992 | hands low, cube ~110 px | 30 | 9 % | 82 % | 9 % | 1.1 s |
| 1789367308690 | far, dim (design clip 6) | 15 | 0.5 % | 99.5 % | 0 % | 0.1 s |
| 1789369770950 | hands low, cube ~90 px | 30 | 17 % | 83 % | 0 % | 1.3 s |
| 1789448465141 | above and close, cube ~150 px | 30 | 50 % | 26 % | 25 % | 3.1 s |

Latency 13-14 ms/frame on the desktop CPU (Python; the browser build would
be the same order on a desktop GPU and several times that on a phone, on
top of our own detector). Handedness labels are stable (flips < 1 % of
matched hands except 4 % on the far clip); the one hand it finds is found
continuously (single runs of 30-65 s).

What the overlays show:

- **The hand it tracks is the one whose palm faces the camera** (your
  left, image right). Its skeleton wraps the cube plausibly. **The hand
  whose palm is behind the cube - thumb on the front face, fingertips
  over the top - is the one that is missed**, and that is the hand doing
  the turning. In the clips with the hands low, the second hand is found
  in 9-17 % of frames; above and close, 50 %.
- Lowering all three confidences to 0.2 raises the second hand to 16 / 55
  / 67 % on those three clips, but part of the gain is phantoms (a 0.53
  hand at the frame edge) and where the hand is real its finger geometry
  is only roughly right: the thumb, the one finger that matters, is
  rarely on the sticker it is actually on.
- Close in (13 s of the last clip: fingers filling the left third of the
  frame, palm hidden) the detector returns nothing at all.
- **Occlusion mask value is real but partial.** Cells under a tracked
  finger (palm polygon, or within 0.14 palm-widths of a finger segment)
  get lower reading weights than uncovered cells in every clip (mean 0.13-
  0.23 vs 0.20-0.42), yet 13-53 % of covered cells still carry w > 0.3:
  the "finger reads as a sticker" failure of item 1, made visible. But the
  mask only exists for the hand it finds, and the thumb it places worst
  is the one over the front face.
- **Not a turn signal as-is.** Fingertip speed relative to the cube centre
  gives 1-4 bursts/s at median length one frame, against ~1 move/s - the
  landmark jitter (median fingertip motion 4-8 px/frame while the hands
  are at rest) is of the order of a turn. No recording has typed moves yet,
  so nothing finer could be scored.

Verdict: item 4 stays last. The landmarker cannot see the turning hand
often enough to be a layer/direction tie-breaker, its per-frame cost is
the whole phone budget, and the one thing it does deliver - a partial
occlusion mask - is what item 1 gets from the colour statistics for both
hands at no cost. Re-measure only if the camera setup changes to one that
shows both palms, or if a recording with typed moves shows the colour
evidence alone cannot separate `R` from `R'`.

## 9. Rigid-cube fit: measured (2026-09-13, late)

`tools/solve/cubefit.py`: fit a 6-DoF cube pose (fixed focal length) to the
2-3 quads of one frame, correspondence unknown (which quad is which face,
cyclic start, winding: every assignment through a linear scaled-orthographic
fit, the best few refined by perspective Gauss-Newton, mirror poses rejected
by face visibility). Measured on the replay logs and, with truth, on the
kpft7 `diagnose.py --dump` of `data_real_val` (81 photos with 2-3 faces).

- **It does not sharpen corners.** Against hand labels the raw corners are
  2.97 px median (256 input), the cube-snapped ones 3.25. The truth quads
  themselves fit a rigid pinhole cube only to 2.1 px RMS (label clicks,
  rounded vertices, principal point of the crop), so the model floor is at
  the detector's noise and averaging cannot beat it. Same conclusion as the
  seam refinement (`seam-refine-no-gain`): the error is model-px-bound.
  Corners meet at the shared vertex (an inset for the corner radius makes
  the fit worse), so `matchSharedEdge`'s assumption is right.
- **It does recover the geometry.** 26/26 three-face photos come out as a
  right-handed vertex triple (the 3 that disagree with the label names are
  labels whose names are not a right-handed triple - a differently coloured
  cube or misnamed faces; the truth quads fit their "mirror" at 1.0 px). So
  the cyclic order of the visible faces - which one is on top given which is
  in front - is available from geometry alone; the letter still comes from
  the centre colours, as the pipeline does. A pose per frame is therefore
  a sound anchor (2.2) and merges duplicate tracks on one face (dedupe by
  centroid in the tool).
- **Solve-clip detections are ~3x noisier than photo detections.** On the
  val photos the predicted quads fit a cube at 2.0 px RMS median (~1.5 % of
  a face edge); in the solve replays 7-9 px at 120 px edges (6-7 %):
  webcam, motion blur, dim light, fingers. The fit residual is a usable
  per-frame consistency weight and false-face veto, but nothing in these
  clips reaches the photo quality the corner numbers in `model/README.md`
  describe. Expect cell-centre error in solves to be 2-3x diagnose.py's.
- Not worth a training-time pose head on this evidence (section "2." of the
  three levels in the discussion): the per-face corners are not wrong in a
  way a rigid constraint repairs. Revisit only if a stride-4 corner head
  changes the noise picture.

## 10. Built (2026-09-14): `web/src/moves/`

```
moves.ts    the 18 face turns as facelet permutations (checked against cubejs),
            canonical sequences (18 / 243 / 3240: each state once per commuting class)
anchor.ts   Anchorer: per frame, per quad -> face + rotation k + readings + weights,
            with per-track memory (below); quadCost / frameCost
reader.ts   MoveReader: beam Viterbi over frames, push() per frame, record() any time;
            forcedAlignment() for calibration; formatTrace()
record.ts   MoveRecord / RecordItem, formatAlg(), formatItems()
```

Tests: `test/moves.test.ts`, `test/moves-synthetic.test.ts` (the design's
5.1 fixture: 20 random turns through 2-3 faces with fingers, drops,
re-grips, garbage frames; a two-face read; a burst; a fingered cube that
never moves; a slipped move), `test/moves-worker.test.ts` (the live
protocol), `test/moves-replay.test.ts` (recorded solves from
`test/fixtures/solves/`, built by `tools/solve/moves_fixture.py`). Live:
after a lock in solve mode the page starts the reader in the solve worker
(`track`), the worker anchors and decodes each frame as it is appended
(`moves` polls return the record), the result panel shows the ticker (sure
turns bright, tentative dimmed with `?`) and the debug panel the last
frames of the trace; the capture carries `moves`.

### 10.1 Where it departs from sections 2-4

- **No epoch segmentation step.** The reader is a Viterbi decoder over
  the sampled frames: the hidden state is the cube, a frame boundary
  either keeps it (cost 0), takes one turn (`moveCost`, 6 nats), or a
  burst of two or three (`+burstExtra`; three only after a gap over 500 ms
  or when no shorter candidate explains the frame). The path that
  minimises evidence + turns IS the segmentation; a hand passing costs
  every hypothesis the same. Beam of 24 states; depth-2 bursts from the
  top 4. The belief set of 2.3 is the beam.
- **Timing windows from the evidence, not from where Viterbi put the
  transition:** t0 = the last frame that showed the cube without the
  turn, t1 = the first that showed it with it (0.5 nat test either way);
  transitions whose windows overlap are one burst, `ordered` false when
  any two of its turns commute. Per-frame placement inside a window is
  arbitrary and is not reported.
- **Certificate** per epoch = the cheapest complete path in the final beam
  that was in a different state at the epoch's last frame, minus the
  chosen path (all evidence counted, the future included); when nothing in
  the beam disagrees, the beam's width. A turn is `sure` when that clears
  `marginMin` (3) AND a later frame confirmed it - a turn read on the very
  last frame never is (the synthetic solve bought a phantom L2 there).
- **Anchoring keeps per-track memory** (a track is the quad at a place,
  7.4): the face from the centre colour (decayed vote over the track's
  centres) or, when the colour cannot say, from the pairing geometry with
  a face that can; the rotation k from pairings when there are any, else
  from the track's first three frames against the reader's leading state,
  and then FROZEN - a U turn on a lone top face is only visible as its
  content rotating under a fixed k (the first version let k float per
  frame and could not see it).
- **Illumination per track, not per hypothesis.** A face turned from the
  light reads at a fraction of the palette's chroma (0.4-0.7 on the lit
  top face, 0.2 on the sides of the dim recordings) plus a shift, so each
  track carries an affine chroma map (s, t) estimated by a robust fit
  under the leader's colours (taken when it explains >= 5 cells and 60 %
  of those seen, EMA over frames) and used for every hypothesis alike.
  Fitting per hypothesis was tried and is wrong twice over: skin passed as
  orange at s = 0.35, and any hypothesis could shrink the palette out from
  under the cells that contradicted it. A per-frame white-balance shift
  (grid search + median refinement over the last second's readings, prior
  towards zero) sits underneath: the camera's AWB follows the hands in by
  20+ units.
- **The veto (8.1) is a flat cost, not a zero.** A cell the outlier class
  wins costs at most `outlierCost` (2 nats) whatever colour is claimed -
  the same for every hypothesis, so a finger votes for nothing - but never
  nothing, so contradicting cells cannot be explained away.
- **Reading weights are session-relative** (median reading weight -> 0.5,
  capped at 1): the scan solver's convergence weights are 0.02-0.2 on a
  dim webcam and the move cost is in nats of evidence. A per-track
  reliability factor (EMA of the share of cells the illumination fit
  explains, floor 0.3) scales a face the hand covers or the light does
  not reach.

### 10.2 Numbers

Synthetic solve (`moves-synthetic.test.ts`, 83 frames): 20/20 turns, every
one certified (margins 6-35), timing inside the garbage frames; the
two-face read 12/12 with one commuting pair unordered; the burst as `(U
F')`; the fingered, re-gripped, never-moving cube: nothing read, margin >
3. Speed: anchoring ~1.2 ms/frame (the shift grid search), decode ~1.8
ms/frame, live protocol 3.2 ms/frame - a 15 fps solve costs ~5 % of a
desktop core; the record follows a turn within 3-4 sampled frames.

Recorded solves (fixtures `solve-1789369770950-live-kpft8`,
`solve-1789367308690-replay-kpft8`, both marked `hard`): the reader gets
the first turns (`U U` = U2, then the B2 as two quarters) and drifts. The
forced alignment of the assumed truth (the cubejs solution the app showed)
says why: per frame the truth beats its single-move neighbours 13x, ties
49x and loses 103x on the live one. Looked at with the overlay tool, the
cube is ~60 px across and far, the room dim, the top face lit and readable
(affine fit: 7-9 of 9 cells within 3 sigma, s 0.6-0.7, t +20 in b) and
the front face under the fingers with 2-4 cells left; the side faces read
grey (s 0.2 under ANY state, 2-4 inliers). Section 1's "one face is
useless" is then the whole story: U vs U' on a lone face is a 180 degree
ambiguity of the track's rotation, the yellow-face turns are invisible,
and the truth itself is unverified (it assumes the displayed solution was
followed exactly; the two phone sessions of the same morning each slipped
one move). Decode 2.3-3.5 ms/frame on 100-150 frames.

**The first cube-labelled solve (2026-09-19, fixture
`2026-09-19-105604-04`, `scripts/cube-fixture.ts`):** a 60 s desk solve
on the webcam, cube ~130 px across, evenly lit, both hands on it; 110
turns from the GAN with their send times; the palette fitted from the
evidence alone (six colours named), the start state from the cube, no
lock. The reader reads 110-odd turns and reaches nothing like the end
state (margin 1.0, the end state not in the beam). The forced alignment
of the TRUE sequence says the frames do not support it either: per
frame the truth beats its single-move neighbours 33x, ties 91x, loses
403x. The reason is upstream of the reader, in the evidence: of the
1386 quads the detector produced in the window, **473 are hands**
(six or more of nine cells read as skin), 643 are mixed and only 270
are clean faces; 12 frames in 636 show two clean faces at once. Even
on the solved cube held still at the end, the frames carry one real
face (uniform yellow) beside two or three hand quads, and the quality
weights barely tell them apart (mean 0.29 vs 0.23). So the honest
baseline for the camera reader on a real desk solve is: **not
measurable yet** - the face detector's false quads on hands drown the
signal, and the reader cannot be calibrated until the evidence is
mostly faces. That points the next work at stage 2 (hand negatives,
a quad-quality score that rejects skin) and at the twist head of
section 5, which sees the layer, not the stickers, before the reader's
own parameters. The builder audits every fixture the same way
(`audit` in the file; printed when it is built).

## 11. Follow mode (2026-09-14): the trainer moves along with the cube

What the reader is *for* in the app today. With **follow my solve** ticked
on the scan sheet (the default), a lock does what it always did - the
stage the cube is at opens with it loaded - and then the sheet shrinks to
a corner dock (camera view, the believed cube as a net, the turns read,
Stop) instead of closing, the camera keeps watching, and the reader runs
live in the solve worker from the lock's commitments. A few times a
second `web/src/follow.ts` turns *lock + turns read* into a trainer-frame
scramble (the lock's scramble, then the read turns relabelled into the
trainer's letters - the same physical turns, other names) and asks
`stage.ts` where that cube is; once the stage has changed on two polls in
a row the next stage opens with the cube at hand loaded (F2L shows the
pairs you actually have, OCLL / PLL the case you actually reached), and a
solved cube is announced with the turn count and time. A stage is loaded
once, at the boundary: its picture is the case, not a live mirror; the
live mirror is the net in the dock.

**Two sources of progress, either one enough.** The reader is one. The
other is the colour solver itself, which keeps running after the lock on
the current **epoch** - the evidence sampled since the last turn the reader
read (`solve` with `fromT`; the worker filters its log). While you turn,
epochs are a second long with two faces in view and nothing locks; when
you pause and show the cube around, the epoch locks the full state. A lock
that agrees with the reader's believed cube (compared by colour, so the
letters need not match) confirms it; one that disagrees is the truth from
there: the reader restarts from the new commitments and the stage is routed
again, exactly as a first lock is. So when the reader loses the cube - a
run of one-face frames, a re-grip it could not follow - the fix is to show
the cube for a couple of seconds, which a solver pauses to do anyway.
Measured on the synthetic scan-turn-scan log (`test/follow.test.ts`): the
whole log spanning the turn does NOT lock ("no legal cube within budget"),
the epoch since the turn locks the turned cube - the window is what makes
the re-read possible.

Status: the plumbing runs end to end on the two newest recordings in
headless follow mode (lock at 10.7 s, dock, no exceptions), but neither
clip has turns after its lock under good light, so the reader-driven
switch has still only been exercised synthetically. The first real test is
a follow session at the settled camera setup (above, close, lamp on):
scan, then solve without stopping; the dock's net shows what the reader
believes and the toasts show the stages it crosses.

### 10.3 Next

1. **Recordings that can be read:** camera above and close (7.2), the cube
   filling 150+ px, three faces in view, `Moves` typed and "I applied it"
   ticked for truth, a few short takes (3-6 turns) before a solve. The
   fixture script and the replay test print everything needed to
   calibrate `moveCost`, `outlierSigmas`, the gain priors and
   `marginMin` on them; the forced-alignment table shows which face and
   which neighbour disagree, frame by frame.
2. Gaps and the `lost` item: when depth-3 bursts leave the frame
   unexplained for a run of frames, declare the belief lost and reseed
   (2.4) - today the beam just carries on.
3. Track survival across a whole-cube rotation: a pairing majority
   re-anchors k, a lone face does not; the fit-based k is frozen for life.
4. Slice / wide moves and rotations in the record (2.2, last paragraph).
