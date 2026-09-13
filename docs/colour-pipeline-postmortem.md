# Colour pipeline post-mortem (2026-09-13)

What we learned building and phone-testing the colour half of the scanner
(face quad -> sticker colours -> session colour model -> 54-sticker state),
written for the session that redesigns it. Geometry is not the problem:
the two-stage detector (`cubebox` -> `facekp`, anonymous quads) and the
tracker find and follow faces well enough on the phone (some lag, some
wiggle, fine when the cube is still). Everything downstream of "here is a
face quad" is what this document is about.

Short version: the current design decides a face's identity from ONE
reading (its centre sticker) per frame, clusters those readings online with
hand-tuned thresholds, names the clusters with hand-tuned predicates, and
only at the very end looks at all 54 stickers together. Every phone session
found a new lighting/geometry case that broke one of those thresholds, and
every fix was another threshold. Twelve such fixes in one day. That is the
signature of a wrong decomposition, not of missing tuning.

## 1. What is built today (so you can find it)

| Step | Where | What it does |
|---|---|---|
| Sample | `web/src/color.ts` (`sampleGridCells`, `sampleCentreCell`, `facePlan`) | Warp quad to 90x90, average a patch per cell; the centre cell reads a diagonal ring to dodge the logo; sRGB -> Lab. |
| Normalise | `web/src/state.ts` `normalizeFaceCells` | Subtract the face's median L; clustering weights L by 0.15 ("crushed L"), naming by 1.0. |
| Cluster | `web/src/detect/colorid.ts` `ColorClusters.observe` | Each face's *centre* reading joins the nearest cluster within `BIRTH_DIST` 20 (else a new one), reservoir of 40, centroid = median; clusters within `MERGE_DIST` 10 merge; `MAX_CLUSTERS` 10, evicting the thinnest. |
| Name | `colorid.ts` `nameClusters` | Ordinal rules: white = least chromatic & chroma<20 & b>-8; blue = min b (<-8); green = min a (<-12) & hue>125; yellow = hue 78-120, a<25, chroma>30; red/orange = warm clusters (hue<78, chroma>30) split by weighted 1-D 2-means on hue, min gap 8 deg. Leftovers alias to the nearest named cluster they `couldBe` within 40. Adjacency evidence (a face next to an oriented known face) can bind a name after 6 votes with a lead of 2. |
| Orient | `web/src/detect/orient.ts`, `scan-main.ts` `voteRotation` | Shared edges between two lettered quads pin each face's in-plane rotation; per-track majority vote; an edge-piece plausibility check retracts bad votes. |
| Vote | `web/src/assembly.ts` `StickerVoter` | Whole-frame 9-cell observations per cluster (reservoir 40), consensus = per-cell median after aligning each frame by the best of 4 rotations; lock gate needs 10 inliers and fit <= 10 per face, every 4 frames / 500 ms. |
| Lock | `web/src/state.ts` `assembleResolved` | Classify each consensus cell against the six centres in chroma-compressed space -> piece-based orientation resolve -> 4^6 rotation search -> if invalid, nine-per-colour balanced reassignment -> `validateState`. |

~2,300 lines across `colorid.ts`, `assembly.ts`, `state.ts`, `orient.ts`,
`identify.ts` (the older nominal path, now debug-only) and the colour half
of `scan-main.ts`.

## 2. The failure log (one day of phone testing)

Each row is a real capture in `web/test/fixtures/` (see its README) with a
test that reproduces it. Read the "fix" column as a list of thresholds.

| Capture | Symptom | Root cause | Fix (threshold added) |
|---|---|---|---|
| 1789308171326 | wrong faces bound | adjacency binding cascaded from one wrong letter | bindings became votes (6 min, lead 2, contradiction cost 2) gated by `couldBe` |
| 1789308736891 | red merged into orange | red and orange 16 apart in ab, inside BIRTH_DIST | hue split at 8 deg for chroma > 30 |
| 1789309733443 | 10 clusters, "shouldn't there be 6?" | shadow/lit sides of one colour 22 apart | aliasing of leftovers to named clusters within 40 |
| 1789310783346 | junk cluster named red | skin/desk at chroma 23 | WARM_MIN_CHROMA 30 |
| 1789311565144 | yellow never appears; alien 800 | alien gate keyed on "6 clusters exist"; fragments got there first; dark blue aliased to white | gate on 6 *named* colours; WHITE_MAX_CHROMA 20; white never cool |
| 1789312588404 | yellow named green | "most negative a" with no green present; a 4-reading stray skewed the warm split | GREEN_MIN_HUE 125; weighted 2-means |
| 1789312538549 | white face filed as blue | GAN logo read as dark blue with the legacy ring | ring at 0.30 (`facePlan`); hue split 5 deg |
| session-0913 (6 captures) | every colour right, cube "invalid" | shadowed blue classified white at lock, bright red as orange | chroma compression (knee 20, slope 0.5), balanced nine-per-colour fallback, evidence gate (10 inliers, fit 10) |
| 1789315824514 | two white faces, no blue | blue centre (-0.3, -19.7) is 16 from white; hue split needs chroma > 30 | never merge b < -14 with b > -8 when either is neutral |
| 1789317142821 | no green after 484 ticks | hue split fragmented blue and yellow, ceiling forced green into yellow, names memoised on stale centroids | hue split warm-only; evict at ceiling; version bump per reading |

