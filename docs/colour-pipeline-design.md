# Colour pipeline redesign (2026-09-13)

**Status (2026-09-13, same day): implemented** in `web/src/colour/` - phases 1
and 2 together, since the decoder and the evidence log turned out to be
cheap to build side by side. What differs from the text below: the solver
runs in a Web Worker (`solve.worker.ts` / `client.ts`) because a failing
legality search takes ~1 s; the ordinal naming ranks the five chromatic
colours by HUE (blue, red, orange, yellow, green) rather than by a/b -
"largest a" mis-named red on the kitchen-evening scan; centre colours of
the candidate groups are made distinct by a 6x6 assignment on membership
rather than by dropping collisions; the palette is seeded from the centre
cells only; the track-birth/death events are logged but the re-acquisition
prior is not used yet; commit-once applies to the lock only (groups are
recomputed every solve). Bake-off on the seven single-frame truths:
logchroma and lab-crushed 6/7 exact with the blue-monitor scan correctly
refused, lab-rel 4/7 - logchroma ships. Multi-frame behaviour is covered
by `test/colour-synthetic.test.ts` until phone captures exist.

**First phone session (2026-09-13, two captures in `web/test/fixtures/evidence/`):**
one lock, one stall. The stall was not colour: the page sampled coasting
tracks, so a stale quad beside its replacement counted as two co-visible
faces and the orange face was split into L and D for the whole session,
leaving the yellow face without a letter. Fixes: only freshly-detected
tracks are logged; overlapping quads are not co-visibility; the six faces
are chosen by a full assignment (evidence-weighted "unassigned" column);
each track's rotation is reconciled between its own pairings and its
face-mates' colour pattern (anchored on the strongest track, absolute
offset by geometric majority); the legality search waits for every slot to
have evidence and the reason names the face to show. The lock's trajectory
was never wrong at any prefix; its latency was face coverage, not the
solver. Embedding: lab-crushed classified all 54 free on both captures
where logchroma needed the decoder to move four orange stickers, so
lab-crushed became the default. **Superseded the same night by the colour
bank** (`web/test/colour-bank.test.ts`: 674 hand-labelled centres over ten
capture sessions, perfect corners): lab-crushed is the worst of the five
embeddings on red/orange in every warm indoor session (d' 1.6-2.0 against
lab-norm's 2.8-7.6) and lab-norm names centres at 92.3% pooled against
84.7%, locks four more replay captures (two verified 54/54); its one loss
is the monitor-lit day-one capture where white and yellow are not
separate colours in the data at all, now a must-refuse case. lab-norm is
the default.

**Third capture (same day, blue-cast light, each face shown once):**
three findings. (1) Glare was defined as "any channel >= 250" and the
phone clips the red channel of every orange sticker, so every orange
reading weighed zero and 18 stickers on shown faces were "unseen" - glare
now means blown to white. (2) No single colour space is robust: logchroma
separates yellow from green under this cast where Lab collapses them, Lab
separates red from orange where logchroma does not, L at 0.5 alone solves
the blue-monitor scan; the solve now runs in three spaces and the
certificate picks (quick balanced pass ranks them, full search on the top
two). (3) Five faces can suffice: `complete.ts` fills unseen stickers from
the pieces exactly and says whether they are forced; slots with negligible
evidence (< 1) are treated as unseen; one hidden face is forced on about
half of scrambles (two same-coloured visible stickers on the hidden face's
edges leave a legal swap), and the search reports the rest as ambiguous.
The capture itself now refuses honestly: the red and orange centre
readings are within 1.4 of swapping under that light.

**Fourth capture (fast scan, scramble applied, 19 s):** locked correctly
but late. Findings: sampling cost 48 ms per detection frame on the main
thread (now a sampling worker, frames transferred, two in flight);
detection cadence fixed at every 2nd frame (now 'auto': whenever inference
and the sampler are free); the solver re-runs at 1.5x its own duration;
`changed` and per-slot margins were blocking correct answers the delta
certificate had already vouched for (now UI hints only); the completion
verdict was ordered ahead of a found legal cube; young tracks were
penalised 0.3/0.6 (now 0.5/0.8); the palette is seeded from the six
lettered faces' centres. The decoder checks pieces on colour ids, expands
only swaps touching broken pieces, and has a wall-clock cap. Replayed, the
capture locks at 14.8 s (the moment its last stickers were seen) with no
wrong lock at any prefix. Clip replays of the 9/12 monitor-light videos
run through the page headlessly and refuse - that lighting remains the
open hard case.

**Naming under casts (clip replays, same day):** under warm room light
white reads as a tan of chroma ~50 while blue sits at 18, and on a fast
indoor scan white was darker than yellow - "least chromatic" and
"brightest" both fail, and a wrong white gives a legal but relabelled cube
(a wrong lock on the fast-scan fixture caught it). White is now the
palette's achromatic point by structure: the colour from which the other
five spread around the hue circle (largest gap ~150 deg vs 170-290 from any
other candidate), and hues are ranked relative to it. The letter map is
also re-checked against the decoded centre colours and the decode redone
if it moves. The palette is fitted only to tracks of lettered faces from
the second round on (a hand beside the cube is a track too).

**Evening webcam session (two "stuck" captures, ceiling lamp in frame):**
the cube was backlit and read at RGB (40, 27, 14) on whole faces, and the
desktop sampled every camera frame. Three findings. (1) Lab chroma is
proportional to intensity in the dark (f is linear below Y = 0.9%): a red
sticker at (52, 17, 10) has a,b (13, 11) and every dark sticker collapses
onto white, in logchroma too (its soft eps is 5/255). New embedding
`lab-norm` scales the reading's linear RGB to a fixed luminance before
Lab; it locks 8 of the 12 evidence fixtures, best margins on the seven
truths, and agrees with every other space wherever two lock. The ensemble
is now lab-norm, logchroma, lab-crushed. (2) Readings carry a
signal-to-noise weight, quadratic in the brightest channel up to 80: near-
black readings outnumbered lit ones and the palette fitted dark greys. The
replay test now re-derives every reading's weight from its stored patch
statistics, so weight changes are measured on the fixtures before they
ship. (3) The page samples at most one frame per 80 ms (the 1500-quad
window was 20 s at 30 samples/s, the solve 1 s), shows "more light" from
the evidence itself (running median of the brightest sampled channel below
55) whatever the old namer says, and nudges the camera's exposure
compensation toward the cube's brightness where the track offers it. The
darker capture still refuses (red, orange and a brown reading are not
separable in it) - correctly; the other locks in logchroma alone. Neither
has a truth.

Design only, as written before the implementation. Written against `docs/colour-pipeline-postmortem.md` (the
failure log) and `docs/rubiks-vision-analysis.md` (the comparable
scanner). Read both first; this document does not repeat them.

## 0. The design in one paragraph

A frame never decides anything. Every detection frame yields *readings*
(one per visible sticker cell) that carry a colour measurement, a set of
quality weights, and their geometric address (track id, cell index). A
track is an anonymous physical face; its readings are aggregated per cell
into a robust nine-cell *signature* with no colour decision involved. A
six-colour *palette* plus a per-frame illumination correction is fitted to
all readings at once by alternating with the cube's own constraints (nine
per colour, six distinct centres, legal pieces). Tracks are grouped into
at most six physical faces by signature agreement, with "seen together in
one frame" as a hard veto. The result is a 54x6 evidence matrix; an exact
constrained decoder (ported from rubiks-vision, MIT) returns the cheapest
legal cube, how far it moved from the raw evidence, and how much cheaper
it is than the runner-up. Face letters are chosen last from ordinal
properties of the fitted palette and from geometry. Lock is a policy on
the decoder's certificates, not on cluster counts. There are no
per-reading identity thresholds anywhere.

