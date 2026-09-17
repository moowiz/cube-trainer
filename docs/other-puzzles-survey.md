# Other puzzles: what it would take (survey, 2026-09-17)

**Status: a survey, not a plan.** The question: what would it take for the
scanner, the colour solver, the move reader and the timer to handle
puzzles other than the 3x3 (2x2 to 5x5, Pyraminx, Megaminx, Skewb, and
the rest), including the training data. Effort figures are rough working
days of build time and exclude photo sessions; the risks are called out
where a number is a guess.

The inventory of puzzles in the house is pending (order history);
section 6 lists the questions that decide the order.

---

## 0. The short version

- **Square-faced puzzles (2x2, 4x4, 5x5, Skewb) are the cheap family.**
  The face detector already finds square outlines with no face identity in
  the model; what changes is inside the face (how many cells, where) and
  in the solver (which pieces exist, what is legal). A 2x2 is the right
  first step: it forces every "3x3" assumption into a parameter without
  new geometry.
- **Pyraminx and Megaminx need a new detector head** (3 and 5 corners per
  face), new generator geometry, and their own piece tables. Pyraminx is
  otherwise small. Megaminx has the one real research risk: twelve
  colours, several of them near neighbours in hue, on faces that show
  four to six at a time.
- **Square-1 and Clock are out** for this architecture (shape-shifting
  faces; dials).
- **Everything hinges on one refactor:** a `Puzzle` definition that the
  generator, the sampler, the evidence log, the decoder and the move
  model all read, with the 3x3 as its first instance. About four days,
  behaviour-preserving, and it should land before M11 writes analysis
  against the 3x3 alone.
- **The smart cube helps none of this**: GAN and the others are 3x3 only.
  Labelled video for other puzzles comes from scans and typed truth.

---

## 1. What is 3x3-specific today

| module | assumption |
|---|---|
| `model/gen/scene.mjs` | the cubie loop is `-1..1` on three axes; stickers, logos, tile profiles, misalignment are 3x3 |
| `model/train/model.py` (stage 2) | a face is 4 corners: `CENTER_OUT_CH = 1 + 4*2`; `npts` is already a parameter (the 16-point grid head used 16) |
| `model/train/*` targets, `check_labels`, `import_labels` | four corners per face, `URFDLB` slot names |
| `web/label.html`, `src/label-main.ts` | four clicks per face |
| `detect/tracker.ts` | quads (4 corners); size-agnostic otherwise |
| `rectify.ts` | homography from 4 points to a 90x90 face, 3x3 cells |
| `colour/sampler.ts`, `color.ts` | 9 cell centres, the centre cell's logo ring |
| `colour/` evidence log, faces, naming | cells 0-8, shared edges of 3, six colours named by hue rank, faces from centres |
| `colour/decode.ts` | 54 slots, 6 colours, 9 each, six centre slots, corner and edge tables from `state.ts`, legality via `validateState` (3x3) |
| `state.ts`, `cube/*` | cubejs facelet order, 3x3 pieces, 18 face turns, ZZ tables |
| `moves/` (the reader) | 18 permutations of 54 slots |
| `timer/` | 3x3 random-state scrambles from cubejs |
| `smart/` | GAN / MoYu / QiYi 3x3 protocols |
| trainers | ZZ: 3x3 by definition; stay so |

---

## 2. Per puzzle

### 2.1 NxN cubes: 2x2, 4x4, 5x5

**Detection.** Same square faces. The deployed detector may already find
2x2 and 4x4 faces (the outline is what it regresses); the first
experiment is free: run it on a few photos. The proper version renders
mixed-N data and fine-tunes the square-family model once.

**Rectify and sample.** N x N cell centres on the warped face. Risk on
5x5: cells are ~18 px on the 90 px warp and the detector's 3-4 px corner
error moves the far cells a quarter cell; a seam-grid fit inside the
warped face (the grid checker generalises to seams at 1/N and can even
count them) can snap the cells. Measure before optimising.

**Colours and legality.** Six colours, N² per colour, but the pieces
differ, and even cubes have no fixed centres:
- 2x2: 8 corners only; legality = corner twist sum ≡ 0 mod 3 and every
  corner a valid colour triple. No centres, so the *scheme* (which colours
  are opposite, the handedness) is inferred from the corners: two colours
  never sharing a corner are opposite. The lock's orientation is a
  convention (WCA fixes one corner).
- 4x4: corners as 3x3; 24 wings, each colour pair twice and
  interchangeable; 24 centre stickers, four per colour, interchangeable.
  With interchangeable centres and wing pairs the only legality
  constraints left are the corner twist and the piece colour tuples: any
  colouring with the right counts is reachable.