Plus the lock-stage rules that exist because classification alone was not
enough: piece-based rotation resolve, 4^6 rotation search, balanced
assignment, `validateState` as the final oracle.

## 3. Why it is structurally fragile

1. **Identity from one sticker.** A face's colour is decided by its centre
   reading alone. The centre is the worst sticker on the face: it carries
   the logo, it is where a fingertip lands, and on a dark cube it is the
   reading most often in shadow. One bad centre re-files all nine cells
   of that frame under the wrong colour, and the reservoir mixes them in.

2. **Online clustering with hard thresholds has no objective.** Birth 20,
   merge 10, hue split 5 deg above chroma 30 below hue 90, cap 10, alias
   40, cool/neutral boundary at b -8/-14: each number was measured on one
   capture and each later capture found readings on the wrong side of
   one of them. Results depend on arrival order (which reading founded a
   cluster) and there is nothing that says "this partition is better than
   that one". Any batch method (k-means/GMM with k=6 over all readings,
   or the constrained assignment below) has a score and can be tested
   for optimality; this cannot.

3. **Naming by predicates fights illumination.** "Blue has b < -8",
   "white has chroma < 20", "yellow has hue 78-120" are absolute
   statements in a space we chose *because* it is relative. Measured
   swings in one afternoon: blue (16, -61) lit vs (6, -28) shadowed; a
   pale yellow at (-10, 40); white under a monitor at b -9; red at hue 33
   in one session and 45 in the next, orange at 44-55 in both. Every
   predicate has been moved at least once. The one thing that actually
   holds across sessions is *ordering* (blue is the coolest, white the
   least chromatic, red warmer than orange) and *counts* (nine of each,
   six distinct centres) - and those are exactly what the predicates
   don't use except at the very end.

4. **Clustering, naming and voting are coupled by cluster id.** A split
   cluster means a face's frames are spread over two ids and neither
   locks; a merge means two faces' frames pool and the per-cell median is
   garbage; an eviction drops votes. Names are re-ranked every reading, so
   a face can be "U" this frame and "D" the next, and every orientation
   vote cast under the old name has to be thrown away (`rotations` is
   keyed on the cluster the vote was cast for). Half the code in
   `scan-main.ts` exists to keep these three structures consistent.

5. **Most evidence is thrown away before it is weighed.** Seam veto
   (230-550 of ~700 face-frames per capture), obscured-centre refusal
   (61/120 ticks on a logo'd white face), alien gate, ambiguous-centre
   refusals in the nominal path. These are binary gates in front of a
   voter that already takes medians and counts inliers. A frame with a
   doubtful centre still has eight good stickers; we drop all nine.

6. **The sticker-level constraint arrives last.** Nine of each colour,
   six distinct centres, twelve distinct edges, eight distinct corners:
   this is the strongest information we have and it is used only as a
   fallback repair after a free per-cell classification has already gone
   wrong. `docs/rubiks-vision-analysis.md` section 5 explains the exact
   decoder that makes it the *primary* step.

7. **Crushed L is a double-edged normalisation.** Weighting L by 0.15
   makes clustering exposure-invariant, which is why white vs yellow and
   white vs pale blue then have to be decided in ab alone - and those are
   the pairs that keep colliding (16 apart, 12.8 apart under a cast).
   Lightness relative to the face's own median IS informative (white is
   the brightest sticker on any face that has one); we discard most of it.

## 4. What is solid and worth keeping

- **Geometry.** Quads from the detector, `QuadTracker` (alpha-beta filter,
  velocity over the detection gap), `warpQuad`, `facePlan` sampling
  geometry, the sample-patch overlay for checking it. Fixed 2026-09-13
  after the wiggle report; leave alone unless a capture shows otherwise.
- **Orientation from shared edges** (`orient.ts` `resolveOrientations`,
  `sharedEdgeCells`, `edgePiecesPlausible`). The mapping of which cells
  meet across which edge is verified and tested; the piece-plausibility
  check is a good idea independent of how colours are found.
- **`validateState`** in `state.ts` as the legality oracle (cubejs itself
  lies on invalid states - see memory).
- **Lock helpers in `state.ts`**: `resolveByPieces`, `resolveByRotation`
  (4^6 search with unique min-turn answer), `rotateCells`, the
  nine-per-colour `assignBalanced`. Pure, tested, reusable with any
  classifier.
