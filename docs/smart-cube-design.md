# Smart cube: decisions and design (2026-09-16)

Companion to `docs/smart-cube-trainer-survey.md` (the landscape and the
full feature catalogue). This is what we build, in what order, and why.
Read with `docs/solve-tracking-design.md` (the camera move reader) and
`MILESTONES.md` M9-M13.

---

## 0. Decisions (user, 2026-09-16)

- **The cube: GAN356 i Carry E**, the 2025 chargeless model. Per GAN's own
  listing it has **no gyroscope** (the app's cube will not turn with your
  hands; rotations are invisible), a replaceable coin battery (~330 h) and
  a smart core in the i Carry family, so a GAN Gen2/Gen3-family protocol;
  the libraries detect the generation on connect. Expect the GAN MAC step
  (section 3.6); csTimer's wiki recommends the Chrome flag
  `chrome://flags/#enable-web-bluetooth-new-permissions-backend` for new
  GAN cubes.
- **Devices:** the Android phone (Chrome) day to day; desktop Chrome on
  the Windows box with the LifeCam webcam for recording sessions. Both
  have Web Bluetooth. No iOS.
- **Purpose, in this order.** (1) The cube is a *labelling instrument*:
  ground truth for the camera move reader and training data for a video
  move model. The user does not plan to keep using it once the camera can
  read moves. (2) The app **replaces csTimer**: sessions, averages, PBs and
  history live here. (3) Every trainer feature in the survey is wanted
  eventually; no ranking was given, so the order below is a proposal.
- **Method:** ZZ with **EOCross**. Last layer stays OCLL + PLL as the tabs
  are; bigger sets and spaced repetition are "later".
- **Yes:** planning drills (EOCross, EOCross+1, planned vs executed); a
  live view of what the app believes the cube looks like. **Later,
  written down:** lookahead tools (survey 3.8), LLM commentary (opt-in),
  PWA install, alg spaced repetition, gestures, sounds. **No:** social.
- **"Python ML to be more efficient"** is read as: learn the move reader
  from cube-labelled video on the `model/` side instead of hand-calibrating
  the beam reader, with the recipe that worked for the detector (synthetic
  first, real fine-tune). Section 5. Flagged for confirmation.

**The one consequence that shapes everything:** because the cube is
temporary, nothing may work *only* with the cube. Every consumer (drills,
timer, analysis, the live view, follow mode) takes a `MoveSource`, and the
cube is one of four sources. That is also what makes the timer double as
the data-collection rig: a solve timed at the desk with the webcam on is a
labelled recording, with no extra step.

---

## 1. The spine: `MoveSource`

```ts
// web/src/moves/source.ts
export interface MoveEvent {
  /** the turn, in the source's own letters (see colourOf) */
  move: Move;
  /** host clock, ms (performance.now() domain shared with the camera and the recorder) */
  t: number;
  /** the source's raw clock when it has one (the cube's ms counter), else undefined */
  tRaw?: number;
  /** the camera reader's certificate; the cube's events are always sure */
  sure: boolean;
}
export type SourceItem = MoveEvent | { kind: 'gap'; t0: number; t1: number; minMoves: number } | { kind: 'resync'; t: number; facelets: string };

export interface MoveSource {
  readonly kind: 'cube' | 'camera' | 'typed' | 'replay';
  /** letter -> colour for this source's letters (the lock's for the camera, the scheme's for the cube) */
  readonly colourOf: Record<FaceId, ColorName>;
  /** the state the source believes the cube is in, in its letters (null = unknown) */
  state(): string | null;
  /** items since the last call, in order; the consumer applies them */
  drain(): SourceItem[];
  /** tell the source what the cube actually is (a scan lock, "solved", a fix): it re-bases */
  resync(facelets: string): void;
  subscribe(cb: (item: SourceItem) => void): () => void;
  dispose(): void;
}
```

