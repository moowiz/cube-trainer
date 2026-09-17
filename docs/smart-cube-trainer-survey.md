# Smart cube trainer: survey and feature catalogue (2026-09-16)

**Status: a survey, not a design.** A Bluetooth cube is on order (model
unknown to this doc) and the app is to become a trainer around it. This
collects what comparable apps do, what the hardware and Web Bluetooth
allow, and everything we could build, so the decisions in section 8 can be
made with the landscape in view. Nothing in sections 3-5 is committed to;
each item says what it is, why it matters for a ZZ solver, where it would
sit in this codebase, and a rough size.

Read with: `MILESTONES.md` (where the app stands),
`docs/solve-tracking-design.md` (the camera move reader this partly
supersedes), CLAUDE.md "Conventions" (colours not letters; everything
client-side).

---

## 0. What a Bluetooth cube changes for this project

- **The move stream is given.** Every face turn arrives as an event: face,
  direction, a cube-clock timestamp (millisecond resolution on GAN, MoYu and
  QiYi; host-clock only on GoCube/Giiker). The camera move reader
  (`web/src/moves/`, design doc section 10) took a week to reach "reads the
  synthetic solve, cannot read a dim room". The cube makes the reader a
  fallback for people without one, and gives it ground truth for free:
  every recorded solve with the cube connected is a labelled recording.
- **The camera keeps two jobs no smart cube app has.** (1) Reading the
  cube's *actual* state. Smart cubes drift: a missed turn at speed, a
  battery swap, a turn made while disconnected. Every app has a
  "reset to solved" button and a thread of complaints about it (acubemy's
  is "too hidden"); none can resync to an arbitrary scrambled state. Our
  scanner locks arbitrary states. (2) Hands and regrips, which the cube
  cannot see at all. (Measured weak in design doc 8.1, so job 1 is the one
  that matters.)
- **The trainer half already exists.** EO / F2L / OCLL / PLL stages with a
  timer, hints, a typed moves box with Check, per-session stats, follow
  mode (`follow.ts`, `stage.ts`). "Trainer" here therefore means: the cube
  replaces typing and the stopwatch, drills stop themselves when the stage
  target is met, and every solve becomes data the app can analyse.
- **ZZ is a good fit for move-stream analysis.** After EO the solve is
  rotationless, so the biggest weakness of a gyro-less smart cube (it
  cannot see cube rotations) barely bites; and every ZZ sub-step has a
  crisp state predicate `stage.ts` already computes (EO done, cross done,
  pairs 0-4, last-layer corners oriented, solved), so phase splitting is a
  scan over prefixes of the move list, not a heuristic.

---

## 1. The landscape: what exists