## 1. Principles, each pinned to a failure it removes

| # | Principle | Post-mortem failure it kills |
|---|---|---|
| P1 | Identity is never decided from one sticker or one frame. Readings are evidence; decisions are made once, globally. | 3.1 identity from the centre, 3.4 cluster-id coupling |
| P2 | Same-frame relativity: readings in one frame share exposure, AWB and illuminant; differences are pigment. Model illumination as a per-frame nuisance, never as a property of the colour. | 3.3 predicates fighting illumination |
| P3 | The cube's constraints are the classifier, not a repair step. | 3.6 constraint arrives last |
| P4 | Every stage has a written objective. Parameters are weights or priors, measured on the fixture set; a parameter that flips a decision by itself is a bug. | 3.2 online clustering without an objective |
| P5 | Evidence is weighted, not gated. The only readings dropped are those with provably zero information (fully clipped patches, faces below the size floor). | 3.5 evidence thrown away |
| P6 | Lightness is information. Keep it as *relative* lightness (to the face, to the frame), not as absolute L. | 3.7 crushed L |
| P7 | Names last. Six abstract colours are decoded; letters come from the palette's ordinal properties and from geometry. | 3.3, 3.4 |
| P8 | Commit once. A locked state, a committed track grouping, a committed letter map are never re-derived from later evidence; the user rescans. (rubiks-vision's evidence-commit discipline.) | live anchor flips |
| P9 | A wrong lock is worse than no lock. Every gate is calibrated so that no fixture ever locks wrong; time-to-lock is optimised second. | session-0913 "invalid" stalls are acceptable; wrong states are not |
| P10 | The entire colour half is a pure function of a recorded evidence stream. Development happens in the replay test; the phone confirms. | the one-capture-one-threshold loop |

## 2. Data flow

```
camera frame -> detector + tracker (unchanged) -> quads {trackId, corners, conf, pairings}
                                                        |
                                    +-------------------v--------------------+
                                    | 3.1 Sample: 9 cells per quad,          |  per detection frame
                                    |     patch statistics, censoring        |
                                    | 3.2 Weight: quality -> w in [0,1]      |
                                    +-------------------+--------------------+
                                                        v
                              EvidenceLog (append-only; this IS the capture format)
                                                        |
       +------------------------------------------------v-------------------------------------+
       | Solve (pure, every ~500 ms on the whole log, milliseconds of CPU)                    |
       |  3.3  embed readings in the colour space                                             |
       |  3.4  per-frame illumination correction   <---+                                      |
       |  3.5  per-(track,cell) robust aggregate       |  alternate 2-4 rounds (EM)           |
       |  3.6  six-colour palette                      |                                      |
       |  3.7  group tracks into <=6 physical faces    |                                      |
       |  3.8  54x6 evidence matrix                    |                                      |
       |  3.9  exact constrained decode + legality ----+  (the assignment feeds the refit)    |
       |  3.10 letters                                                                        |
       |  3.11 certificates -> lock policy / UI                                               |
       +--------------------------------------------------------------------------------------+
```

Everything below the tracker is a function `solve(log) -> Solution` with
no state of its own except the commits of P8 (a small `Commitments`
record passed back in). That is what makes the replay test the primary
development surface.

## 3. Stages

### 3.1 Sampling v2 (`color.ts`, extend `samplePatch`)

Keep `facePlan`, `warpQuad`, the diagonal centre ring and its
measurements. Change what a patch *returns*. Today it is the mean RGB;
that is where glare, seam spill and finger edges get averaged into a
sticker. A patch returns instead:

- `rgb`: per-channel **median** of the pixels after discarding the
  brightest 10% and the darkest 10% (by luminance). Median, because a
  patch that half-straddles a seam has a bimodal histogram and the mean is
  neither mode.
- `clipFrac`: fraction of pixels with any channel >= 250 (glare) and
  `darkFrac`: fraction with luminance below ~8% (seam, shadow, black
  plastic). Both are evidence quality, not verdicts.
- `spread`: robust spread (MAD) of the pixels in Lab. High spread = the
  patch is not looking at one flat sticker (logo edge, finger edge, seam,
  motion smear).
- `censored`: per channel, whether the median itself sits at 0 or 255. A
  censored channel is a bound, not a value (the phone ISP clips saturated
  red to `[230, 0, 30]`; see any session-0913 quad). Section 3.3 says how
  the embedding treats it.

Centre cell: unchanged geometry (four diagonal patches at `LOGO_CLEAR_OFF`,
medoid), but each of the four reports the stats above and the cell's
`spread` is the disagreement among the ring, replacing the binary
`CENTRE_OBSCURED_LAB` / `RING_INCOHERENT_LAB` refusals. An obscured centre
is a low-weight centre reading, and the other eight cells are unaffected.

Also computed per quad on the 90x90 rectified canvas (cheap, already
warped): `blur` = variance of Laplacian; `viewCos` = the quad's
foreshortening (ratio of the shorter to the longer mid-line, 1 = square
on); `edgePx` = longest edge in source px.

### 3.2 Reading quality weights (`evidence.ts`, new)

Each reading gets one scalar `w = product of f_i`, every factor in [0, 1]:

| factor | from | shape (all soft; numbers are starting points for replay calibration) |
|---|---|---|
| detector | quad conf | conf itself |
| glare | clipFrac | 1 - clipFrac, and 0 when clipFrac > 0.6 (the only hard zero) |
| seam | darkFrac | 1 - 2*darkFrac, floored at 0.1 |
| flatness | spread | exp(-spread / s0), s0 ~ 8 Lab |
| sharpness | blur | ramp 0 -> 1 between blur 15 and 40 |
| motion | tracker corner speed | ramp 1 -> 0.2 between 0 and ~3 px/ms |
| view | viewCos | ramp 0.3 -> 1 between 0.4 and 0.8 |
| size | edgePx / minFaceEdgePx | ramp 0.3 -> 1 between 1.0 and 2.0 |
| track age | detections so far in this track | 0.3 for the first, 0.6 second, 1 after |

Nothing here decides a colour. A factor being off by 2x changes how fast a
sticker converges, not what it converges to; that is the test for whether
something belongs in this table or is a threshold in disguise.

The former **seam veto** (230-550 refusals per window) is gone; its job is
done by `darkFrac` and `spread`. The former **obscured-centre refusal**
and **alien gate** are gone (P5).

### 3.3 Colour embedding (`colorspace.ts`, new; pluggable)

The space the palette lives in is the one modelling decision that must be
settled by replay, not by argument, so the solver takes it as a function
`embed(reading, frameContext) -> vector` and the replay harness evaluates
candidates on the same fixtures with the same decoder. Ship the best one;
keep the others as debug views.

Candidate A (recommended hypothesis): **log-chromaticity + relative
luminance.** Decode sRGB to linear, floor at 1/255, take logs. Project onto
the plane orthogonal to (1,1,1), giving 2 coordinates in which *any*
per-sticker intensity change (shading, exposure, lit-vs-shadowed side)
vanishes exactly and a white-balance change is a pure translation (von
Kries). The third coordinate is log-luminance minus the quad's median
log-luminance, which is the "white is the brightest sticker on its face"
information (P6) that crushed L discards. Censored channels: a channel
clipped at 255 contributes a one-sided term (its true value is *at least*
that), which in practice means the embedding uses the clipped value and
the reading's weight is multiplied by 0.5 per censored channel; a channel
at 0 is floored. Downside to measure: phone ISPs apply tone curves and
local contrast, so "linear" is approximate.

Candidate B: chroma-compressed Lab with the face-relative L kept at full
weight in a separate coordinate (the knee/slope from `state.ts`, which
measurably helped session-0913).

Candidate C: crushed-L Lab, i.e. today's clustering space, as the baseline
the others must beat.

Acceptance is section 6's metric on the fixture set; the expectation is
that A wins on cast/shading fixtures and ties elsewhere.

### 3.4 Per-frame illumination model (`illum.ts`, new)

Nuisance parameters, fitted, never thresholds:

- `g_f`: per detection frame, a 2-D translation in the chromatic plane
  (candidate A) or an equivalent ab shift (B/C). This is AWB drift and
  colour cast.
- `s_q`: per quad, a scalar luminance offset (already implicitly present
  via the face-median subtraction). Lit and shadowed sides of the cube
  are different quads in the same frame, which is why this is per quad
  and the chromatic term is per frame.

Fitted by weighted least squares of readings against the current palette
under the current assignment (section 3.6), with a **prior** pulling `g_f`
to zero whose strength is inversely proportional to the frame's colour
diversity: a frame showing three colours pins its own gain well; a frame
showing one colour (a solved face, dead on) cannot, and would happily
"correct" red into orange, so the prior wins and it gets the session's
median gain instead. Clamp `|g_f|` to the equivalent of chroma factors
[0.6, 1.4] (rubiks-vision's clamp; a bad fit cannot wreck saturated
colours). Gauge: the weighted mean of `g_f` over frames is zero, so the
palette is "the cube as seen under the session's average light".

Extension if mixed illumination (window on one side, lamp on the other)
shows up in captures: make the chromatic term per quad with a strong prior
toward the frame's value. Not by default.

### 3.5 Track evidence (`evidence.ts`)

A track's corner order is stable for its life (tracker contract), so all
its readings share one unknown rotation and cell k in frame 1 is cell k in
frame 100. Aggregate per (track, cell):

- `value`: weighted geometric median of the embedded, illumination-
  corrected readings, computed with iterative reweighting so that frames
  whose reading sits far from the running median (a passing finger, a
  glare flash, a motion smear) are down-weighted automatically. This is
  the temporal robustness: a sticker that is wiped by glare in 30 of 100
  frames converges to its unwiped colour without anyone naming "glare".
- `n_eff`: effective evidence, `min(sum of w, N_SAT)` with `N_SAT` ~ 12.
  Frames of one track under one light are not independent samples;
  saturating keeps the decoder's costs and certificates honest (section
  3.9). Two *different* tracks of the same face (different light,
  different time) do add.