- The camera reader already produces exactly this shape: `MoveRecord`
  items (`move`, `burst`, `gap`) with `t0/t1`, `margin`, `sure`; a burst
  becomes its moves at `t1` in recorded order (unordered bursts keep the
  `ordered: false` flag on each event). `follow.ts` consumes "lock +
  moves in the solver's letters" today; it becomes a `MoveSource` consumer
  and nothing downstream of it changes.
- The cube's letters *are* colours: GAN reports faces in the cube's own
  frame, fixed by its core, so on the i Carry E's standard scheme the
  cube's `U` is white, `F` green, `R` red, `D` yellow, `L` orange, `B`
  blue. The adapter's `colourOf` comes from the scheme setting
  (`cube/scheme.ts`), so a non-standard cube is a setting, not code.
- A `typed` source wraps the moves box (what the drills have now) so the
  drills have one code path. A `replay` source plays a capture (section 7)
  through the same reducers as live events: the regrip project's
  "deterministic replay", our "fixtures beat mocks".
- Gaps are first-class. The cube never emits one; the camera does; the
  analysis refuses to split a solve with a gap inside a phase rather than
  guess, exactly like the colour lock.

---

## 2. Milestones

| | Name | Ends with | Needs the cube? |
|---|---|---|---|
| **M9** | Cube in the loop | the i Carry E mirrored live on the phone and the desktop; captures replay in tests; drills accept the cube | to finish, not to start |
| **M10** | Timer and recording rig | csTimer retired; every desk solve is a cube-labelled webcam recording; the reader's accuracy is a number | yes |
| **M11** | ZZ analysis and coaching | phase splits, pauses, optimal comparisons, case memory, the bottleneck card, trends | no (works on any move list) |
| **M12** | Planning drills and cube-judged drills | EOCross / +1 planning with planned-vs-executed; recognition vs execution in every drill | no |
| **M13** | Video move model | a learned turn reader exported as a third ONNX stage, fed to the app as a `MoveSource` | data from M10 |

Order rationale: M9 is the foundation and mostly scaffolding until the
cube arrives. M10 first because it is the reason for the cube *and* the
csTimer replacement, and because the data it records is what M13 needs;
its capture format is fixed now (section 7) so no recording is wasted.
M11 is what makes the timer better than csTimer and needs no hardware.
M12 is the trainer half proper. M13 is the long pole and can start the
moment M10 has a few dozen solves; its design is in section 5 so M10
records the right things (full-rate video, stage-1 boxes, raw and fitted
cube times, resyncs).

Later, written down: lookahead tools (survey 3.8), LLM commentary (survey
3.7, opt-in, the one network call), alg spaced repetition and bigger LL
sets (survey 3.5), gestures on the cube, sounds, PWA install.

---

## 3. M9: cube in the loop

### 3.1 `web/src/smart/`

| file | job |
|---|---|
| `adapter.ts` | the only file that imports `smartcube-web-bluetooth` (MIT, installed from GitHub). `connectSmartCube()`, `conn.capabilities`, `conn.events$` -> our events; letters -> colours via the scheme; `REQUEST_FACELETS` on connect and every few seconds while idle (drift check); `REQUEST_BATTERY` on connect and every minute |
| `clock.ts` | the two-clock fit: every move keeps `tRaw` (cube ms) and host `t`; a running linear fit (the csTimer method, `cubeTimestampLinearFit` in the library) gives `tFit`; per-move timing uses `tFit`, never host time, while the record keeps all three |
| `belief.ts` | the belief: facelets at connect (or the last resync) plus every move applied with `cube/state.ts`; compared with each `FACELETS` report; on disagreement the chip goes amber and offers the three resyncs |
| `capture.ts` | one JSONL line per event (`connect`, `facelets`, `move`, `battery`, `resync`, `disconnect`) with both clocks; `replay(lines)` feeds the same reducer chain; fixtures in `web/test/fixtures/smart/` |
| `source.ts` | `CubeSource implements MoveSource` |
| `ui.ts` | the chip: connect / name / battery / link age / state agreement; the MAC step; the resync menu |

