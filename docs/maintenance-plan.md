# Maintenance plan (2026-09-22)

A repo-wide maintenance audit: dead and duplicated code, the test suite,
dependencies, the build and deploy, the Python half, the docs. Section 1 is
what was done in the audit's own commit (`b381970`); the rest is the work
list, ranked, written to be picked up cold. Every item names the files and
the tests that guard it, and says S / M / L (an hour / half a day / a day).

Conventions for whoever picks this up: read `CLAUDE.md` first (colours, not
face letters; one cube model under `src/cube/`; fixtures beat mocks; commit
and push with `tools/wsl/push.sh`; other sessions may share the checkout, so
stage by path and check `HEAD` before committing). `npm test`, `npm run
typecheck` and `npm run lint` must stay green after every item; the four
headless checks (`web/scripts/check-*.mjs`, section 4.6) are the only net
under `src/app/` and `src/ui/`, so run them after anything that touches
those.

Baseline before the audit: 374 commits, 51 test files / 1000 tests green in
19.6 s, typecheck and lint clean, deploy green. `web/src` is ~21.7k lines in
~120 files; `web/test` ~7k lines.

## Status 2026-09-22 (the second pass, commits `941ada1`..`c7cbc67`)

Done, each its own commit, `npm test` / typecheck / lint and the headless
checks green after each: **2.1** (deploy 115 -> 35 MB), **2.2** (cubejs's
npm stubbed by `overrides`: lockfile 751 -> 294, audit 44 -> 2), **2.3**
(smartcube ref pinned, `@types/web-bluetooth` declared, ORT 1.30, eslint
patches; the majors are still open), **2.5** (the Algs sheet lazy; only
38 kB moved, the rest of `main` is the trainers), **3.3** (`state.ts`
split; one piece table in `cube/pieces.ts`), **3.4** (`persisted()`),
**3.5** (`timer/track-ui.ts`), **3.6** (`ll/pic.ts` on `picTop`), **3.7**
(`ui/dom.ts`, one `median`, one `downloadBlob`, one `SOLVED`), **3.8**
(`cube/alg.ts randomMoves`), **3.9** (`workers/rpc.ts`), **3.11** (all but
`label.html`, which waits for the labeler decision in 3.1; the
`console.log` traces stay - `check-smart.mjs` and `replay_clips.py` parse
them, so each says so), **4.1**, **4.2**, **4.3** (a leak found: a stage 2
without the crop stamp did not dispose the localizer loaded for it),
**4.5**, **4.6** (`scripts/headless.mjs`, `check-rig` folded into
`check-record --rig`, `npm run check:*`, puppeteer a `web` devDependency,
`check:smart` and ruff in CI; `check-record`'s two assertions were stale
since the one-recorder change of 2026-09-19), **5** and **6** (all but
`MILESTONES.md`'s header, the user's call). Suite: 61 files / 1064 tests
in ~11 s.

**vite 8 is deferred, and why (2026-09-22).** The build works and is four
times faster (rolldown), but the built page throws
`Cannot read properties of undefined (reading 'Cube')`: cubejs's 2019 UMD
wrapper ends `}).call(this)` and falls back to `this.Cube = Cube` when it
does not see a `module`, and `this` is undefined in the strict ESM
rolldown emits. `check-smart.mjs` catches it; the unit suite does not (it
loads cubejs through node). So vite is on **7.3.6**, which is green on all
four headless checks. The fix is 2.2's option 2 - vendor cubejs's two
files into `web/src/vendor/` as real ESM - and then vite 8 should go
through; do them together.

Open, each waiting on a decision (section 7's items 12-15): **3.1 + 3.2**
(the naming layer off the tick - needs the labeler decision), **3.10 +
4.4** (after 3.1), **2.4** (the model file: LFS or a release asset),
**2.3's majors** (vite 8, vitest 5 - which also clears the last two audit
findings -, typescript 7), and `MILESTONES.md`'s header (6).

---

## 1. Done in this pass (commit `b381970`)

- **Unused `export`s stripped** (~90 symbols, 46 files) with knip; the config
  is `web/knip.json` and registers the scripts, the workers and the two extra
  Vite pages (`label.html`, `signin.html`) as entry points so knip cannot
  mistake them for dead. `npx knip` is now a usable dead-code check: it
  reports clean except one duplicate export (`LAB_NORM`/`DEFAULT_EMBEDDING`
  in `colour/colorspace.ts`, intentional).