- `spread`: weighted MAD of the inliers; feeds the likelihood scale.

Signature of a track = its nine `(value, n_eff)` pairs. No colour name is
attached to a track at any point.

### 3.6 Palette fit (`palette.ts`, new)

Six centres `p_1..p_6` in the embedding space, fitted to all (track, cell)
aggregates weighted by `n_eff`, by alternation:

1. Initialise: farthest-point seeding on the *centre-cell* aggregates of
   all tracks with enough evidence (tracks of one face land on the same
   point, so six faces seen means six distinct seeds), several k-means++
   restarts as a fallback, keep the best objective.
2. Free step: weighted k-medoids, k = 6.
3. Constrained step: sections 3.7-3.9 produce an assignment of every
   aggregate to a colour that respects nine-per-colour and distinct
   centres. Re-estimate each `p_c` as the weighted medoid of the
   aggregates *assigned* to colour c, and the per-colour scale `sigma_c`
   as their weighted MAD.
4. Refit illumination (3.4), re-aggregate (3.5), repeat 2-4 rounds or
   until the assignment stops changing.

The objective that is minimised end to end is the decoder's total cost
(3.9). A palette in which "red" swallowed orange cannot satisfy nine of
each and is rejected by the very thing that used to be the fallback.
Fewer than six colours seen: the fit still runs with k = 6 (empty
colours allowed), the decoder reports the slots as unobserved, and the UI
shows "N/6 centres seen" (3.11).