### 3.2 Resync, three ways

1. **"It is solved"**: belief := solved, and the cube is sent `REQUEST_RESET`
   so its own facelets say so too. The cube keeps its state in firmware
   and drifts when it misses a turn (2026-09-19: solved in hand, reported
   scrambled from the moment it connected, every report agreeing with
   the belief); without the reset the next report would disagree again.
2. **From a scan lock** (unique): the scanner's lock, mapped by colour to
   the cube's letters, becomes the belief. Also how a cube that was
   scrambled while disconnected gets its state without solving it.
3. **A fix alg**: the belief is trusted and the cube's own report is not
   (a missed turn): show the shortest alg from the reported state to the
   belief (cubejs: solve(reported) then the inverse of solve(belief)), or
   the reverse when the report is trusted.

The cube's own `FACELETS` report is the arbiter when it exists and agrees
with itself twice in a row; the scan is the arbiter when the report and the
belief disagree and the user says which is right.

### 3.3 The live cube view (`ui/cubeview.ts`)

What the user asked for: "see what the app thinks my cube looks like".

- The belief as the 3D render plus the net (`cube/render.ts`, both exist),
  animated per move (a 90 degree tween, ~80 ms, no queue longer than one:
  the view snaps if it falls behind), a badge naming the source (cube /
  camera / typed / replay), the last move and the time since it.
- Amber outline when the source's belief and the cube's own report
  disagree; grey when the source has a gap open.
- Hosted in the scan sheet's dock after a lock (follow mode already docks
  there) and as its own sheet from the tab bar so it can be up while
  drilling. On the desktop, a wide layout with the webcam frame beside it:
  the recording rig's monitor.
- No gyro on this cube, so the view's orientation is the trainer's hold
  (white down, the chosen front), which is the frame every picture in the
  app already uses; a rotation-aware view is a later cube's feature.

### 3.4 Drills take a `MoveSource`

`ui/drill.ts`: when a source other than `typed` is active, the moves box
fills as the cube turns (read-only, the typed path stays for no-cube use),
the timer starts at the first event after New and stops when `stage.ts`
says the stage target holds (EOCross for the EO tab, the slot for F2L,
corners oriented for OCLL, solved for PLL), and Check fires itself.
Recognition (New -> first event) and execution (first -> last event) are
both stored with the attempt (M12 uses them).

### 3.5 What can be built before the cube arrives

Everything except the last check: the interfaces, the typed and replay
sources, the camera reader as a source (follow mode gains the live view
today), the capture/replay round trip, the chip and the resync menu, the
drill integration driven by the typed source, the adapter compiled against
the library's types. The adapter's first run is a checklist (section 8).

### 3.6 The GAN MAC step

GAN Gen2+ derives its AES key from the cube's MAC address, which Web
Bluetooth hides. The libraries try `watchAdvertisements` (needs the
permissions-backend flag on some platforms) and otherwise take a
`customMacAddressProvider`: a one-time dialog "type the MAC printed in the
CubeStation app / on the box", remembered in localStorage per cube name.
Budget an hour for this on each device.

**Done when:** the i Carry E connects on the phone and on desktop Chrome;
each turn shows on the live view within ~100 ms; a deliberately drifted
cube is resynced from a scan lock; one captured session replays through
the tests and the EO drill completes itself from cube turns.