- **Eleven dead symbols deleted** (tsc's `noUnusedLocals` found them once
  unexported): the FTO player mount wrapper, `pinnedStage`, two evidence-log
  helpers, `faceOfNormal`, the last-layer table warm-up, `patternCost`, an
  F2L stage check, the fingertricks close, two stray re-exports.
- **28 fixtures no test read removed** (6.5 MB) and `web/test/fixtures/README.md`
  rewritten: it still described the tap-to-fix workflow and two test files
  deleted with the grid scanner.
- **`npm run bench`** (`vitest --mode bench`; `test/helpers.ts` exports
  `BENCH`): the per-embedding bake-off in `colour-replay.test.ts`, the
  forced-alignment diagnostic in `moves-replay.test.ts`, the seam-refinement
  benchmark (`refine-bench.test.ts`, which asserts nothing) and four
  wall-clock throughput assertions run only there. One of those (the move
  worker's ms-per-frame budget) flaked once under the parallel suite during
  the audit. `npm test` went from 19.6 s to 10 s.
- **CI test job**: `.github/workflows/ci.yml` runs lint, typecheck and the
  suite on every push and pull request. Until now the only workflow built
  and deployed; the 1000 tests guarded nothing on push.
- **`.gitignore` symlink bug fixed for good**: every data dir is a symlink
  onto `/mnt/cube-data` in the WSL checkout and a `dir/` rule never matches a
  symlink (commit `89c501e` hit this on `test/bank` and fixed only that one).
  All such rules lost their trailing slash; `web/clips` had no rule at all.
  `git status` is clean of data dirs now.
- Small: ruff's two auto-fixes in `model/train`, two test titles that named a
  face by letter, `CLAUDE.md`'s layout block lists the ~15 files it had
  missed.

Note for the sandbox: `git status` at the repo root lists `.bashrc`,
`.gitconfig`, `.mcp.json` and a few other dotfiles as untracked. They are
character devices the sandbox masks in, not files; ignore them, never add
them.

---

## 2. Build, deploy and dependencies

### 2.1 The deploy ships 115 MB; the phone needs about 30 MB (S, do first)

`web/scripts/copy-ort.mjs` copies every `.wasm` in `onnxruntime-web/dist`
into `public/ort/` (81 MB), and Vite bundles the `jsep` wasm a second time as
an asset because `detect/ort.worker.ts` and `detect/session.ts` import the
package (27.8 MB in `dist/assets/`). `dist/` measured:

| file | size | needed? |
|---|---|---|
| `ort/ort-wasm-simd-threaded.jsep.wasm` | 27.8 MB | yes (the runtime the app loads, `session.ts:30` sets `wasmPaths`) |
| `assets/ort-wasm-simd-threaded.jsep-*.wasm` | 27.8 MB | duplicate of the above |
| `ort/ort-wasm-simd-threaded.asyncify.wasm` | 25.7 MB | no |
| `ort/ort-wasm-simd-threaded.jspi.wasm` | 16.0 MB | no |
| `ort/ort-wasm-simd-threaded.wasm` | 14.0 MB | probably not (verify: the non-jsep build is used only without the webgpu EP in some ORT versions) |
| `ort/ort.min.mjs` | 0.4 MB | yes: `label.html` imports it directly |

Work: (a) restrict the copy to the `jsep` pair, the plain `.mjs` and
`ort.min.mjs`; (b) stop Vite from bundling the wasm, e.g.
`build.rollupOptions.external` for `/ort-wasm.*\.wasm$/` or the
`?url`-free import pattern ORT documents for Vite, and confirm with the
network panel (or `scripts/check-detect.mjs` with logging) that the worker
still fetches exactly one wasm from `ort/`. Guard: `check-detect.mjs`
(needs `npm run build`, puppeteer from `model/gen/node_modules`, and the
deployed models). Every push to `main` uploads this artifact, so it also
shortens the deploy.

### 2.2 `cubejs` depends on `npm@6` (M, decide)

`cubejs@1.3.2` (last published 2019-04) declares `"npm": "^6.0.0"` as a
runtime dependency. Consequences: 751 lockfile entries for a 2-file library,
and all 44 `npm audit` findings (3 critical) are inside that nested npm. It
is never loaded at runtime, so there is no exposure, but every `npm ci` and
every audit pays for it. Options, in order of preference:

1. `overrides` in `web/package.json`: `"cubejs": { "npm": "npm:empty-npm-package@1.0.0" }`
   (or any tiny stub). Zero code change; verify `npm ls` and the suite.
2. Vendor cubejs's `lib/cube.js` + `lib/solve.js` into `web/src/vendor/`
   (`src/cubejs.d.ts` already provides the types) and drop the dependency.
3. Replace with `cubing.js`: no, it is large and the project only needs
   Kociemba + a facelet model.

### 2.3 Dependency versions (S each; decide the majors)

`npm outdated` on 2026-09-22:

| package | current | latest | note |
|---|---|---|---|
| onnxruntime-web | 1.29.0 | 1.30.0 | minor; re-run `check-detect.mjs` and the `model/export` sanity check, and re-verify 2.1's file list (ORT renames wasm files between minors) |
| vite | 6.4.3 | 8.3.0 | two majors; `@vitejs/plugin-basic-ssl` 2.1 -> 2.3 alongside; the custom plugins in `vite.config.ts` use only `configureServer` / `generateBundle` and should port |
| vitest | 3.2.7 | 5.0.1 | two majors; `--mode` and `import.meta.env.MODE` (used by `BENCH`) are stable |
| typescript | 5.9.3 | 7.0.2 | 7 is the Go-port compiler; treat as its own chore, `--noEmit` with `strict` should be fine |
| @types/node | 22 | 26 | keep on 22: CI and the dev machine run Node 22 |
| eslint / typescript-eslint | 10.10 / 8.70.0 | 10.11 / 8.70.1 | patch, take |
| firebase | 12.19.0 | 12.19.0 | current |

Also: `smartcube-web-bluetooth` is `github:poliva/smartcube-web-bluetooth`
with no ref in `package.json`; the lockfile pins commit `44f1f091`. Write the
ref into `package.json` (`#44f1f091c6e980d9cc31e6d2863c4437eca3ab3c`) so a
lockfile regeneration cannot move it. And `@types/web-bluetooth` is in
`tsconfig.json`'s `types` but not in `devDependencies` (it arrives
transitively); declare it.