Likelihood of an aggregate under colour c: Student-t (nu ~ 3) on the
scaled distance `|x - p_c| / sigma_c`. Heavy tails are the point: a skin
or desk reading is far from *all* six centres, its six costs are all
large and nearly equal, and the decoder treats the slot as almost
unconstrained by that reading, which is exactly right. `sigma_c` is
fitted, not a constant.

### 3.7 Track -> face grouping (`faces.ts`, new)

M tracks over a session (6-15 typical: faces re-acquired after coasts)
must become <= 6 physical faces, each with a rotation per track.

Pairwise score for "tracks i and j are the same face": the best over the
four cyclic rotations of the weighted agreement of their nine-cell
signatures, evaluated as colour-membership vectors (softmax over the six
colours under the current palette), not raw distances, so lighting is
already normalised out. Constraints:

- **co-visibility veto** (hard): tracks that appeared in the same frame
  are different faces. The current pipeline never uses this and it is the
  strongest negative evidence available.
- **shared-edge consistency** (hard): if i and j were paired across an
  edge in some frame, they are adjacent faces, so not the same, and not
  opposite; and the relative rotation implied by the pairing is fixed
  (`orient.ts` `sharedEdgeCells`, `edgePiecesPlausible`: keep both).
- **distinct centres** (soft, strong): two tracks whose centre memberships
  disagree strongly are different faces.