**Built 2026-09-16, before the cube arrived (everything but its first
run):** `moves/source.ts` (the contract), `smart/` (adapter over
`smartcube-web-bluetooth` 4.0 with the MAC dialog, `ClockFit`, the belief
reducer with the settle window, JSONL capture + replay, `CubeSource`),
`moves/drive.ts` (the driver: arms at the scramble state, feeds the turns
after it, re-arms on an undo, starts over on a new scramble, disarms on a
resync), `ui/cubeview.ts` (the Cube sheet, key `l`: 3D + net in the
trainer's hold via a cached whole-cube rotation, the source badge, the
last turn, connect / disconnect / save, the three resyncs and the drift
warning), `Stage.feed` on the EO and last-layer tabs with `isDone` per
stage (EO's goal setting decides EO vs EOCross; the last layer counts the
AUF), the camera's belief on the sheet while following. The report poll
runs every 4 s once the cube has been idle 2 s. Tests:
`test/smart.test.ts`, `test/drive.test.ts`, fixture
`fixtures/smart/synthetic-session.jsonl`; end to end without a cube:
`node scripts/check-smart.mjs` replays a scramble-then-undo capture
through the built page via `window.ZZ.smart.replay` and checks that the
EO drill armed at the scramble, boxed the undo in the trainer's letters,
timed it from the cube's stamps (0.90 s for six turns 180 ms apart) and
checked itself at EOCross. Not built: the scan-dock hosting of the view,
gestures, the 90 degree tween (the view snaps). Open until the cube is
here: section 8.

---

## 4. M10: the timer and the recording rig

### 4.1 Timer ("Solve" tab)

- Random-state scrambles (cubejs), shown in WCA orientation as everywhere.
- **Scramble following:** the applied prefix underlined from the cube's
  moves; a wrong turn flips the chip red and offers, in order, "undo the
  last k" when the prefix before the error matches, else a fix alg from the
  current belief to the scrambled state (cubejs, section 3.2.3).
- **Inspection:** WCA 15 s with 8 / 12 s cues, or unlimited (a setting
  the planning drills flip). Pickup = inspection end to first turn.
- **Auto start/stop:** first turn after "scrambled" starts; solved stops.
  "Scrambled" is set by the checker, by a tap, or later by a gesture.
- **Results:** +2 / DNF, comment, delete; ao5 / ao12 / ao50 / ao100, mo3,
  best / worst, session mean; a time-series graph with the averages as
  lines.
- **Storage:** `web/src/store/` on IndexedDB; a solve keeps its full move
  stream (a few KB). Export JSON (ours) and csTimer's export JSON; import
  csTimer's export once to bring the history over.
- The reconstruction line and a replay scrubber over the live view: M11
  adds the splits under it.