`model/gen/package.json`: puppeteer ^23.11, three ^0.169, pngjs ^7; lockfile
committed. The `web/scripts/check-*.mjs` scripts import puppeteer from
`../model/gen/node_modules`, which is why they cannot run in CI (4.6).

### 2.4 The model file in git history (M, decide)

`git count-objects`: the pack is 232 MB and ~223 MB of it is fifteen
committed versions of `web/public/models/facekp.onnx` (eight at 24 MB, seven
at 4.5 MB). Committing the model is deliberate (Pages serves it), but every
re-export adds its full size forever. Options: Git LFS for
`web/public/models/*.onnx`, or `deploy.yml` fetches the model from a GitHub
release asset and the file leaves git. Do not rewrite history for the
fixtures; they are a rounding error next to this.

### 2.5 Large chunks (S, optional)

`vite build` warns on `main` (593 kB), `firebase` (672 kB, already lazy via
`store/firebase.ts`) and `models` (457 kB, the ORT JS). The `main` chunk
could lazy-load the algs sheet and the FTO/n×n 3D players
(`algs/*`), which a phone opening the Solve tab never needs.

---

## 3. Dead and duplicated code in `web/src`

Ranked by value. The "not duplicated" list at the end is as important as the
findings: those were checked and should not be re-investigated.

### 3.1 The M6 naming layer runs on every detection tick for a hint (L)

`detect/facekp.ts:246` calls `nameQuads(...)` (`detect/identify.ts`, 537
lines) every tick when the deployed head is anonymous (always, today). It
samples nine Lab cells per quad and runs the exemplar / co-visibility namer.
The M7 colour solver (`colour/*`) does not use its output; the scanner reads
only `result.quads` for the tracker. What survives of the namer's output:

- the user hint for a refused quad (`ui/scanner.ts:1106` -> `ui/hint.ts`:
  "face too small", "centre obscured", glare, too dark);
- the debug overlay's refusal boxes and exemplar swatches;
- **the labeler's suggestion button**: `src/label-main.ts:37` maps
  `result.faces` to named corners for `label.html`. This is the one real
  consumer of the *identity* half, and it is a dev tool, not the app.
- `debug/selftest.ts` reports the count of named faces.