| App | Where | Cubes | What it does well | What to take |
|---|---|---|---|---|
| **csTimer** (cstimer.net) | web; Chrome/Edge desktop + Android, Bluefy on iOS | Giiker, GoCube/Rubik's Connected, GAN (Monster Go too), MoYu, QiYi | The reference timer. Scramble checking (underlines applied moves, shows a fix alg on a misturn), mark-scrambled by space or by a gesture on the cube, auto start on first turn, CFOP + Roux auto splits, ms-accurate reconstruction under "Review", OLL/PLL case statistics, virtual cube mirror, training mode (pick OLL/PLL/ZBLL cases; virtual scramble), battery | The scramble checker, the gesture marks, the timestamp linear fit (invented here), the case stats table. Code is GPL: reuse ideas, not files |
| **Cubeast** (cubeast.com) | web app, paid | "all 3x3 Bluetooth cubes" | Per-phase recognition vs execution, inspection / pickup / put-down times, all methods, cross-solve stats (XCross %, mean PLL recognition), StackMat, "Academy" drills (learn algs, recognition, XCross), share-a-solve links | The recognition/execution split, the phase vocabulary, shareable solve page |
| **acubemy** (acubemy.com) | web + iOS + Android, freemium | all brands | Reconstruction + splits, automatic OLL/PLL case tracking, weakness detection with targeted drills, spaced-repetition flashcards, gyro rotation replay, 1v1 races, tournaments, benchmarks against "3M+ solves". Complaints: aggressive monetisation, reset-cube-state hidden | Weakness -> drill loop, SRS for algs, gyro replay |
| **Cubedex** (cubedex.app, poliva, open source) | PWA, offline | any (via smartcube-web-bluetooth) | Alg drilling: subsets, ao5 + PB per alg, Not learned / Learning / Learned, random AUF, sort ordered / random / slowest first, mask the alg, "Scramble To" setup moves, custom algs; works with a dumb cube too. Requests: orientation randomisation, partial-solve detection, auto scramble-to | The whole drill loop; note our `ll/model` chain-partner trick removes the setup step entirely |
| **Sub-X** | web, free | GAN | Cross/F2L/OLL/PLL splits with time, moves, TPS each; "Where to Focus" compares phase times to a goal pace and names the costliest step; csTimer import alongside | The bottleneck card |
| **GAN CubeStation** | iOS/Android | GAN | AI tutorial, battles, CFOP segmentation with "5 parameters per segment" (move count, rotations, TPS, fluency, ...), alg recommendations. Widely disliked UI | Nothing to copy; a warning about bloat |
| **Speedcuber Timer** (Joseph Hale) | Android/iOS, offline | Giiker, GoCube, Rubik's Connected, HeyKube | Multi-puzzle, several cubes at once, CFOP reconstructions (ZZ and Roux "supported but not shown in the UI") | Evidence ZZ splitting is under-served |
| **bestsiteever ZBLL trainer** | web | none | Case selection, presets, recap of forgotten cases, timer; the ZZ community's ZBLL drill | The recap / preset model if ZBLL is in scope |
| **crystalcube trainers** | web | none | EOCross / EOCross+1 planning with unlimited inspection; used by fast ZZ solvers to practise planning | The planning drill (we already have the solver) |
| **smartcubeanalyzer** (cuberplus) | offline scripts | Cubeast / acubemy exports | Recognition and execution per case, failure rates, PBs to ao1000, streaks, distributions, cross colour | A list of stats people actually compute |
| **regrip** (wstein) | web dev console | GoCube, GAN | Gyro -> virtual x/y/z regrips, gesture triggers (a returned face like R R', a shake), deterministic JSONL replay through the same reducer chain as live events | The record-and-replay architecture, which is exactly our fixture philosophy |
| **BLDTrainer** | iOS + web | smart cube | 3-style drills driven by the cube, cases prioritised by slowest / least trained | Priority ordering ideas |
| **Cube-Vision** | iOS (Android in test) | none: camera only | Camera move reconstruction, needs top + front in view, CFOP splits, hand tracking for start/stop | A competitor to our camera reader; confirms the "camera above, two faces" grip finding |

Practice advice from the ZZ community that a trainer should encode
(speedsolving "Getting fast with ZZ", zzmethod.com): EOCross planned in
~8 s of inspection, executed in ~1.5 s, <= 9 moves on average; EOCross+1
planning with unlimited inspection; untimed "never stop turning" solves for
lookahead; ZBLL cases drilled to sub-3; ao100 of EOCross+F2L as the
benchmark. Split heuristics (CuberPal): measure at least 12 solves, express
each phase as a fraction of your own median, focus one phase for 1-2 weeks,
do not optimise a phase in isolation.

---

## 2. Hardware and protocol facts

**Brands and protocols.** GAN (Gen2: 356 i Carry / i Carry S / i3, 12 ui,
Mini ui, Monster Go 3Ai; Gen3: 356 i Carry 2; Gen4: 12 ui Maglev, 14 ui),
MoYu (AI 2023, WRM / MHC variants; the GAN Gen2 protocol on some), QiYi
(Smart Cube, XMD Tornado V4; AES-128-ECB with a fixed key, reverse
engineered by Flying-Toast), Giiker / Xiaomi Mi, GoCube / Rubik's
Connected, HeyKube. Which one arrived decides the rest of this section.

**Libraries (MIT, usable as-is):**
- `poliva/smartcube-web-bluetooth`: one API over GAN Gen1-4, Giiker, GoCube,
  MoYu, QiYi and GAN timers. Events `MOVE`, `FACELETS`, `GYRO` (quaternion),
  `BATTERY`; capability queries per cube; `cubeTimestampLinearFit()`.
  RxJS-based; installed from GitHub, not npm.
- `afedotov/gan-web-bluetooth`: the original GAN-only library the above
  extends; on npm.
- csTimer's `bluetooth.js` covers the same cubes but is GPL: read it, do
  not vendor it.

**Timestamps.** GAN cubes' internal clocks skew visibly against the host;
the fix, invented in csTimer, is to record both clocks per move and fit a
line (`cubeTimestampLinearFit`). Cube timestamps give TPS and pause lengths
to the millisecond; host timestamps alone (GoCube, Giiker) are good to a
BLE interval (~10-30 ms), fine for splits, marginal for per-move timing.

**Gyro.** Some models report orientation as a quaternion (GAN i3 / 12 ui /
i Carry 2, MoYu AI 2023); the budget cubes mostly do not. With gyro: 3D
view follows the cube, cube rotations (x y z) become events, acubemy-style
replay with rotations. Without: rotations are invisible; for ZZ that is
mostly the AUF/`y` before the last layer, which the analysis can infer from
which face the last-layer algs were done on.

**Connection quirks.** GAN Gen2+ derives its encryption key from the cube's
MAC address, which Web Bluetooth does not expose; libraries either use
`watchAdvertisements` (a Chrome flag on some platforms) or ask the user to
type the MAC once (csTimer does). Pairing is a user gesture every session
(no auto-reconnect without a click). Missed turns at speed happen on every
brand; the state must be re-synced, see 3.1.

**Where Web Bluetooth works.** Chrome / Edge on Android, Windows, macOS,
Linux (ChromeOS too). **Not Safari, and not any browser on iOS** (all use
WebKit); iPhone users need the Bluefy or WebBLE apps. Our target is
Android Chrome, so this is fine, but it is the one platform fact that
would change the plan.

**Everything stays client-side.** Bluetooth is local; nothing here needs a
network call. The one existing exception (optional LLM coaching over an
abstract solve record) stays opt-in.

---

## 3. Feature catalogue

Size: **S** an afternoon, **M** a day or two, **L** a week-ish. Tag:
**stakes** = every smart cube app has it; **ours** = something this
codebase can do that the others cannot; **nice** = polish.

### 3.1 Connection and cube state (the foundation; everything else needs it)

- **Connect / disconnect / status** (S, stakes): a button in the scan
  sheet or settings, cube name, battery, protocol, last event age.
  Module: `web/src/smart/` wrapping smartcube-web-bluetooth behind our
  own `SmartCube` interface so the vendor library is swappable.
- **App-side cube state** (S, stakes): the cube's reported facelets on
  connect, then every move applied to `cube/state.ts`; a 3D/net picture
  that mirrors the physical cube (`cube/render.ts` already draws both).
- **Drift detection and resync** (M, **ours**): when the cube's own
  facelet report and the app's move-applied state disagree, or when the
  user says so, resync. Three ways: "it is solved" (what every app has),
  a *scan lock* from the camera (arbitrary state, unique to us), or
  "apply this fix alg" computed from the cube's reported state.
- **Gestures on the cube** (S, nice): csTimer/regrip-style triggers, e.g.
  a returned face (`R R'`) or `U U'` twice = "I am scrambled, start
  listening", so the phone is never touched during a session.
- **Session recording and replay** (S, **stakes for us**): every event
  with both clocks to a JSONL/JSON capture, like the evidence-log
  captures; tests replay captures through the same code as live events
  (regrip's "deterministic replay"). Fixtures beat mocks, as ever.

### 3.2 Timer and sessions

- **Auto start / stop** (S, stakes): the timer starts on the first turn
  after "scrambled", stops when the target predicate holds (solved, or a
  stage's target in a drill). No spacebar.
- **Inspection** (S, stakes): WCA 15 s with 8 / 12 s cues; or unlimited
  for planning drills; measured pickup time (inspection end to first
  turn), which Cubeast reports.
- **Sessions, averages, PBs** (M, stakes): ao5 / ao12 / ao50 / ao100,
  mo3, best/worst, +2 / DNF, session notes, a time-series graph. Stored
  in IndexedDB with the full move stream per solve (a few KB each).
- **Import / export** (S, stakes): csTimer's text format for times (so
  history moves either way), full JSON for our own records.
- **StackMat / GAN timer** (M, nice): smartcube-web-bluetooth already
  speaks the GAN Bluetooth timers; a StackMat needs the audio-jack
  decoder. Only if competition-style practice matters.

### 3.3 Scramble helper

- **Scramble following** (M, stakes): show the scramble, underline what
  has been applied, detect a wrong turn and show the shortest fix (csTimer
  behaviour). Our scramble box already knows the expected scramble; the
  fix is a two-phase solve from the cube's current state to the scrambled
  state (cubejs, or the existing `ll/scramble.ts` phase-2 solver for
  last-layer states).
- **Drill setups without scrambling** (S, **ours**): the last-layer
  trainer's *chain partner* (`ll/model.ts`) already picks the next case so
  that solving this one leaves the cube in the next; with the cube
  verifying, an alg session needs no setup moves at all. Cubedex users
  asked for exactly this ("auto scramble-to").
- **Random-state vs case scrambles** (S): random-state 3x3 scrambles
  (cubejs) for full solves; stage-specific scrambles exist already.

### 3.4 Stage drills driven by the cube (the existing EO / F2L / OCLL / PLL tabs)

- **Moves box fed by the cube** (S, stakes): turning fills the box; Check
  fires itself when the stage predicate holds (`stage.ts`); the timer is
  the real execution time. Typing stays as the no-cube fallback.
- **Recognition vs execution per attempt** (S, stakes): time from "cube
  ready" to first turn, then first to last turn. Both stored per case.
- **EO drill feedback** (M): compare the executed EO to the optimal set
  from `eo/solver.ts` (move count, which family/plan the user chose,
  whether the solution was one of the optimal ones); classify by the
  patterns in `docs/eo-patterns.md`.
- **EOCross drill feedback** (M): same against the EOCross worker;
  "planned in X s, executed in Y s, N moves vs optimal M" is the number the
  ZZ guides say to watch.
- **F2L pair drill** (M): the cube tells us which slot got solved and in
  what order; per-pair time, moves, case (`f2l/model.ts`), and pause before
  the pair (lookahead).
- **OCLL / PLL drill** (S): identify the case modulo AUF (`ll/model.ts`),
  time it, detect which alg variant was executed and any misturn (compare
  the move string to `ll/cases.ts` up to AUF and inverse-and-redo
  corrections).

### 3.5 Algorithm trainer (learn and maintain alg sets)

- **Alg sets** (M): OCLL + PLL (exist), then optionally COLL, ZBLL (493
  cases; the bestsiteever trainer's presets and "recap" mode are the
  model), 2-look / OLL for non-ZZ friends, custom sets. Data shape: the
  existing `ll/cases.ts` entries (case id, recognition picture, algs with
  triggers, AUF handling).
- **Per-case memory** (M, stakes): attempts, mean, best, ao5, learned
  status (not learned / learning / learned), last seen, failure rate,
  recognition vs execution. Cubedex's per-alg ao5 + PB is the minimum.
- **Ordering strategies** (S): ordered, random, slowest first, least
  recently drilled, and **spaced repetition** (SM-2-style intervals on
  recall success = solved without a misturn under a time cap; acubemy and
  CuberPal both market this).
- **Learn mode** (M, nice): the alg shown move by move, the next move
  highlighted, the picture animating as the cube turns (GAN "AI tutorial"
  style); mask mode hides the alg and shows only the picture for
  recognition practice.
- **Alg fingerprinting** (M): which of a case's several algs the user
  actually executes, and a per-move timing profile of that alg over many
  executions: where the slow transition (a regrip) sits. Ties into the
  fingertricks sheet (`ui/fingertricks.ts`): the sheet could show the
  measured time between each pair of moves.
- **Recognition trainer** (S): the cube is in the case, nothing is shown;
  time to first turn is the recognition time; optionally show the picture
  from a random angle (2-side recognition for PLL).

### 3.6 Full-solve reconstruction and ZZ analysis (the analysis engine)

All pure functions over `{ scramble, moves: [{move, t}], method }` in a
new `web/src/analysis/`, unit-tested on recorded solves.

- **Reconstruction** (S, stakes): moves with timestamps, alg-string
  export, alg.cubing.net / cubedb-style link, a replay scrubber over the 3D
  cube.
- **ZZ phase splitting** (M, **ours**): scan prefixes with `stage.ts`:
  EO done (EOLine / EOCross / EOArrow depending on setting), cross, pairs
  1-4 (with slot order), last-layer corners oriented (OCLL), PLL, AUF.
  Per phase: time, moves, TPS, recognition (pause before the first move
  of the phase) vs execution, and inspection + pickup at the front. CFOP
  and Roux splitting for other people are cheap once the predicate table
  exists (csTimer has both). Speedcuber Timer has ZZ "supported but not
  shown": nobody ships ZZ analysis properly.
- **Pauses and fluency** (S): every gap above a threshold (say 300 ms)
  located in its phase and pair; "fraction of time turning"; a pause map
  over the solve timeline (CubeStation's "fluency" number, made
  legible).
- **Rotations and AUF** (S): with gyro, real x/y/z events; without,
  inferred rotations from which faces the last-layer algs touched; AUF
  count and time.
- **Optimal comparisons** (M, **ours**): EO / EOCross optimal from the
  existing solvers for *this* scramble; F2L pair move counts vs the case
  table; last-layer alg move count vs the alg you chose. Move-count
  efficiency per phase is the number CubeStation and Cubeast show without
  the optimum next to it.
- **Case tagging** (S): which OCLL, PLL (and later COLL/ZBLL) cases
  appeared in each solve and their times -> the per-case memory of 3.5
  fills itself from real solves, not only drills (csTimer's case stats).
- **F2L pair order and lookahead** (M): slot order, pause before each
  pair, whether the first pair was the one planned (see 3.9), back-pair
  avoidance stats (the ZZ thread's explicit weakness).

### 3.7 Coaching: where to focus

- **Bottleneck card** (S): each phase as a fraction of the solve vs a
  goal pace or vs the user's own median (Sub-X "Where to Focus", CuberPal
  heuristics); one sentence naming the phase to work on this week.
- **Weak cases -> drills** (M): the per-case memory ranks cases by mean,
  variance and failure rate; one tap opens a drill session of the worst
  eight (acubemy's loop).
- **Trends** (M): per-phase medians over sessions, TPS over time, pause
  fraction over time, recognition time per case over time; PB history.
- **LLM commentary** (M, opt-in): already in the milestones' sketch: the
  abstract record (phases, numbers, cases, optimal comparisons, never
  video) to a model with a prompt; the programmatic layer does the
  arithmetic. The one deliberate network call in the app.

### 3.8 Turning and lookahead trainers

- **Metronome mode** (S): a beat at N bpm, one turn per beat; the app
  measures adherence (turn-to-beat offset) and pauses; ramp bpm across a
  session. The standard lookahead drill, now measurable.
- **Slow-turn / TPS cap mode** (S): flag any turn faster than a cap or
  any pause longer than a floor; a "never stop turning" solve gets a
  score. "If you have to pause to find a piece you are turning too fast".
- **Blind execution** (S): hide the picture after inspection; the solve
  is judged on pauses only.
- **Pauseless streak** (S, nice): longest run of turns without a pause
  above the floor, per phase.

### 3.9 Inspection and planning trainers

- **EOCross planning** (M): unlimited inspection, then execute; the app
  checks EOCross solved, moves vs optimal, inspection time vs the 8 s
  goal; optionally the user *declares* the plan first (types or taps it)
  and the executed moves are compared to the plan (planned vs executed
  is the thing a dumb cube cannot measure). crystalcube's drill, with
  the cube as the judge.
- **EOCross + 1** (M): same with the first pair; tracks whether the pair
  planned was the pair done.
- **Cross colour / axis neutrality** (S): stats and drills per EO axis and
  cross colour, if the user solves on more than one.
- **First-pair prediction** (S): after EOCross, which pair will you do
  first? Measures the pause between EOCross and pair 1 (the "EOCross ->
  F2L transition" the ZZ thread names as its second weakness).

### 3.10 Statistics and progress

- **Per-case tables** (S), **per-phase distributions** (S), **PB ladder**
  (S), **streaks and daily goals** (S, nice), **heatmaps** of cases by
  mean time (S), **cube comparison** (S, nice: TPS per cube model, like
  Cubeast).
- **Benchmarks** (S, nice): phase fractions against published
  heuristics; never against other users (no backend).

### 3.11 Camera + cube synergy (nobody else can do these)

- **Scan to resync** (M, **ours**): the camera lock is the resync source
  for a drifted cube; also the way a cube that was scrambled while
  disconnected gets its state without solving it first.
- **Ground truth for the camera reader** (M, **ours**): record solves with
  the cube connected and the camera watching; the cube's moves label the
  recording. Turns `docs/solve-tracking-design.md` 10.3 ("recordings with
  typed truth, then calibration") from a chore into a by-product. Also the
  first real test of whether the camera reader is worth keeping for
  people without a smart cube.
- **Move source abstraction** (S): `follow.ts` and the drills consume a
  `MoveSource` (cube when connected, camera reader otherwise); one code
  path downstream.
- **Hands + moves** (L, later): the camera sees the grip, the cube sees
  the turn; a combined record could locate regrips. Hand pose measured
  weak (8.1); do not start here.

### 3.12 Presentation

- **Live 3D cube** (S): `cube/render.ts` animated from the move stream;
  with gyro, oriented like the cube in your hand; the net view alongside.
- **Sound and haptics** (S, nice): a click per stage completion, a
  vibration on lock/stop; inspection cues.
- **PWA** (S, nice): manifest + offline caching (a service worker already
  exists for COI) so the Pages site installs to the home screen and works
  in a basement.
- **Desktop keyboard cube** (M, nice): csTimer's virtual cube for drilling
  without a cube in hand; low priority once a smart cube exists.

### 3.13 Social and multiplayer

- 1v1 races (acubemy, CubeStation), leaderboards, tournaments, sharing a
  solve page. All need a backend or at least a relay; **conflicts with
  "everything client-side"** except a static shareable solve link (the
  solve record encoded in the URL, rendered by our own page). Listed for
  completeness; recommend no unless asked for.

### 3.14 Data

- **Solve record**: `{ id, when, cube, scramble, method, hold, moves:
  [{ m, tCube, tHost }], fit, inspection, events: [gyro/gestures] }` plus
  derived analysis cached; IndexedDB store; JSON export/import; csTimer
  text export of times.
- **Fixtures**: `web/test/fixtures/smart/` captures with a `truth` field
  (the scramble, the expected splits), replayed by tests, exactly like
  `fixtures/evidence/`.

---

## 4. Architecture sketch (if built)

```
web/src/smart/
  types.ts      SmartCube: connect() disconnect() caps; events: move | facelets | gyro | battery | link
                MoveEvent { move, tCube, tHost, tFit }   (tFit = host time after the linear fit)
  adapter.ts    smartcube-web-bluetooth -> SmartCube (the only file that imports the vendor lib)
  clock.ts      the two-clock linear fit (port; MIT)
  sync.ts       app state = last known state + applied moves; divergence check vs FACELETS;
                resync from: solved | scan lock (handoff.ts) | fix alg
  gesture.ts    returned-face / shake triggers -> named events
  capture.ts    JSONL session capture + replay (fixtures)
  ui.ts         connect button, status chip (name, battery, link age), in the scan sheet or settings
web/src/analysis/
  phases.ts     ZZ (and CFOP/Roux) splitting over move prefixes via stage.ts
  metrics.ts    TPS, pauses, recognition/execution, AUF, rotations
  optimal.ts    EO / EOCross / pair / LL comparisons (existing solvers)
  cases.ts      case tagging (ll/model, f2l/model)
  record.ts     the solve record type + JSON (de)serialisation
web/src/store/  IndexedDB sessions + per-case memory + export/import
```

Touch points in existing code: `ui/drill.ts` gains a live moves source and
an auto-Check; `follow.ts` takes a `MoveSource`; `ui/scanner.ts` gains the
connect chip and "resync from this lock"; `shell.ts` a Sessions / Stats
sheet; `ui/fingertricks.ts` optional measured timings. `web/src/moves/`
(the camera reader) is untouched and becomes one `MoveSource`.

Dependencies: `smartcube-web-bluetooth` (MIT, GitHub install) brings RxJS
(~30 KB gz), acceptable; or port the two or three protocol files we need
if the bundle matters. cubing.js is *not* needed (we have `cube/`).

---

## 5. Milestone candidates (order depends on section 8)

- **S1 Cube in the loop (M):** connect, mirror, capture/replay, the four
  drills fed by the cube with auto-Check and real times, resync (solved /
  scan). Runnable on the phone in a day or two; everything after is data.
- **S2 Full solves (M-L):** scramble following, inspection, auto
  start/stop, ZZ phase splits + reconstruction + pause map, sessions with
  averages and PBs, JSON/csTimer export.
- **S3 Coaching (M):** per-case memory filled from solves and drills,
  bottleneck card, weak-case drills, spaced repetition, trends.
- **S4 Planning and lookahead (M):** EOCross / +1 planning drill with
  planned-vs-executed, metronome, TPS cap, pause flags.
- **S5 Camera synergy (M):** labelled recordings for the camera reader;
  hands later if ever.
- **Any time (S each):** gestures, sounds, PWA, 3D live view, gyro.

---

## 6. Risks and things not to do

- **Wrong-brand assumptions.** Do not write protocol code before the cube
  is in hand; the library's capability query decides gyro/timestamps.
- **The GAN MAC step.** If it is a GAN, expect a one-time "type the MAC"
  UI or the `watchAdvertisements` flag; budget for it in S1.
- **Timestamps.** Never compute TPS or pauses from host time when cube
  time exists; always keep both and the fit in the record, so an analysis
  bug is fixable on old captures.
- **Do not build a timer product first.** csTimer is free and complete;
  the value here is ZZ analysis, drills that judge themselves, and the
  camera resync. Sessions/averages are table stakes but not the point.
- **No backend.** Multiplayer, cloud sync and community benchmarks are
  out unless the client-side rule is revisited on purpose.
- **Keep the no-cube paths working.** Typed moves, the camera reader and
  the scanner stay usable; the cube is an input, not a requirement.
- **GPL.** Ideas from csTimer, code from the MIT libraries only.

---

## 7. Sources

- csTimer smart cube wiki: https://github.com/cs0x7f/cstimer/wiki/Use-csTimer-to-connect-to-smart-cubes---%E4%BD%BF%E7%94%A8csTimer%E8%BF%9E%E6%8E%A5%E6%99%BA%E8%83%BD%E9%AD%94%E6%96%B9
- Cubeast: https://www.cubeast.com/ and the speedsolving thread https://www.speedsolving.com/threads/cubeast-a-speedcubing-timer-for-bluetooth-cubes-with-support-for-all-bluetooth-cubes-all-timers-and-all-major-solving-methods.77406/
- acubemy: https://acubemy.com/ and https://www.speedsolving.com/threads/acubemy-one-smart-cube-app-to-rule-them-all.96004/
- Cubedex: https://cubedex.app/ , https://github.com/poliva/cubedex , https://www.speedsolving.com/threads/%F0%9F%9A%80-just-launched-cubedex-a-new-app-to-drill-your-algs-like-a-pro.93373/
- Sub-X: https://www.speedsolving.com/threads/smart-cube-solves-now-get-auto-reconstructed-and-analyzed-phase-splits-bottleneck-detection-on-sub-x.97079/
- GAN CubeStation: https://play.google.com/store/apps/details?id=com.gan.cubestation
- Speedcuber Timer: https://www.speedsolving.com/threads/speedcuber-timer-a-free-fully-offline-smartcube-app-for-android-and-ios.91601/
- smartcube-web-bluetooth (MIT): https://github.com/poliva/smartcube-web-bluetooth
- gan-web-bluetooth (MIT): https://github.com/afedotov/gan-web-bluetooth
- QiYi protocol: https://github.com/Flying-Toast/qiyi_smartcube_protocol (moved to codeberg)
- regrip: https://github.com/wstein/regrip
- smartcubeanalyzer: https://github.com/cuberplus/smartcubeanalyzer
- Web Bluetooth status: https://github.com/WebBluetoothCG/web-bluetooth/blob/main/implementation-status.md , https://caniuse.com/web-bluetooth
- ZZ practice: https://www.speedsolving.com/threads/getting-fast-with-zz.93285/ , https://www.zzmethod.com/improvement-guide/eocross/eocross-full-guide , https://bestsiteever.net/zbll/ , https://crystalcuber.com/
- Split heuristics: https://www.cuberpal.com/blog/cfop-solve-splits
- Camera-only competitor: https://www.speedsolving.com/threads/a-timer-which-tracks-your-moves-using-only-the-camera-no-bluetooth-cube-required.97625/
- Which cube threads: https://www.speedsolving.com/threads/what-smart-cube-should-i-get.95393/ , https://www.speedsolving.com/threads/smart-cube-trainers.84944/

---

## 8. Open questions (decide before designing)

1. **Which cube** is on order (brand and model)? It fixes protocol, gyro,
   timestamp quality and the MAC step.
2. **Which device** will it pair with: the Android phone, a desktop Chrome,
   both? (An iPhone changes everything: no Web Bluetooth.)
3. **The main goal** for the next few weeks: (a) full-solve analysis and
   coaching, (b) the existing stage drills judged by the cube, (c) learning
   alg sets (which?), (d) a daily timer with history. Rank them.
4. **ZZ variant.** EOLine or EOCross (or both)? Last layer: OCLL + PLL as
   the tabs are now, COLL + EPLL, ZBLL, ZZ-CT? Is learning a bigger LL set
   part of the plan (that decides whether spaced repetition is core)?
5. **Timer history.** Replace csTimer (sessions, averages, PBs live here) or
   keep csTimer and only export times to it?
6. **The camera reader.** Keep it as the no-cube path and calibrate it
   from cube-labelled recordings, or shelve it now?
7. **Lookahead tools** (metronome, TPS cap, pause flags, blind execution):
   wanted, or is analysis enough?
8. **Planning drills** (EOCross / +1 with planned-vs-executed): wanted?
9. **Social** (races, sharing links, benchmarks): the recommendation is
   no; confirm.
10. **LLM commentary** over the solve record: still wanted as an opt-in?
11. **Gyro / 3D live view / sounds / PWA install**: any of these matter to
    you, or are they polish for later?