**Built 2026-09-17:** as above, in `web/src/timer/` (`trainer.ts` the
tab, `stats.ts` the averages with csTimer's 5% trim, `cstimer.ts` the
file both ways, `track.ts` scramble following) and `web/src/store/`
(`local.ts` IndexedDB with dirty marks and last-edit-wins `applyRemote`,
`sync.ts` the optional Firestore layer, `firebase.ts` the only SDK
import, loaded lazily). The driver's `armed` and `watch` hooks on
`Stage` carry the cube's belief and the arming moment to the tab. Records
are in WCA notation (a standard smart cube's own letters). Decisions:
**no inspection countdown and no inspection penalties** (user,
2026-09-17: start at the first turn, stop at solved; +2 / DNF are buttons
only); the gap from "scrambled" to the first turn is still stored on the
solve as `inspection` for later; the next scramble is
prefetched so it appears the instant a solve ends; the sync pulls with a
snapshot listener on `updatedAt > last seen` (server timestamps) and
pushes dirty records in batches of 400. Firestore rules:
`firebase/firestore.rules`. Sign-in happens on `signin.html`: the app
runs cross-origin isolated (COOP same-origin, for wasm threads), which
cuts a popup off from its opener and made the in-app popup end in
`auth/popup-closed-by-user` on the first try (2026-09-17); the service
worker serves the sign-in page without those headers and the app reads
the user back from the shared IndexedDB persistence. Not built: a time
graph, sessions renamed or deleted, and the recording rig below.

**2026-09-20:** a session is a sitting. A solve more than two hours after
the session's last one starts a new session by itself, named by the clock
(`2026-09-20 14:32`; `SESSION_GAP_MS`, `rollSession` in `trainer.ts`),
and the toast says how long the gap was; New session remains for a
deliberate split. The list shows when each solve was (the clock for
today's, the day for older ones; the full stamp on hover), and the picker
shows each session's span and count; nothing new is stored, it all reads
off `when`. The header grows a ⚠ chip whenever the cloud is not taking
the solves: sync wanted but signed out, a failed push or listener, or
records pending for over a minute (or any while offline: the SDK queues a
commit and never rejects it, so `pending` sitting there is the only
sign). `syncWarning` in `sync.ts` is the rule; the chip opens the
settings sheet, whose sync row now counts the records waiting.

### 4.2 The recording rig (desktop)

**Built 2026-09-17, the sink half:** `vite.config.ts` `recordingSink()`
serves `/__recording/` (a probe) and `POST /__recording/<session>/<file>`
with `?append=1` for appends, writing under `<repo>/recordings/<session>/`
(gitignored: gigabytes, personal). `web/src/rig/stream.ts`
`RecordingStream` is the page's client: one ordered queue of small POSTs,
a retry then a failure count, `available()` false on the deployed site so
the download path stays. Wired the same evening: `app/rig.ts` holds the
current session; the scan sheet's Record starts one when the sink probe
succeeds and streams each one-second chunk as it arrives, the smart cube's
capture header and every event go to `cube.jsonl` (`app/smart.ts`), the
timer files each solve's host-clock window to `solves.jsonl`, and the
capture that Stop triggers becomes `evidence.json` and closes the session.
`node scripts/check-rig.mjs` exercises it headless with a fake camera.

**2026-09-18, the header Record button** (`app/record.ts`): the scan sheet
is the wrong place to start a sitting from (reopening it after a lock
resets the scan and empties the evidence log, so the captures held a
second of readings), so the tab bar gets a Record button, shown only where
the sink answers. One press opens the webcam, starts a session, streams the
video (same settings as the scan sheet's recorder) and shows a small live
view in the corner so the cube stays in frame; the cube's events and the
timer's solves reach the session as before. No scanner runs and no
`evidence.json` is written: the raw video and the cube's turns are the
material, and the pipeline can be re-run on the video offline.
`node scripts/check-record.mjs` is its headless check.

**2026-09-19, one Record.** The header button records THROUGH the
scanner: it opens the scan sheet docked (kept, not reset, so the
evidence log survives), starts the camera and the scanner's own
recorder, so every recording has `evidence.json` and can be a reader
fixture; the docked sheet is the live view and a ⧉ button beside Record
floats the camera in a Picture-in-Picture window. The scan sheet's
Record does the same thing from inside. The scanner-less path went with
it: `app/record.ts` is now a thin front over `scanner-bridge`'s
`sitting`. Cost on the desktop: the detector runs while recording.
The evidence log is kept until the post-stop capture has been written
(it was trimmed to its last 40 s in the 800 ms gap before). And when a
session closes, the dev server cuts **one clip per timed solve** into
`<session>/solves/NN-<id>.webm` (three seconds before the first turn to
one after the last, re-encoded for an exact cut) with `NN-<id>.json`
beside it: the solve record, the cube events inside the clip and the
host-to-clip clock offset (`scripts/cut-solves.mjs`, ~3 s per solve).
The session's `video.webm` stays as the continuous take.

- The existing recorder (scan sheet `Record`: camera `.webm` + the
  evidence-log capture on one clock) gains the cube's events on the same
  clock (section 7, capture v2). With "record solves" on, every timed
  solve at the desk records itself: video from the moment the scramble is
  confirmed applied to a second after solved.
- **Latency calibration (once per cube, per device):** ten slow single
  turns on camera; for each, the frame in which the layer visibly reaches
  90 degrees against the cube's fitted event time; the median offset is
  stored in the capture header and applied when labels are derived. The
  same session measures skew (fit slope) and the missed-turn rate at
  speed (cube moves vs a typed alg of 50 turns).
- `tools/solve/moves_fixture.py --truth cube`: truth from the capture's
  cube events instead of typed moves; the fixture also keeps the per-turn
  times, which typed truth never had.
- **Reader calibration:** replay every labelled recording through
  `web/src/moves/` and report, per recording and overall: turns read /
  true turns, false turns, gaps, timing error per read turn, and the
  certificate's calibration (how often a `sure` turn is wrong). This is the
  first honest number for the camera reader and the baseline M13 has to
  beat. Numbers go in `docs/solve-tracking-design.md` 10.2.

**Done when:** csTimer is no longer opened (its history imported); twenty
solves exist as cube-labelled recordings; the reader's numbers are written
down.

---

## 5. M13: the video move model

### 5.1 What we have to learn from

Per frame at 30 fps (desktop) or the phone's rate: the stage-1 cube box,
up to three face quads, rectified 90x90 faces, colour readings; and from
the cube, every turn with a millisecond time. What the camera reader does
today is hand-built inference over the readings (beam Viterbi, design doc
10). It cannot see *mid-turn* frames at all: a quad on a turning layer is
two half-faces, the tracker follows quads rather than faces, and readings
under fingers are censored. The turn itself is the signal we throw away.

### 5.2 Options

- **A. Learn the reader over the existing readings.** A small temporal
  model over per-frame sticker readings -> turn events. Cheapest, but it
  inherits every blind spot above; it would mostly re-fit the beam
  reader's costs. Not worth a separate model.
- **B. A video model on the cube crop.** A short window (8 frames) of the
  stage-1 crop at ~128 px -> which turn (18 face turns + none) and its
  progress. Trained on synthetic turn clips plus the real recordings. The
  strongest signal, but a new architecture (temporal), a new generator
  dimension (video with motion blur and moving hands), and the most data.
- **C. A twist head on stage 2.** Per single frame, from the crop stage 2
  already sees: *which layer is mid-turn, which way, and how far* (layer
  id 0-5 or none, direction, angle 0-90). The generator already twists one
  layer by 2-20 degrees in 22% of renders with exact labels
  (`model/gen/scene.mjs` "layer misalignment"); extending the range to
  0-90 and labelling it is a small change, and every frame is a label, no
  video needed. Real labels come from the cube: for a turn at fitted time
  T with measured latency L, frames in [T - L - d, T - L] are "layer X
  turning direction s" (d = a turn-duration prior, ~150-300 ms, measured
  in M10) with a tolerant (soft-window) loss; the angle in between stays
  unsupervised on real frames. Runtime cost: one more head on a network
  the phone already runs at 60 fps.

### 5.3 Plan

**C first, with the beam reader as the integrator.** The twist head's
per-frame output ("red layer turning clockwise, ~40 degrees") becomes one
more evidence channel in the reader's cost, next to the sticker readings:
a turn hypothesis that the twist channel saw is cheap, one it did not see
during a visible interval is expensive, and the turn's *time* comes from
the angle sweep rather than from the first frame that showed the new
state. This keeps the reader's gap handling (turns inside the hand, which
no model can see; the depth-3 state search covers them) and its
certificates, and gives M13 a measurable target from day one: the reader's
M10 numbers with and without the channel.

**B is the fallback** if the single-frame twist signal is too weak under
motion blur at speed (a 90 degree turn at 8 TPS spans ~4 frames at 30 fps;
mid-turn frames are blurred, and the generator will need blur and
mid-turn hands for C too). Decide on the M10 recordings: if fewer than
half the real turns show a readable twist on at least one frame, go to B.

**Training data.** Synthetic: the existing generator with the twist range
opened to 0-90 degrees, direction and layer labelled, motion blur along
the twist, a hand on the turning layer in most such renders; the same
`data_v*` recipe, then the real fine-tune with the cube-labelled frames,
selected on a held-out set of *recordings* (never frames from a recording
in the training set: contiguous time blocks, as the clip batches do).

**Export and app.** The head ships inside `facekp.onnx` (static shapes,
fp32, the same gates), `detect/facekp.ts` decodes it, the sampler passes
the twist observation to the solve worker alongside the readings, and
`moves/reader.ts` scores it. A `camera` `MoveSource` is then the whole
camera path; the cube goes in a drawer.

**Metrics** (held-out real recordings): turns read / true, false turns,
gaps per solve, timing error per turn, and the reader's certificate
calibration, all against the M10 baseline.

**Built 2026-09-19 (the synthetic half; `model/README.md` "Layer twist").**
Two things the sketch above got wrong, settled while building it:

- *"Layer id 0-5" is not available to stage 2*: its quads are anonymous.
  The head is therefore PER QUAD: none / self (this quad is the turning
  layer) / edge k (the layer across the quad's k-th edge is turning, its
  row sliding). The label still says "face X, deg"; `targets.py` derives
  the per-quad class from the face adjacency and shifts it with the corner
  loss's cyclic-shift minimum. The reader maps a track's edge back to a
  move through the face identity and rotation it already keeps.
- *Direction is not a single-frame quantity*: a layer turned +30 is the
  same picture as one turned -60 (the slab is 4-fold symmetric about its
  axis), so the head regresses the angle mod 90 as (cos 4a, sin 4a) and
  the reader takes the direction from the sweep - 0, 20, 50, 80 is a
  clockwise turn, 0, 70, 40, 10 the other one. Sticker colours could in
  principle break the tie, but only with the state, which is the reader's
  job, not the head's.

Also decided: non-turning faces keep BODY-FRAME corners through a turn (the
turning face's quad is the rotated layer), and slice / wide turns are out
of the first head (`"face": "?"` masks such frames).

### 5.4 What M10 must record for this

Full-rate video (every frame, not only detection frames: the `.webm` does
this already), the stage-1 box and quads per frame (from `replay_clips.py`,
so a newer detector can re-label old video), cube events with raw and
fitted times, the latency offset, every resync, and the scheme.

---

## 6. M11 and M12 in brief

### 6.1 ZZ analysis (`web/src/analysis/`, pure functions, tests on recordings)

Phase boundaries over move prefixes with `stage.ts`, each the *last* time
the predicate becomes true and stays true to the end (a pair broken and
remade counts at its remaking):

| phase | ends when |
|---|---|
| inspection | first turn (pickup measured separately) |
| EO | every edge oriented to the F/B axis |
| EOCross | EO and the white cross (EOLine is the same with two edges, a setting) |
| pair 1..4 | slots solved, in the order they were solved |
| OCLL | all last-layer corners oriented |
| PLL | solved, less the final AUF |
| AUF | the trailing U-layer turns |

Per phase: time, moves (HTM), TPS, **recognition** (the pause before its
first turn) vs **execution**; pauses above a threshold (DECISION: 300 ms;
a setting) located in phase and pair; fraction of time turning.
Comparisons: EO and EOCross optimal for this scramble (`eo/solver.ts`,
the EOCross worker), pair move counts against `f2l/data.ts`, last-layer
alg lengths against `ll/cases.ts` with the executed alg identified up to
AUF and misturns (a move immediately undone). Case tagging fills the
per-case memory from real solves. The **bottleneck card**: each phase as a
fraction of the solve against the user's own median over the last 50
solves, one sentence naming the phase to work on. Trends: per-phase
medians per session, TPS, pause fraction, recognition per case.

### 6.2 Planning drills (M12)

- **EOCross planning:** scramble shown, inspection unlimited (timed), the
  user may declare the plan (tap the moves, or type) or just go; the cube
  judges: EOCross solved or not, moves vs optimal, planned vs executed
  (first divergence marked), inspection time against the 8 s goal, and
  execution time. Stored per attempt with the scramble so a bad one can be
  retried.
- **EOCross+1:** the same with the first pair: which slot was planned,
  which was done, and the pause between EOCross and the pair.
- **Drill feedback** in the four stage tabs from M9's recognition /
  execution split: per attempt now, per case over time in M11's memory.

---

## 7. Data formats

**Capture v2** (one file per recording, JSON; JSONL for the event stream
while recording so a crash loses nothing):

```
{ version: 2, startedAt, device, scheme,
  video: { file, w, h, fps },            // the .webm beside it
  evidence: { ... as today ... },        // the colour pipeline's log
  cube: { model, name, protocol, capabilities, latencyMs, fit: { slope, offset, n },
          facelets0, events: [ { kind, t, tRaw?, tFit?, move?, facelets?, level? } ] },
  truth: { moves: [ { move, t } ], source: 'cube' } }
```

**Solve record** (sessions store): `{ id, when, session, scramble, hold,
scheme, penalty, time, inspection, moves: [{ m, t, tRaw }], source,
capture? (id of the recording), analysis? (cached M11 output) }`.

**Fixtures:** `web/test/fixtures/smart/*.jsonl` (adapter and sync),
`web/test/fixtures/solves/` (reader fixtures, now with `truth.source:
'cube'` and per-turn times), `web/test/fixtures/analysis/` (solve records
with expected splits).

---

## 8. Checklist for the day the cube arrives

1. Desktop Chrome: flag on, connect, note protocol generation and
   `capabilities` (facelets / battery / gyro expected false).
2. MAC step: did `watchAdvertisements` work, or was the dialog needed?
3. Ten slow turns on camera: latency median and spread.
4. Fifty fast turns from a typed alg: missed-turn count, skew slope.
5. Phone Chrome: repeat 1-2; measure event-to-view delay.
6. Drift test: turn while disconnected, reconnect, resync from a scan.
7. Save the first capture as `fixtures/smart/icarrye-first.jsonl`.

**Status (2026-09-19):** the cube (GAN Gen4 protocol, name `GANicE2_F803`)
connects and records on desktop Chrome. Item 7 is done:
`web/test/fixtures/smart/icarrye-first.jsonl` is the session of
2026-09-19 09:41 (240 turns, 220 reports, two timed solves; the store's
records beside it as `icarrye-first.solves.jsonl`), and `smart.test.ts`
replays it: every report agrees with the belief, the clock fit is
+0.23% (the host runs slightly fast against the cube's counter, 64
pairs), each solve's window is exactly the turns the timer filed and
runs from its scramble to solved. Item 2: `watchAdvertisements` works on
desktop Chrome, the MAC dialog was never needed. Item 1: `GANicE2` sw
2.9 hw 1.0; capabilities facelets, battery, hardware, reset (the
library says gyroscope, the cube's own hardware report says none).
Item 3 (`tools/solve/cube_latency.py` over the first recording, the
scramble-following turns, 25 of 39 usable, 2026-09-19): the report's
fitted send time is **+5 ms median (MAD 22, p10/p90 -42/+33)** after the
frame that first shows the layer at rest, i.e. the GAN reports as the
layer finishes; against BLE arrival +10 ms median with a p90 of +102
(packets arrive up to 250 ms late, which the clock fit removes). Each
number is a lower bound within one 33 ms frame. Store `latencyMs: 5`.
Item 4 (`fixtures/smart/icarrye-fast.jsonl`, `smart.test.ts`): 98
turns in 29 s (four blocks of six sexy moves, one with an overshoot put
right), **nothing missed** - every report agrees and the cube ends
where it began. Packets carry two or three turns at once (arrivals 1-2
ms apart), arrival lateness p50 ~20 ms, p90 ~80, max ~250; the plain
least-squares clock fit swung its slope by 0.3% over that burst (100 ms
at the window's ends), so `ClockFit` now takes its offset from the
lower envelope of the residuals and keeps the slope at 1 until the
window spans a minute. Item 6: passes without a scan - after a
disconnect, three turns and a reconnect the belief restarts from the
cube's report (the banner seen for a few seconds is unexplained: no
capture of it yet). Item 5 (the phone) is not planned.

---

## 9. Not doing

Cubing.js (we have `cube/`), csTimer's GPL protocol code (MIT libraries
only), a backend of any kind, gyro-dependent features (this cube has
none), anything that only works with the cube connected.