- **The replay methodology.** `Capture debug` on the phone dumps the last
  120 ticks, clusters, tracks, votes, pairing log, lock attempt and now the
  stats line; `test/session-replay.test.ts` drives captured evidence
  through the lock and compares to a known truth
  (`LRFLUFLBUBLDLRRRRFDDRUFDUFDFDBUDFRDLBBBULFULLRBUUBBDRF` for
  `session-0913/`). Whatever replaces the pipeline should be developed
  against these fixtures first and the phone second.
- **Debug UI.** Six coloured 3x3 lock-attempt grids, sample-patch overlay,
  Pause, cluster table, stats line. The user relies on these.
- **Performance** is no longer the constraint: ORT in a worker with 4
  threads, stage 1 15 ms, stage 2 28 ms, colour pipeline ~10 ms on the
  detection frames only, loop at 100+ fps on the phone.

## 5. Numbers to design against (measured on the phone, crushed-L ab)

- Sticker colours are far apart when lit: red (66, 48)..(68, 68), orange
  (39, 52)..(62, 67), yellow (-16, 69)..(-32, 80), green (-52, 33)..(-63,
  58), blue (7, -40)..(14, -61), white (-6, -6)..(0, -2).
- The same sticker moves 20-30 units between lit and shadowed, mostly
  along chroma, little along hue (this is why chroma compression helped).
- Hard pairs: white vs dark blue (12-16 apart), white vs pale yellow
  (~20), red vs orange (16 in ab, 8-12 deg in hue, and the hue gap is not
  stable across sessions), white under a coloured cast vs the real
  colour.
- Junk that reaches the sampler: skin (chroma 20-28, hue 30-50), wooden
  desk, the GAN logo (reads dark blue/grey), black seams when a patch
  spills over a rounded corner, glare (blown-out white on any sticker).
- Per session: ~700 confident face-frames per 120-tick window, of which
  the current gates keep 25-60%.

## 6. Directions for the redesign

Options, roughly in order of how much they change:

**A. Batch, constrained colour assignment over all stickers (recommended
first).** Stop deciding identity per frame. Keep, per *track*, all nine
readings of every frame with the geometric information we already have
(which track, which frame, shared-edge pairings). At lock time - or every
N frames as a running attempt - solve one global problem: partition all
readings into six colours subject to the cube's constraints (nine per
colour, six distinct centres, edges/corners distinct), score = within-
colour spread. This is the exact decoder of `rubiks-vision` (section 5 of
the analysis doc; ~300 lines, MIT) fed by a 54x6 evidence matrix - but the
matrix should come from a *fitted* six-colour model (k=6 GMM / k-medoids
over the readings, initialised from the six most mutually distant centre
medians), not from the hand-written predicates. Names are assigned last,
from the ordinal properties of the six fitted centres (coolest = blue,
least chromatic = white, warmest split by hue = red/orange), which is the
only use of those predicates that has proven stable. This deletes
`ColorClusters`, the binding votes, the alias logic and the alien gate.
It can be built and validated entirely on the existing fixtures with the
replay test: the target is every session-0913 capture and 1789315824514 /
1789317142821 locking to the known truths.

**B. Softer evidence, fewer gates.** Replace binary vetoes with weights:
blur (variance of Laplacian), motion (corner speed), seam score, centre
ring spread, patch saturation - all become per-reading confidences that
the batch solver multiplies in. A face with a doubtful centre still
contributes eight cells. Per-face von Kries white balance anchored on the
brightest low-chroma patch (analysis doc, section 6) is cheap and directly
attacks the cast problem.

**C. Learned colour model.** A tiny classifier (patch statistics or a
9x9 crop -> six logits + junk) trained on our own captures: we now have a
dozen sessions with known truth states, and every capture stores the raw
Lab cells per quad. This is what `rubiks-vision` did after their classical
path plateaued. Higher ceiling, needs a labelling/training loop; do it if
A+B still confuse red/orange or white/yellow under warm light.

**D. More geometry from the detector.** Add nine sticker-centre outputs to
the anonymous-quad head (no relabelling: centres follow from the quad by
homography), giving per-sticker identity and finger tolerance. Or the
user's suggestion: detect cubicles/corners directly and derive faces by
line fitting. Independent of A-C; do not start here, the quads are not the
weak link today.

Whatever is chosen: keep the phone-capture -> fixture -> replay test loop,
and keep the six-grid lock view. Decide the design with a written
objective function before writing thresholds.

## 7. Open questions for the next session

- Should a running lock attempt happen every ~500 ms as now, or only when
  all six centres have been seen? (A batch solver is cheap enough to run
  continuously; the question is what to show while it is under-determined.)
- Is per-track identity enough, or do we need the tracker to carry an
  explicit "this is the same physical face as track N was" across
  re-acquisitions? Today a new track id after a coast means the frames
  are only connected through the colour cluster.
- How much of the seam veto is refusing good faces? 230-550 vetoes per
  window is suspicious; it was tuned on the older, less accurate quads.
- The GAN logo: the ring at 0.30 disagrees with itself 30-57 Lab on the
  white centre at typical face sizes. Check the patch overlay; pull the
  ring in or take the medoid of four instead of the two furthest.