- **re-acquisition prior** (soft, weak): a track born within ~300 ms of
  another's death near its last position is likely the same face.

Agglomerative merge in descending score order, honouring vetoes; the
result is <= 6 groups plus possibly leftover groups with weak evidence
(junk quads on a tiled wall) that are simply not assigned to a face. Once
a group has been *committed* (its evidence is above the lock floor and it
has been stable for two solves) it is never split again in this session
(P8); new tracks may still join it.

Per-group rotation: relative rotations inside a group come from the merge;
the group's absolute rotation is the shared-edge majority vote across all
its frames (today's `voteRotation`, keyed on the group instead of on a
cluster, so a rename can never invalidate it). Groups with no pairing ever
(dead-on-only scanning) keep rotation unknown and section 3.10 resolves it
by piece legality (existing `resolveByPieces` / 4^6 search).

### 3.8 The 54x6 evidence matrix

Slot s = (face group, cell after rotation). `E[s][c] = sum over aggregates
of n_eff * log L(aggregate | c)`, normalised per row into a cost
`C[s][c] = -log softmax`. Unobserved slots are all-zero rows: free, the
constraints decide them. A slot fed by several tracks of the same face
under different light is exactly the same-frame-relativity idea applied
across time: the decoder sees a sticker that is red-ish in warm light
*and* red-ish in daylight.

### 3.9 Exact decoder (`decode.ts`, port of `exactDecode.ts`, MIT)

As analysed in `rubiks-vision-analysis.md` section 5, unchanged in
substance: 720 centre permutations; 48-slot transportation problem, eight
per colour; best-first 2-swap search ordered by exact cost delta until the
first legal state (`validateState` is the legality oracle); keep searching
for the runner-up to obtain the **delta certificate**; report `changed`
(slots moved from the free argmax) and per-slot **margins** (cost to
swap the slot with its cheapest partner while staying legal, approximated
by the best 2-swap involving that slot). ~300 lines, pure, milliseconds.

