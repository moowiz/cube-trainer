# Watching a solve: design thoughts (2026-09-13)

Status: design only, nothing implemented. Written while the 16-point grid
head trained. Read `colour-pipeline-design.md` first; this builds on its
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