Recommendation: keep the *quality refusals* and stop running the *identity*
half per tick. Concretely: a `detect/quality.ts` with the four cheap tests
(`minFaceEdgePx`, `isFaceTooDark`, `isFaceBlownOut`, the centre-ring check,
all already in `color.ts`) that `facekp.ts` calls for the hint; `nameQuads`
becomes an on-demand call the labeler makes (`label-main.ts`) and the scan
loop never invokes. Then decide whether the labeler could use the colour
solver's naming instead (it needs colours for a single still, which
`colour/solve.ts` handles as six single-frame tracks, see
`colour-replay.test.ts`'s `logFromFaces`); if yes, `identify.ts`,
`CenterExemplars`, `state.ts:15-76` (the namer's colour space), `types.ts`'s
`CellSample`, `debug/dump.ts:74-135` and `debug/detect-overlay.ts:106-115`
all go. Tests: `identify.test.ts`, `exemplar-guard.test.ts`,
`naming-space.test.ts` test only the layer being removed; `hint.test.ts`
and `lowlight.test.ts` must keep passing against the quality module; run
`check-detect.mjs`. The capture-debug JSON shape changes (`named`,
`exemplars` fields) so check the evidence fixtures do not read them.

Payoff: ~600 lines, and per-tick CPU on the phone.

### 3.2 `color.ts` is two modules (M, with 3.1)

624 lines, 37 exports. Keep: the Lab maths (`srgbToLab`, `labDistance`,
`labMedian`...), the sampling geometry (`facePlan`, `minFaceEdgePx`), the
M7 patch statistics (`samplePatchStats`, `sampleGridStats`, `blurScore`,
`quadViewCos`), and the Hungarian `solveAssignment` (live: `colour/decode.ts`
and `colour/naming.ts` use it; it is not dead and there is no k-means in
this file, k-means lives in `colour/palette.ts`). The `CellSample` path
(`samplePatch`, `sampleCellRobust`, `sampleGridCells`, `labMean`,
`gridCellCenters`, the dark/blown-out thresholds) serves only
`detect/identify.ts`. After 3.1, split into `colour/lab.ts` and
`colour/patch.ts` and delete `color.ts`. Tests to re-point: `color.test.ts`,
`patchstats.test.ts`, `assignment.test.ts`, `rectify-real.test.ts`,
`naming-space.test.ts`, `test/synth.ts`.

### 3.3 `state.ts` holds four unrelated things; one duplicates `cube/pieces.ts` (M)

- `state.ts:15-76`: the namer's colour space -> `colour/colorspace.ts` (or
  gone with 3.1).
- `state.ts:78-88`: `ROT3` / `rotateCells`, a 3×3 *grid-cell* rotation used
  by `colour/evidence.ts`, `colour/faces.ts`, `colour/solve.ts`,
  `moves/anchor.ts`. Not a cube rotation; move next to its users.