The certificate is only as honest as the costs; that is why 3.5 saturates
`n_eff` and 3.6 fits `sigma_c`. Calibrate on the fixture set (section 6):
delta should be large on clean sessions and near zero on the two known
red/orange stalls *before* their extra evidence arrives.

### 3.10 Letters (`naming.ts`; replaces `nameClusters`)

Two independent things are decided here, and they should not be confused:

1. **Which abstract colour is which named colour** is only needed to pick
   a viewing convention: which face to call U and which to call F. Use the
   ordinal properties of the six fitted centres (the one use of predicates
   that has survived every session): least chromatic -> white (U); of the
   rest, most negative b -> blue, most negative a -> green (F), largest b
   -> yellow, the two remaining warm ones ordered by hue -> red, orange.
   Solve it as a 6x6 assignment on *rank* features so it is always a
   bijection; never a predicate with an absolute number in it.
2. **The remaining four letters follow from geometry**, not colour: given
   U and F, R/D/L/B are fixed by the shared-edge adjacency between face
   groups and corner chirality (`resolveByPieces` already encodes this).
   If the geometry says the "white" face is not opposite the "yellow" one,
   the cube has a non-standard scheme and geometry wins; the output is
   still a correct URFDLB string for *that* cube (cubejs only ever sees
   letters). With no adjacency observed at all (every face scanned dead
   on), fall back to the standard-scheme prior plus the 4^6 legality
   search, exactly as today.

### 3.11 Lock policy, certificates, and what to show while undetermined

Run the solve every ~500 ms (it is cheap). Lock when, for two consecutive
solves (hysteresis):