- 5x5: fixed centres (the scheme, as now); corners and midges exactly as
  the 3x3 (permutation parity between them, edge flip sum even); wings
  and the eight movable centres per face free given counts.
The decoder is already colour-id agnostic with the 3x3's tables plugged
in; it becomes generic over (slots, colours, counts, fixed slots, piece
tables, a legality predicate). No solver is needed for a lock; the 3x3's
cubejs oracle becomes a per-puzzle parity check.

**Scrambles and solutions.** 2x2 random-state (3.7M states, a small
solver in the worker); 4x4 and 5x5 random-move scrambles (what WCA uses);
no in-browser solution display for 4x4/5x5.

**Move model.** Permutations of the sticker slots per move, generated
from geometry (turn a layer's sticker positions, map back to slots), so
the reader's hypotheses are 18 (2x2), 36 (4x4: outer and inner or wide),
54 (5x5). Beam width scales; fine.

**Training data.** The generator with N as a parameter (cubie grid,
sticker layout, a logo only on an odd N's centre, tile profiles per cube:
the GAN 4x4's rounded tiles differ from a stickered 5x5). Real photos of
the actual cubes through the existing labelling loop: the 3x3 went from
58 px to 4.6 px error on 22 photos, so 30-50 per size is a reasonable
first batch.

**Effort after the abstraction:** 2x2 ~4 days (generator 1, retrain 1,
scheme inference + tables 1, timer + settings 0.5, photos on the side);
4x4 + 5x5 together ~1 week (generator 0.5, retrain 1, tables incl. wings
and centres 1.5, moves 1, the 5x5 cell-placement risk 1-2).

### 2.2 Skewb

Six square faces, five stickers each: a centre square (a diamond in the
face frame) and four corner triangles. Same detector family. Six colours,
five per colour. Pieces: 6 centres, 8 corners in two tetrads that only
permute within themselves; legality: centre permutation even, corner
constraints per tetrad plus twist. Eight moves (four axes, two
directions), each turning half the puzzle; permutations from geometry.
Random-state scrambles from a small solver (~3M states). Sampling
geometry is the only new thing on the vision side; the generator needs a
skewb mesh (a cube cut by four planes; sticker polygons extruded inward
over a rounded core is enough for renders).

**Effort:** ~1 week after the abstraction.

### 2.3 Pyraminx

A tetrahedron, four triangular faces of nine triangles each, four
colours. **New detector head:** 3 corners per face; `npts` is a parameter
in the head already, so it is a second stage-2 model (`K=3`) trained on
its own renders, selected by the puzzle setting; the cyclic-shift loss
generalises. The labeller takes three clicks. Rectify with an affine warp
(three points), sample the nine centroids of a barycentric grid. Pieces:
4 tips and 4 axial centres (trivial, orientation free), 6 edges;
legality: edge permutation even, flip sum even; four colours, nine each.
Moves: 4 axes x 2 directions plus tips; the state space without tips is
~75M, so an optimal solver in a worker is easy and gives random-state
scrambles. The generator needs a tetrahedron cut into layers, with the
same hands, lights and backgrounds.

**Effort:** ~1.5 weeks (head + training pipeline 1-2, generator 1-2,
labeller 0.5, rectify + sampling 1, tables + solver 1-2). Photos: the
same loop, three clicks a face.

### 2.4 Megaminx

Twelve pentagonal faces, eleven stickers each (centre, 5 edges, 5
corners), **twelve colours**, four to six faces visible at once. **New
detector head** (`K=5`), a homography from five points (least squares; a
face is planar), eleven cells. Pieces: 12 centres (the scheme), 30 edges,
20 corners; legality exactly like the 3x3 (twist sum, flip sum,
permutation parity shared between corners and edges). Moves: 12 faces x
2 (plus 144-degree doubles), permutations from geometry. Scrambles:
random-move in WCA's notation; no solution display.

**The risk is colours.** The palette fit and the hue-rank naming assume
six well-separated hues. A standard Megaminx has two greens, two blues,
pink and purple, orange and light orange, etc.: pairs that differ in
lightness more than hue, under lighting that shifts lightness more than
anything else. What helps: twelve distinct centres pin the palette; the
per-frame illumination fit already exists; the constrained decoder (11
per colour) refuses rather than guesses. What is unknown is whether the
readings separate at all on a phone camera in room light. **Ten-minute
test before anything else:** photograph the actual Megaminx and run its
stickers through the colour bank tool to see the Lab clusters.

**Effort:** ~3 weeks if the colours separate (head shared with Pyraminx,
generator dodecahedron 2, palette work 2-5, tables 2, moves 1,
scrambles 0.5), and an open research problem if they do not.

### 2.5 Square-1 and Clock

Square-1 changes shape, so its faces are not fixed polygons; the
outline-regression detector does not apply, and the state model is a
different kind of object. Clock is dials, not stickers. Both out of scope
for this architecture; a note for later, not a plan.

---

## 3. The one refactor everything needs: `Puzzle`

A definition module the whole pipeline reads, with the 3x3 as the first
instance and no behaviour change for it (the 268-test suite and the
headless checks are the net):

```
web/src/puzzle/
  types.ts     Puzzle { id, faces: K, cellsPerFace, cellCentroids (face frame), sharedEdges,
                        colours: C, countPerColour, fixedSlots, pieces: { slots[], allowed colour tuples }[],
                        legal(colourIds): boolean, moves: { name, perm }[], parse(alg), scramble(),
                        render (net + 3D), scheme }
  cube333.ts   today's cube/, state.ts tables and moves/moves.ts, re-exported
  cube222.ts, cube444.ts, cube555.ts, skewb.ts, pyraminx.ts, megaminx.ts (as they come)
  geometry.ts  sticker slots from a polyhedron and its cuts; move permutations from turning a layer
```

Consumers that change: the sampler (cells from the definition), the
evidence log (cell ids and shared edges), `colour/faces.ts` and
`naming.ts` (C colours, fixed slots optional), `decode.ts` (generic
tables and `legal`), `moves/` (the move list), the timer (scrambles per
puzzle), settings (a puzzle per session), the label tool and the training
targets (K corners). ZZ trainers stay on `cube333`.

Detector models: stage 1 (the box) retrained on all shapes; stage 2 one
model per face family (square K=4, triangle K=3, pentagon K=5), selected
by the puzzle setting, later by a stage-1 shape output.

**Licensing.** cubing.js has definitions and move tables for all of these
puzzles but is GPL; this repo is MIT. It can serve as a dev-time oracle
for tests of our own tables (like cubejs does for the 3x3 permutations),
never as shipped code.

**Effort:** ~4 days for the abstraction with the 3x3 moved onto it.

---

## 4. Training data

- **Synthetic.** The generator gains a puzzle parameter: an N x N cubie
  grid for the cubes, and piece meshes for Skewb / Pyraminx / Megaminx
  built from sticker polygons extruded over a rounded core (plausible
  plastic is enough; the realism work that mattered was hands, light and
  backgrounds, and it carries over). ~20k renders per face family;
  mixed-N for the square family so one model covers 2x2-5x5 and Skewb.
- **Real.** The labelling loop as it is, with K clicks per face and a
  `puzzle` field on the label files; per-puzzle held-out splits; 30-50
  photos per puzzle to start, more for whichever one misbehaves. The
  colour bank (labelled photos as a colour test set) extends the same way
  and is the Megaminx go/no-go.
- **Video for move reading.** No smart cube exists for these puzzles, so
  the truth for recordings is typed moves plus a scan at the start and
  the end, as the 3x3 recordings did before the cube.

---

## 5. Recommended order

1. **Free experiments first:** the deployed detector on photos of the
   2x2, 4x4, Skewb (does it find square faces?); the Megaminx stickers
   through the colour bank (do twelve colours separate?).
2. **The `Puzzle` abstraction** with the 3x3 on it (4 days), before M11.
3. **2x2** (4 days): the smallest full pass, and it fixes every implicit
   "9 per colour / centres exist" assumption.
4. **4x4 and 5x5** (1 week), then **Skewb** (1 week): the square family.
5. **Pyraminx** (1.5 weeks): the first new head and generator geometry.
6. **Megaminx** (3 weeks, or shelved by the colour test).

Total to have everything but Megaminx: roughly six working weeks, in
parallel with nothing. Against the current plan it competes with M11-M13,
which are 3x3 work; the sensible interleave is the abstraction now, the
2x2 as a one-week side quest whenever the 3x3 work is waiting on data,
and the rest after M13.

---

## 6. Questions that decide the order

1. Which puzzles are actually in the house or on the way (the order
   history will answer most of this)?
2. What do you want from them: timer plus scan, move reading for solve
   recordings, or trainers? Trainers are method-specific and a separate
   design each; timer plus scan is what the survey above costs.
3. Is the Megaminx a standard-scheme one (its colour set decides the
   colour test)?
4. Does the `Puzzle` abstraction go before M11, as recommended, or does
   3x3 analysis ship first and get moved later (cheaper now, dearer then)?