- `state.ts:106-160`: `CORNER_FACELETS` / `EDGE_FACELETS` / `EDGE_COLORS`,
  transcribed from cubejs; `cube/pieces.ts:10-13` has the same twelve edge
  pairs in a different order (`UF UR UB UL...` vs cubejs's `UR UF UL UB...`)
  and the same corner positions. One piece-table home: `state.ts`'s are the
  cubejs-order originals, so `cube/pieces.ts` should derive its order from
  them, with a test that the two orderings describe the same twelve pairs.
- `state.ts:191-362`: `validateState` and the cubejs solve worker client stay.

Guards: `state.test.ts`, `decode.test.ts`, `neighbours.test.ts`,
`scramble.test.ts`, `orient.test.ts`, `eo-patterns.test.ts`, `f2l.test.ts`.

### 3.4 Settings persistence is hand-rolled nine times (S, best ratio)

The same `Object.assign(settings, JSON.parse(localStorage.getItem(KEY) ||
'{}'))` in a try/catch plus a `saveSettings`: `eo/trainer.ts:32`,
`timer/trainer.ts:111`, `ll/trainer.ts:203` (with field validation),
`f2l/trainer.ts:300` (URL-or-storage), and ad-hoc `try { localStorage }`
blocks in `shell.ts:75,189`, `algs/sheet.ts:140,170`, `cube/scheme.ts:14,25`,
`timer/graph.ts:240,256`, `app/cubefollow.ts:257,264`, `store/sync.ts:50`.
`ui/settings.ts` exists but persists DOM controls, not objects. Add
`persisted<T>(key, defaults, fix?)` there and route the nine through it,
keeping every key string verbatim (users' settings survive). Untested
today; the headless `check-smart.mjs` exercises the EO tab's settings.

### 3.5 Smart-cube scramble following copied three times (M)

`timer/trainer.ts:167-184,515-525`, `ll/trainer.ts:288-302,440-450`,
`app/cubefollow.ts:110-130`: rebuild a `ScrambleTracker` when
scramble/colours/hold change, `status(facelets)`, render the tokens with the
done prefix marked. `ll/trainer.ts:43` imports `moveHtml` from
`timer/trainer.ts` (a trainer importing a sibling trainer). Extract
`makeTrackWatcher` + `renderScrambleTokens` + `moveHtml` into
`timer/track-ui.ts`. `timer.test.ts` / `drive.test.ts` cover the tracker;
`check-smart.mjs` covers the rendering.

### 3.6 Two last-layer picture renderers (S to write, M to eyeball)

`ll/pic.ts:27 picSvg` (top face + four strips from a hand-written index
table) duplicates `algs/pic.ts:30 picTop(n, state, rows)`, whose header says
it is that picture generalised. `picSvg` becomes `picTop(3, f, 1)` plus the
LL-only `arrowsSvg`; delete `SIDES`. Layout constants differ slightly, so
check the OCLL/PLL drill and the case sheet by eye. `cube/render.ts` is
confirmed the only 3D/net renderer, as CLAUDE.md demands.

### 3.7 Small utilities (S)

| helper | copies |
|---|---|
| `esc()` HTML escape | 7: `ui/fingertricks.ts:249`, `algs/sheet.ts:60`, `timer/graph.ts:157`, `eo/eocross.ts:78`, `ll/reference.ts:84,128`, `eo/patterns.ts:91` |
| `median()` | 2, byte-identical: `color.ts:432`, `colour/colorspace.ts:24` (`colour/robust.ts`'s weighted one is different) |
| prefixed `$()` DOM lookup that throws | 5: `ui/drill.ts:241`, `ui/scanner.ts:266`, `ui/cubeview.ts:132`, `timer/trainer.ts:137`, `f2l/trainer.ts:194` |
| inject a `<style>` once by id | 11: `ui/drill.ts:202`, `ui/cubeview.ts:107`, `ui/fingertricks.ts:240`, `timer/graph.ts:236`, `timer/trainer.ts:107`, `algs/sheet.ts:137`, `algs/player.ts:71`, `ll/pic.ts:22`, `ll/reference.ts:116`, `ll/trainer.ts:196`, `f2l/trainer.ts:189` |
| `downloadBlob` | 2 with swapped argument order: `ui/download.ts:4 (name, blob)` vs `debug/dump.ts:39 (blob, name)`; the housekeeping plan meant to leave one |
| `SOLVED` facelet string | `moves/moves.ts:81` and `cube/state.ts:11`, plus copies in four tests and `scripts/check-smart.mjs` |

One `ui/dom.ts` (`esc`, `scoped`, `ensureStyle`); `median` into
`colour/robust.ts`; `debug/dump.ts` imports `downloadBlob` from
`ui/download.ts` (tsc catches the argument flip: `Blob` vs `string`).

### 3.8 Two random-scramble generators (S)

`scramble.ts:19` (string, no same face twice, no three on one axis; the scan
sheet and `f2l/model.ts genFull`) and `eo/solver.ts:173` (`Move[]`, 20-24
turns, no `F B F`; the EO trainer). One generator in `cube/alg.ts` with the
stricter rule; deterministic-rng tests (`scramble.test.ts`,
`handoff.test.ts`, `follow.test.ts`, `readersource.test.ts`,
`eo-patterns.test.ts`) will need new expected strings. Not duplicates:
`ll/scramble.ts` (a Kociemba two-phase *solver* producing short setups),
`timer/trainer.ts:148` (random *state*, WCA-correct for a timer),
`f2l/model.ts:168 genF2L` (a constrained walk plus a cross fix).

### 3.9 Worker clients (S)

Five workers; `state.ts:305-323`, `detect/session.ts:36-67` and
`eo/eocross.ts:14-46` are the same 15-line pending-map + id + onerror
pattern. A `workers/rpc.ts` (`ask<T>(msg)`, `post(msg, transfer)`) serves
those three and `colour/client.ts`'s request path. Leave
`colour/sampler.ts` alone: its in-flight counter with drop-not-queue
back-pressure is the point. `public/eocross-worker.js` gets its move model
injected at init from `cube/pieces.ts`; no second cube model there.
Guards: `moves-worker.test.ts`, `solver-worker-errors.test.ts`.

### 3.10 `ui/scanner.ts` at 1527 lines (L, three independent commits)

No unit test covers it. Sections that can leave with no behaviour change:
`drawSamplePatches` (574-611) and `drawOverlay` (692-722) to
`debug/detect-overlay.ts` (already imported, owns `drawQuad`/`drawStage1`);
the MediaRecorder capture (1274-1440) to `ui/recorder.ts` (it overlaps
`rig/session.ts`); the debug exports (1444-1495) to `debug/dump.ts`; the
solution / evidence / fill UI (612-796) to `ui/scanner-evidence.ts`; the
pure part of the live scramble check (`checkExpected`, 814-825) next to
`handoff.ts`'s `diffFacelets`. The 300-line `loop()` stays. Target ~850
lines. After each commit run all four `check-*.mjs`. This is also the
precondition for testing the scanner's verdict / lock gating as pure
functions (4.4).

### 3.11 Smaller items (S each)

- `PuzzleId` is declared twice with incompatible members: `store/types.ts:12`
  (`'pyram' | 'minx'`, WCA/csTimer codes) and `algs/types.ts:7`
  (`'pyra' | 'fto'`). Rename the algs one `AlgPuzzleId` before anyone wires
  a 4×4 solve from the algs sheet and `'pyra'` fails a `'pyram'` check.
- The two drills' session-stats line (`eo/trainer.ts:283`, `ll/trainer.ts:282`)
  is the same three means with a different third term; fold into
  `ui/drill.ts` and the F2L and Solve tabs get it for free.
- `f2l/model.ts:52` and `:186` carry `TODO(shared)` notes (tokens into
  `cube/alg.ts`; applying an alg to a facelet string into `cube/state.ts`).
  These are the only TODOs in `web/src`.
- `console.log` in production paths: `app/cubefollow.ts:138,155,194`,
  `app/scanner-bridge.ts:73,107,111`, `ui/scanner.ts:1368,1488`. The follow
  ones read like a debug trace; route through the debug panel or drop.
- `label.html` carries a ~1300-line inline `<script>` (lines 354-1665).
  CLAUDE.md's no-inline-scripts rule names `index.html` only, so it is not a
  violation, but it is a fourth place cube-picture code could hide and it
  is unlinted and untyped. Moving it to `src/label/*.ts` is a half-day job
  with no test; only worth it when the labeler is next touched.
- `scripts/make-icons.mjs` is referenced by nothing (a run-once PWA icon
  generator). Add an `npm run icons` script or delete it.
- Non-null assertions (`!`): 669 in `web/src`. Not a bug class to chase, but
  a number worth knowing when reviewing hot paths.

### 3.12 Looks duplicated but is not (do not re-investigate)

- `moves/moves.ts` vs `cube/state.ts` vs `cube/nxn.ts`: three facelet move
  models, each verified against cubejs by test; `moves/moves.ts` is a
  precomputed permutation table because the reader applies thousands of
  hypotheses a second. Keep all three.
- `opposite` in `cube/frame.ts:25` (letter -> letter via normals) vs
  `moves/moves.ts:84` (`(f+3)%6` index arithmetic). Different domains.
- `FACE_ORDER` (`types.ts`), `FACE_IDS` (`cube/frame.ts`), `FACES`
  (`cube/state.ts`, `cube/nxn.ts`): four names for `U R F D L B`, split
  along the scanner-half / trainer-half line CLAUDE.md keeps independent.
- `app/cubefollow.ts` / `follow.ts` / `timer/track.ts` / `moves/drive.ts`:
  four different jobs (page wiring, the pure lock-to-scramble function,
  which prefix is on the cube, arm-then-attempt). Only 3.5's boilerplate
  overlaps.
- `ll/scramble.ts`'s two-phase search vs `state.ts`'s cubejs solve: short
  non-alg-looking setups under a node budget vs any solution fast.
- `model/train.py` vs `train_bbox.py`, `dataset.py` vs `bbox_data.py`,
  `export_onnx.py` vs `export_bbox.py`, `augment.py` vs `gpu_augment.py`:
  parallel by design for the two stages and for CPU vs GPU augmentation
  (`check_gpu_augment.py` proves the latter equivalent). Not a target.
- `tools/eocross/*.ts` import the app's cube code; no second edge model.

---

## 4. Tests

The suite is strong: almost every test is a differential check against an
oracle (cubejs, cubing.js via `fto-oracle.json`, the Python decoder) or a
replay of a real capture; no `it.only`, no `.skip` beyond two deliberate
`skipIf`s on gitignored data, no `Math.random` in an assertion path, no
snapshots. What is left:

### 4.1 Zero cover on `src/app/` and most of `src/ui/` (M)

`src/app/` (9 files, 969 lines) is not even loaded by a test. Two of them
are stateful reducers over a `MoveSource` stream, not DOM, and decide which
tab the cube drags the user into mid-solve:

- `app/sources.ts`: a pinned stage keeps receiving items while another is
  open and an unpinned one resets when reopened (`:23-27`); switching the
  active source unsubscribes the old one exactly once (`:21`); turns handed
  to a stage are relabelled into that stage's frame (feed one stream with
  white-down/green-front and white-down/blue-front and assert the letters).
- `app/cubefollow.ts`: an alg that dips back through the orange-cross stage
  and out again does not bounce the tabs (the "furthest stage" rule,
  `:13-15`); a pause with the cube off the scramble path loads its state
  like a lock; "stay here" keeps the tabs still while the timer still gets
  turns.

`app/record.ts`, `rig.ts`, `scanner-bridge.ts`, `smart.ts` are covered only
by the headless checks (4.6).

### 4.2 `framering.ts` (S, cheapest win)

76 lines of pure ring-buffer arithmetic under the whole latency-delayed view
(CLAUDE.md pipeline step 3), never loaded by a test. Three tests with a stub
canvas: `at(index)` returns the frozen frame while it is in the ring and
`null` once overwritten; the synced view returns the frame nearest
`now - latency` and the newest at latency 0; indices stay monotonic across
more than one lap.

### 4.3 Other pure logic without tests (S each)

- `detect/models.ts:23-30`: the serialized load chain and the three
  "no learned path" outcomes (missing stage 1 / missing stage 2 / stage 2
  without the crop stamp) with a stubbed loader.
- `colour/sampler.ts`: the back-pressure rule (`maxInFlight`, drop rather
  than queue, `dropped` counter) with a fake `Worker`.
- `shell.ts`: the `stages` registry and `keepScramble` (a stage cannot load a
  scramble while it is held), which `cubefollow.ts` depends on.
- `eo/eocross.ts`: the request queue behind `ensure()`.

### 4.4 `ui/scanner.ts` (L, after 3.10)

Not a test task until the verdict row, the lock gating and the overlay
geometry are pure functions in a sibling module; then they get fixture tests
for free like `colour/`.

### 4.5 Hygiene (S)

- Duplicated helpers to move into `test/helpers.ts`: `makeImage`/`setPixel`
  (`color.test.ts`, `patchstats.test.ts`), `loadPng` (`colour-bank.test.ts`,
  `refine-bench.test.ts`), `polySig`/`sceneSig` (`fto3d.test.ts`,
  `nxn3d.test.ts`), the `SOLVED` string (four tests; it is exported from
  `src/cube/state.ts`), `scramble(alg)` (`colour-replay.test.ts`,
  `drive.test.ts`), the shared `TRUTH` scramble (`colour-synthetic`,
  `complete`, `neighbours`).
- Three different fixture-path idioms (`new URL('./fixtures/', import.meta.url)`,
  `join(dirname(fileURLToPath(...)))`, `join(__dirname, ...)`) across eight
  files: one `fixture()` / `fixtureJson()` / `fixturePng()`.
- Four tests that assert nothing or a tautology: `colour-replay.test.ts`
  "lists the captures" and "prints the bake-off table",
  `moves-replay.test.ts` "lists the fixtures", `fto3d.test.ts` "has 72
  triangles" (subsumed by the next test). Delete or give them an assertion.
- `@vitest/coverage-v8` is not installed; a one-off coverage run would
  sharpen 4.1-4.3.

### 4.6 The headless checks (M)

`web/scripts/check-detect.mjs`, `check-record.mjs`, `check-rig.mjs`,
`check-smart.mjs` are the only automated cover for the smart-cube path, the
drill scaffold, the Cube sheet, the recording rig and the detector in the
browser. None is in `package.json` scripts or CI; all import puppeteer from
`../model/gen/node_modules`, so they fail on a clean clone. `check-rig.mjs`
is ~80% a copy of `check-record.mjs` (same server bring-up, same cert
fallback, same meta assertions; only the port and the button differ).
Work: merge the two behind a flag; add `npm run check:*` entries; resolve
puppeteer from a `web` devDependency; then a CI job that builds and runs
`check-smart.mjs` (no model, camera or Bluetooth needed) is realistic.
`check-detect.mjs` needs the models and WebGPU never yields an adapter in the
WSL sandbox (`docs/wsl-sandbox.md`), so it stays manual.

---

## 5. The Python half and the tools

- Nothing under `model/train`, `model/export`, `tools/solve` is orphaned:
  every script has a caller in the README, a design doc or another script
  (a basename grep undercounts because `import grid_check` has no suffix).
- `ruff check model` has one finding left (`E701` in `watch.py`, the
  embedded dashboard HTML). `tools/` is outside `model/ruff.toml`'s scope
  and its one-liner scripts would raise ~255 `E501/E701/E702`; either give
  `tools/` the same per-file ignores `bbox_eval/*` already has or leave it.
  No script or CI runs ruff; a `ruff check` step in `ci.yml` is cheap once
  `tools/` is configured.
- `model/.venv` in the WSL checkout is a uv-built Linux venv with torch
  2.14 / torchvision 0.29 / numpy 2.5 / onnx 1.23 / onnxruntime 1.30 and no
  pip. It is not the training environment (that is the Windows venv with
  the pinned older torch CLAUDE.md's "deferred upgrade" note is about). Say
  so in `model/requirements.txt` or `docs/wsl-sandbox.md` so nobody reads
  its torch version as the deployed stack. No lockfile or `pip freeze`
  exists anywhere; `requirements.txt` is unpinned by design.
- Planning docs in `model/`: `PLAN-anonymous-conv-head.md` still says
  "approved, not started" but the work is done and measured in
  `model/README.md` ("Center vs legacy head, measured"); fix the header.
  `BBOX-HANDOFF.md` and `PORTRAIT-BRIEF.md` are superseded by
  `PORTRAIT-DESIGN.md` (which is current and cited); move both to
  `docs/archive/`. `cloud/RUNBOOK.md` is live.

---

## 6. Docs

- `MILESTONES.md`'s header still says "Current milestone: M9" (2026-09-16)
  while the last ~60 commits are the last-layer trainer's voice and repeat
  mode, the Algs sheet (2x2 to FTO, the 3D player) and the Solve tab's
  graph, none of which the milestone list names; M11's `web/src/analysis/`
  does not exist. This is the user's call: either a milestone for the
  trainer work that happened, or a status line saying M10 is where things
  stand and the trainer work is off-milestone.
- Root `README.md` still says "one page, four stage tabs" and never mentions
  the Solve tab, the Algs sheet, the smart cube or the sign-in / Firestore
  sync.
- `docs/smart-cube-trainer-survey.md` says the cube is on order; it arrived
  2026-09-21 and `docs/smart-cube-design.md` holds the decisions. A
  "superseded by" line at the top.
- `docs/housekeeping-plan.md` reports items 1-5 done; a closing status line
  would say M11's phase splitting is the only open item.
- `docs/hand-pose-experiment.md` is "measured and shelved": archive.
- `web/src/color-notes.md` (2026-09-11) is still cited by comments in
  `color.ts`, `detect/identify.ts`, `detect/facekp.ts` and
  `docs/rubiks-vision-analysis.md`; it goes when 3.1 does.

---

## 7. Suggested order

| # | item | effort | why first |
|---|---|---|---|
| 1 | 2.1 deploy size (copy-ort + wasm double-bundle) | S | every push uploads 115 MB; the phone downloads more than it needs |
| 2 | 2.2 cubejs's `npm` dependency (`overrides`) | S | 44 audit findings and 700 packages go away |
| 3 | 2.3 pins: smartcube ref, `@types/web-bluetooth`, ORT 1.30, eslint patch | S | reproducibility |
| 4 | 3.7 + 3.11 small utilities, `PuzzleId` rename, console.log | S | mechanical, tsc-guarded |
| 5 | 3.4 `persisted()` settings helper | S | nine copies, one bug surface |
| 6 | 4.2 + 4.3 framering / models / sampler / shell tests | S | pure logic, no DOM |
| 7 | 4.1 tests for `app/sources.ts` and `app/cubefollow.ts` | M | the most user-visible untested logic |
| 8 | 4.6 headless checks: merge, `npm run check:*`, puppeteer from `web` | M | makes the UI net runnable anywhere |
| 9 | 3.8 + 3.9 scramble generator, worker RPC | S | |
| 10 | 3.5 + 3.6 track UI, `ll/pic.ts` on `picTop` | M | needs a look on the phone |
| 11 | 3.3 `state.ts` split, one piece table | M | |
| 12 | 3.1 + 3.2 the naming layer off the tick, `color.ts` split | L | biggest removal; needs the labeler decision |
| 13 | 3.10 `ui/scanner.ts` extraction, then 4.4 | L | after 12 |
| 14 | 2.4 the model file in git (LFS or release asset) | M | a decision, then one-off |
| 15 | 2.3 majors: vite 8, vitest 5, typescript 7 | M | each its own commit, CI green between |
| 16 | 5 + 6 docs and Python housekeeping | S | any time |

Items 1-6 fit in a day and each ships on its own. Items 12-13 are the
structural ones and should wait for the labeler decision in 3.1.