- the decoder found a legal state;
- every slot has `n_eff >= N_MIN` (~6) from at least one committed group;
- `changed <= K_MAX` (rubiks-vision's 4 is the starting point);
- `delta >= DELTA_MIN` and the minimum per-slot margin >= `M_MIN`, both
  calibrated on the fixtures such that **no fixture ever locks wrong**
  (P9), then loosened until time-to-lock on clean fixtures is acceptable.

Before lock the UI has real information instead of "10 clusters": the six
grids painted with the current best assignment, each cell tinted by its
margin (confident / contested / unobserved), a "centres seen N/6"
counter, and a prompt for the face group with the least total evidence
("show me the orange face again"). Contested pairs (low margin between
two specific slots) are shown as such: that is the red/orange pair asking
for one more well-lit frame, which is the honest state of knowledge. After
lock, the lowest-margin slots are the tap-to-fix highlights, and the
locked state is frozen (P8).

Product option, cheap, the user's call: if letters remain unresolved after
lock because no adjacency was ever seen, ask once for a corner-on view
rather than guessing the scheme.

## 4. How each hard case is handled

| Case | Mechanism |
|---|---|
| Specular glare wiping a sticker | trimmed-median patch, `clipFrac` weight, temporal reweighting in 3.5 (glare moves as the cube tilts, the unwiped frames win), censored channels |
| Lit vs shadowed side (20-30 units) | vanishes exactly in log-chromaticity (candidate A); per-quad luminance offset; relative luminance kept as its own coordinate |
| Warm cast / monitor light / AWB drift | per-frame chromatic translation with a diversity-weighted prior and clamp; the palette is defined under the session's mean light |
| Red vs orange | never decided per reading: nine-per-colour forces the ten "reds" to give up the most orange-looking one; the certificate says when the pair is genuinely unresolved and the UI asks for more light instead of locking |
| White vs pale yellow, white vs dark blue | same constraint mechanism plus relative luminance (white is the brightest on its face) which crushed L discarded; the distinct-centres constraint prevents two white faces |
| GAN logo on the centre | diagonal ring unchanged; ring disagreement becomes a weight; the constrained decode does not hinge on the centre because the group's other eight cells and the distinct-centres rule carry it |
| Fingers over a sticker | minority frames: temporal reweighting; whole track: skin is far from every centre, so near-uniform costs, so the constraints decide the slot; the user's tap is the last resort and the margin highlights it |
| Skin, desk, tiles as quads | never get a face slot unless their signature matches the palette; leftover groups stay unassigned |
| Seams / rounded corners in a patch | trimmed median + `darkFrac`; no seam veto |
| Motion blur, freshly acquired track | `blur`, `motion`, `trackAge` weights; nothing dropped |
| Track re-acquisition | signature grouping with the co-visibility veto and the re-acquisition prior; frames from before and after the coast pool into one face group |
| Single-colour frames (solved cube, dead-on) | illumination prior wins so the gain cannot hallucinate; palette still fits across faces; letters via piece legality |
| Fewer than six centres seen | solve runs, reports unobserved slots, UI counts centres; no lock |
| Non-standard colour scheme | letters from geometry; ordinal naming only picks U and F |
| Junk cluster "named red" (1789310783346) | no cluster to name; a chroma-23 skin aggregate is far from red under the fitted `sigma_red` |
| Split colour over lit/shadowed (1789309733443, 1789317142821) | not a cluster-count problem any more: two aggregates of one sticker under two lights are one slot's evidence |
| Adjacency cascade (1789308171326) | bindings do not exist; adjacency is a veto/rotation constraint on groups, never an identity |

## 5. Parameters, and how each is set

The full list. If a future change adds one that is not a weight, a prior
or a calibrated gate, that is the smell from the post-mortem returning.

| Parameter | Kind | Set by |
|---|---|---|
| patch trim fraction (10%) | fixed | measured on glare fixtures once |
| quality factor ramps (3.2, 9 of them) | weights | replay: convergence speed, must not change any locked answer |
| `N_SAT`, `N_MIN` | evidence saturation / floor | replay calibration of the certificate |
| illumination prior strength, clamp | prior | replay: cast fixtures lock, single-colour frames do not drift |
| Student-t nu | fixed (3) | not tuned |
| `sigma_c` | fitted per session | data |
| group merge acceptance score | calibrated gate, backed by the hard vetoes | replay |
| `K_MAX`, `DELTA_MIN`, `M_MIN` | lock gates | replay, P9 rule first |
| ordinal naming rank features | structure, not numbers | none |

Deleted with the old pipeline: `BIRTH_DIST`, `MERGE_DIST`, `MAX_CLUSTERS`,
alias distance, hue-split angle and its chroma floor, `WHITE_MAX_CHROMA`,
`GREEN_MIN_HUE`, `WARM_MIN_CHROMA`, the b -8/-14 neutral rule, binding
quorum/lead/contradiction, `CENTRE_OBSCURED_LAB`, `RING_INCOHERENT_LAB`,
the seam veto, the alien gate, `MIN_INLIERS`/`MAX_FIT`, `CLUSTER_L_WEIGHT`.

## 6. Evidence log, replay, evaluation

**EvidenceLog v2 is the capture format.** Every detection frame appends:
frame id and time, illumination descriptors, each quad (track id, corners,
conf, blur, viewCos, edgePx, tracker speed, detections-so-far) with its
nine readings (rgb, Lab, clipFrac, darkFrac, spread, censored flags, w),
every shared-edge pairing (track pair, edges, plausibility), tracker
births/deaths. ~100 bytes per reading, ~700 KB per two-minute session;
`Capture debug` dumps it whole. Optionally every Nth rectified 90x90 face
as PNG for the learned-model option (section 10). The solve is a pure
function of the log, so a capture reproduces the phone bit for bit.

**Existing fixtures.** `session-0913/*` and the ten `scan-debug-*`
captures store consensus cells and one frame's quads, not readings. They
still validate 3.9-3.11 (build a 54x6 from their consensus cells and
centres) and the three session-0913 stalls are the first acceptance test
of the decoder. They cannot exercise 3.1-3.7. New captures are needed
before phase 2 starts: ten sessions on known scrambles under daylight,
warm indoor, monitor-only, a lamp placed to glare, hand shadows, a solved
cube, a fast sloppy scan, and one deliberately dead-on-only scan.

**Metrics per fixture** (`session-replay.test.ts` grows into this):
locked yes/no; correct yes/no (**a wrong lock fails the whole suite**);
`changed`; `delta`; min margin; ticks to lock; per-slot correctness of the
pre-lock best guess over time (how early the truth is already the best
guess); groups merged wrongly. The embedding candidates of 3.3 and the
parameters of section 5 are chosen on these numbers.

## 7. Module contracts

```
web/src/colour/                       (new directory; old files deleted in phase 2)
  colorspace.ts   embed(reading, ctx) -> Float64Array(3); several candidates + inverse for debug views
  evidence.ts     Reading, QuadObs, FrameObs, EvidenceLog (append, serialise); quality weights; per-(track,cell) aggregation
  illum.ts        fitFrameGains(log, palette, assignment) -> {g_f, s_q}; apply
  palette.ts      fitPalette(aggregates, constraintsCallback) -> {centres, sigma, membership}
  faces.ts        groupTracks(log, membership, commitments) -> FaceGroup[] (tracks, rotations, n_eff)
  decode.ts       decode(C: 54x6) -> {facelets, cost, changed, delta, margins[54], legal}
  naming.ts       letters(palette, groups, adjacency) -> {colourToLetter, U, F}
  solve.ts        solve(log, commitments, params) -> Solution   (composition of the above, pure)
  types.ts
web/src/color.ts         keep geometry (facePlan, warpQuad, rings); samplePatch returns PatchStats
web/src/detect/orient.ts keep as is (edge geometry, plausibility)
web/src/state.ts         keep validateState, rotateCells, resolveByPieces, resolveByRotation, assignBalanced
```

Types worth fixing before any code:

```ts
interface Reading  { track: number; frame: number; cell: 0..8; rgb; lab; clipFrac; darkFrac; spread; censored: [b,b,b]; w: number }
interface QuadObs  { frame: number; track: number; corners; conf; blur; viewCos; edgePx; speed; nthDetection; readings: Reading[9] }
interface Pairing  { frame: number; a: number; b: number; edgeA: 0..3; edgeB: 0..3; plausible: boolean }
interface EvidenceLog { frames: FrameObs[]; quads: QuadObs[]; pairings: Pairing[]; trackEvents: ... }
interface Solution { facelets: string | null; legal: boolean; cost; changed; delta; margins: number[54];
                     nEff: number[54]; centresSeen: number; groups: FaceGroup[]; palette; letters; lockable: boolean; reason: string }
```

`solve.ts` and everything under it are pure and unit-testable without a
camera (CLAUDE.md convention). `scan-main.ts` shrinks to: pump frames,
append to the log, call `solve` on a timer, render `Solution`.

## 8. What gets deleted

`detect/colorid.ts` (ColorClusters, nameClusters, binding votes, aliasing,
the alien gate), `detect/identify.ts` (nominal path), `assembly.ts`
(StickerVoter and its frame-alignment consensus; its best idea, frames
as the unit, survives as tracks being the unit), the colour half of
`scan-main.ts` (rotation votes keyed on clusters, cluster-rename
bookkeeping, seam veto), `normalizeFaceCells`/`compressChroma` in
`state.ts` unless candidate B wins in 3.3. Roughly 1,800 of the 2,300
lines. Their tests go with them; the fixtures stay and are re-targeted at
`solve`.

## 9. Phasing

Each phase ends with something runnable on the phone.

**Phase 1: decoder first (days).** Port `decode.ts`, write `naming.ts`
with rank-based assignment, feed both from the *current* voter's per-face
consensus cells (a 54x6 from distances to the current centres). Gate lock
on the certificates instead of `MIN_INLIERS`/`MAX_FIT`. Acceptance: the
three stalled session-0913 captures lock to the known truth; no existing
fixture locks wrong. Ship. This alone attacks red/orange and white/blue at
lock and gives the UI margins.

**Phase 2: evidence log and the solver (the redesign proper).** 3.1-3.8
and `solve.ts`; EvidenceLog v2 capture on the phone; the ten new fixture
sessions; embedding bake-off; delete section 8. Acceptance: every new
fixture locks correctly or reports why not; time-to-lock at or better than
today on clean sessions.

**Phase 3: conditional.** Only if phase 2 fixtures still show contested
red/orange or white/yellow pairs after enough evidence: the learned
per-patch model (section 10). Everything else stays.

## 10. Later: where a learned model plugs in, and what stays out

The learned option (post-mortem C, rubiks-vision's scanner) replaces one
function: the likelihood `L(aggregate | c)` of 3.6 becomes a small network
on (rectified patch, frame context) -> six logits + junk, trained on our
own EvidenceLog captures, which come pre-labelled once a session locks
(slot -> colour for every reading). Track grouping, the decoder, naming
and the lock policy do not change. Constancy augmentation applied jointly
to patches and palette is the recipe to follow if it comes to that.

Not part of this design: the 6-DoF cube pose (rejected in the analysis
doc), more detector outputs (post-mortem D; quads are not the weak link),
and any per-frame identity of any kind.

## 11. Risks

- **The embedding bake-off may show that phone ISPs are far from linear**
  and candidate A loses to B. That is fine; the solver is the same. What
  would be bad is picking A by argument and finding out on the phone.
- **Track grouping is the new hard part.** It replaces cluster ids as the
  glue and it can go wrong in the same way (two faces merged). The
  co-visibility veto and commit-once discipline are the defences; the
  replay metrics include "groups merged wrongly" explicitly.
- **Certificates need calibration data.** Until ten new captures exist the
  lock floors are guesses; until then keep P9 conservative and accept
  slower locks.
- **The solved cube** is the degenerate case for every relative method
  (one colour per frame, no same-frame contrast). It must be a fixture.
