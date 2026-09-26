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

## Status 2026-09-23: the gates are in CI, and a `/maintain` skill

`npm run maintain` (= `check:dead` knip, `check:dup` jscpd over 1% of
lines, `check:audit` high advisories in the shipped deps, `build`,
`check:size` a ceiling on `dist/assets/main-*.js`) runs in the CI `web`
job after the suite. Ten exports that had crept back since the 22nd are
un-exported; knip's `duplicates` rule is off for the intentional
`LAB_NORM` / `DEFAULT_EMBEDDING` alias. `.claude/skills/maintain/SKILL.md` is the recurring pass: gates, drift
report, one plan item, stop.

Measured this pass: 62 files / 1086 tests in 10.5 s, `moves-replay.test.ts`
the critical path at 11 s alone; `main` chunk 583 kB (ceiling 620);
pack 232 MB (2.4 still open); 13 exact clones, three inside
`ll/practicegraph.ts`; 13 `console.*` outside `debug/`. `npm audit` shows
4 high in puppeteer 23's `extract-zip` (dev only; `check:audit` omits
dev). **Puppeteer 25 clears it but could not be verified here**: the
sandbox blocks the Chrome download, so the bump was reverted. Next pass
on a machine with the browser: `npm i -D puppeteer@25`, then all four
headless checks.

**3.10, first of three commits (2026-09-23):** the overlay drawing left
`ui/scanner.ts` for `debug/detect-overlay.ts` (`drawTracks`,
`drawSamplePatches`; the face-of-track and colour-of-face lookups are
passed in as functions). 1508 -> 1446 lines. The MediaRecorder capture and
the debug exports are the next two. Guards run: `check:smart`,
`check:record`.

## Status 2026-09-25, later: puppeteer 25, and 2.4 was already done

**puppeteer 23 -> 25.12.0** in `web` (the four `extract-zip` advisories
go with it; `npm audit` clean without `--omit=dev`). The Chrome shell
download that blocked this on the 23rd works from the sandbox when the
command allows `storage.googleapis.com` and `googlechromelabs.github.io`;
all five headless checks pass on the new shell (154). `model/gen` keeps
its own puppeteer 23 for the generator, a separate bump when that is next
touched.

**2.4 is done, and was before the audit's pass counted it open:** the
model files are Git LFS pointers in `HEAD` (`.gitattributes` rule at the
root, `git lfs ls-files` lists both `.onnx`), and `deploy.yml` checks out
with LFS so Pages serves the real file. What the drift number measures
(pack 232 MB) is the fifteen pre-LFS versions still in history; it will
not move without a history rewrite (`git lfs migrate import
--everything`), which is the user's call and forces every clone to
re-fetch. Left as is.

**typescript 7:** typescript-eslint 8.70.1 declares `typescript <6.1.0`
and its tracking issue (#10940) is open with three blockers named by the
maintainers (ESLint has no async parsers; tsgo not yet stable; the Go/JS
AST bridge is undesigned). Nothing to do here but wait; TS 6.0.3 is fine.

## Status 2026-09-25: vitest 5.0.2

Gates green before and after on a `main` that gained three commits
overnight (the follow and the scramble voice: `app/cubefollow.ts`,
`ll/trainer.ts`, `timer/trainer.ts`, `shell.ts`, `ui/voice.ts`). Drift:
63 files / 1103 tests in ~11.5 s; `main` 572 kB; 12 clones; `console.*`
outside `debug/` 13 (was 12: one more `CUBE FOLLOW` trace in
`app/cubefollow.ts`, which `check-smart.mjs` parses, so it stays like the
others); one TODO; pack 232 MB; `ll/trainer.ts` 1208 -> 1157 lines,
`ui/scanner.ts` 1350; `moves-replay` 9.3 s. **2.3's minor:** vitest
5.0.1 -> 5.0.2, the suite and `npm run bench` green on it; audit clean.
Section 7 still has nothing a pass can pick alone (2.4, puppeteer 25,
typescript 7, `label.html`, `MILESTONES.md`'s header).

## Status 2026-09-24, fourth pass: the two patches

Gates green before and after; drift unchanged (63 files / 1102 tests in
~11 s, `main` 571 kB, 12 clones, 12 `console.*`, one TODO, pack 232 MB,
`moves-replay` 10.7 s, every fixture read). **2.3's minors:** vite 8.3.0
-> 8.3.1 and `@types/web-bluetooth` 0.0.20 -> 0.0.21 (the smart cube
library still pins its own 0.0.20 copy underneath; harmless). All five
headless checks pass on the bumped dev server. Section 7 now has no item
left that does not wait on a decision: 2.4 (the model file), the majors
(puppeteer 25 needs a machine with the Chrome download; typescript 7
needs typescript-eslint), `label.html`'s script, and `MILESTONES.md`'s
header. The scan sheet at 1350 lines and the LL trainer at 1208 are the
two files over the 1000-line mark; neither is on the list, so further
extraction is a new item for the user to rank.

## Status 2026-09-24, third pass: 4.4, the scan sheet's verdicts as pure functions

Gates green before and after. Drift: unchanged but for `vite` 8.3.0 ->
8.3.1 (a patch, not taken this pass) and the suite now 63 files / 1102
tests in ~11 s; `main` 571 kB, 12 clones, 12 `console.*`, one TODO,
pack 232 MB, `moves-replay` 9.3 s.

**4.4:** `ui/verdict.ts` holds, with no DOM, what the sheet says about
the reading: `coloursOf` / `coloursOfStrict` (the colour of each letter
from the naming), `scrambleCheck` + `scrambleCheckLine` (the live check
against the host's scramble: text and state class), `verdictLine` (the
debug panel's verdict row), `lightVerdict` / `lightLine` (too dark, too
bright, whites clip) with the three light thresholds. `test/verdict.test.ts`
(16 tests) pins them, including the check being by colour (the same
cube read upside down, through cubejs's `x2`) and the "close" band.
1391 -> 1350 lines. Different from the plan: the lock gating itself is
not in the sheet - it is the decoder's certificates (`colour/decode.ts`,
already tested), and the sheet only reads `sol.lockable`; the overlay
geometry left in 3.10's first commit. `check:smart` failed once on its
tab-following assertion (the PLL tab's state) and passed on the rerun
with no change between: a timing flake in the headless check, noted for
whoever sees it next. `check:record`, `check:rig` pass.

## Status 2026-09-24, later: 3.10's third commit, the capture's shape

Gates green before and after; nothing moved in the drift numbers since
the pass earlier today (570 -> 571 kB `main`, 12 clones, 12 `console.*`,
one TODO, pack 232 MB, `moves-replay` 9.5 s).

**3.10, third of three:** the capture's shape is `ScanCapture` in
`debug/dump.ts` (typed, with the field docs that were comments in the
button handler, and `CAPTURE_VERSION`), the solution's JSON form is
`plainSolution` / `PlainSolution`, and the three places a capture can go
(the rig session, `?post=`, a download) are `captureSink`. 1407 -> 1391
lines. Less than the plan's "debug exports (1444-1495)" suggested: every
field of the capture reads the sheet's own state (EMAs, selects, the
log), so the assembly stays where the state is; what moved is the format
and the routing. `ui/scanner.ts` ends 3.10 at 1391 lines, not the ~850
the plan targeted: the solution / evidence / fill UI and the live
scramble check (the plan's other two sections) are still inside, and the
300-line loop. 4.4 (the verdict row and the lock gating as pure
functions) is the next thing that would shrink it, and is a test task,
so it comes with its tests. Guards run: `check:smart`, `check:record`,
`check:rig`; the rig's `evidence.json` still carries every field.

## Status 2026-09-24: 3.10's second commit, the recorder

Gates green before and after (lint, typecheck, 62 files / 1086 tests in
10.4 s; knip, jscpd, audit, build, size). Drift against the 23rd: `main`
chunk 583 -> 570 kB; 12 clones, 0.53% of lines (was 13); `console.*`
outside `debug/` 12 (was 13); pack still 232 MB (2.4 open); one TODO in
`web/src` (the drift command's count of 91 was `model/gen/node_modules`,
exclude it); no merged branches; every fixture is read (the evidence and
solve fixtures by directory glob, so `grep` for the basename finds
nothing - not a leak). Slowest: `moves-replay.test.ts` 10.2 s, then
`colour-replay` 5.9 s, `f2l` 5.8 s. `npm outdated`: puppeteer 23 -> 25
(the Chrome download the sandbox blocks, still unverified), typescript 7
(waits on typescript-eslint), `@types/node` 26 (stays on 22).

**3.10, second of three:** the MediaRecorder capture left `ui/scanner.ts`
for `ui/recorder.ts` (`SolveRecorder`: the recorder, its chunks, the
elapsed ticker, the download-or-rig hand-off, the recording's stamp; the
sheet keeps the buttons, the moves input and the capture, and hears
`onActive` / `onState` / `onStopped`). 1446 -> 1407 lines. Different
from the plan: `rig/session.ts` does not overlap after all - the session
is the sink the recorder streams into, so the recorder takes a session
from `onRecordStart` and the capture takes it back (`takeSession`) to
close it. Guards run: `check:smart`, `check:record`, `check:rig`. Next:
the debug exports (the capture button's JSON assembly) to `debug/dump.ts`.

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

## Status 2026-09-22, the third pass (`cc88592`..`a237831`)

**3.1 is done in the shape the app needed, not the shape the plan guessed.**
The quality half is `detect/quality.ts` and the tick calls it; naming is
opt-in (`detect(source, roi, { name: true })`) and only the labeler asks.
`DetectResult.unnamed` is `refused`. The namer's two debug views and the
capture JSON's `named` / `exemplars` fields went with it.

But **`identify.ts` stays, and the deletion the plan costed at ~600 lines
did not happen**, because its premise does not hold: `colour/solve.ts`
cannot name the 1-3 faces of a single still. It needs six faces to fit a
palette and the exact decoder needs all 54 stickers - a photo of two faces
has neither. The labeler's Suggest button wants a face letter per quad from
one shot, which is exactly what the centre-exemplar namer does and the
colour solver structurally cannot. So `identify.ts` is now what its header
should say it is: the labeler's namer, off the app's path. If the ~600
lines are still wanted, the real options are (a) Suggest fills corners only
and the human picks the slot, or (b) a much smaller centre-namer against
the default-scheme prior with no exemplar learning - both are labeler-UX
calls, not cleanups.

Also honest about the payoff: the per-tick saving is the identity
arithmetic only. The warp and the nine-cell sample stay, because the
quality tests need them.

**3.2** landed as `colour/lab.ts` + `colour/patch.ts` + `colour/assign.ts`;
`color.ts` is gone. The mean-only sampler (`samplePatch`, `sampleGridCells`)
did NOT become dead - `detect/quality.ts` reads it on the tick - so it sits
in `patch.ts` beside the robust statistics rather than being deleted.

Still open: **3.10 + 4.4** (`ui/scanner.ts` extraction, then its tests),
**2.4** (the model file in git), **vite 8** and **typescript 7** below.

---

**typescript 7 is deferred too (2026-09-22).** `tsc --noEmit` is clean and
takes 0.35 s instead of 2.4 (the Go port), but `npm run lint` dies:
"typescript-eslint does not support TS 7.0" (their issue #10940 tracks
>= 7.1; the side-by-side TS 6 API dance is not worth it for one repo).
TypeScript is on **6.0.3**, the last JS-based major, which lints and
typechecks clean. Re-try 7 when typescript-eslint ships support.

**2.2 and vite 8, done together (2026-09-22).** cubejs is vendored as ESM in
`web/src/vendor/cubejs` (option 2, with its own README): two files of
dependency-free arithmetic whose 2019 UMD preamble - `}).call(this)` falling
back to `this.Cube` - was the one thing still costing us, because rolldown's
strict ESM makes `this` undefined and killed the page. With that gone **vite
is on 8.3.0**: the build is 475 ms instead of 2.4 s, the deploy is still
35 MB with one ORT wasm, and all four headless checks pass.

The npm package stays a **devDependency on purpose**: thirteen test files use
it as an independent oracle for our own cube code, and pointing them at the
vendored copy would have our code checked against itself.
`test/vendor-cubejs.test.ts` runs the two side by side and requires identical
answers, so the copy cannot drift.

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

## 7. Suggested order (complete as of 2026-09-25)

Every row is done or waits on a decision: 1-11, 13 (3.10 + 4.4), 14
(LFS, done before the audit counted it) and 15 (vite 8, vitest 5,
puppeteer 25; typescript 7 waits on typescript-eslint) are done; 12 landed
as `detect/quality.ts` with `identify.ts` kept for the labeler; 16 is done
but for `MILESTONES.md`'s header. Section 8 is the next list.

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


---

## 8. The second audit (2026-09-25): proposed work list

Five sweeps (code health, tests and checks, build / deploy / security,
the Python half, docs and process) over the repo at `86bc1c5`, each claim
checked by reading the code; the bugs in 8.1 were re-verified by hand
before this was written. Same conventions as the first audit: colours not
letters, one cube model, fixtures beat mocks, stage by path, the gates
and the headless checks green after every item. S / M / L as before.

The shape of what came back: the first audit's list is finished, and what
remains is (a) a handful of real bugs the audit tripped over, (b) tooling
that lies (a 60 s wait in every headless run, 16 s of tests that assert
nothing, a Makefile that would overwrite the deployed model), (c) the
structural seams the plan's ~850-line target for the scan sheet implied
but never listed, and (d) docs that describe the app of two weeks ago.

### 8.1 Bugs (S each; fix first, each its own commit)

1. **Open redirect on the sign-in page.** `web/src/signin.ts:16-18` accepts
   `?return=` when it starts with `/` and not `//`. `/\evil.example` passes
   and the URL parser reads `\` as `/` on https, so `location.replace` after
   a successful Google sign-in goes off-site. Fix: `new URL(r,
   location.origin).origin === location.origin`, and a test in
   `test/` for the four shapes (`/x`, `//x`, `/\x`, `https://x`).
2. **Imported text into `innerHTML` unescaped in the Solve tab.**
   `timer/trainer.ts:557` (session names, in `<option>`) and `:573` (the
   scramble, in a `title=` and as text). Both come from csTimer imports and
   from Firestore. Use `esc()` from `ui/dom.ts` like everywhere else.
3. **The sample worker can wedge the scanner silently.** `colour/sampler.ts:26-31`
   decrements `inFlight` only in `onmessage`; the worker has no `onerror`
   and `sample.worker.ts:44-81` has no try/catch, while `samplePatchStats`
   throws (`patch.ts:337`). Two failed frames leave `busy` true for good
   and the evidence log stops growing with no message. Fix: always reply
   (an empty `quads` is fine), `onerror` like `colour/client.ts:36`, and a
   test with a throwing sampler.
4. **The Solve tab's scramble race.** `timer/trainer.ts:584` `load` calls
   `setScramble(..., false)` without bumping `generation`, so the
   `newScramble()` started at mount (`:150-155`) can resolve later and
   overwrite the scramble the follow loaded. This is also the
   `check:smart` flake of the 24th: `check-smart.mjs:104-119` reads every
   tab's scramble before `#tm-scr` stops saying "generating". Fix:
   `++generation` in `load`, a `waitForFunction` in the check, and a unit
   test with a slow fake generator.
5. **Four eval tools cannot load a twist checkpoint.** `diagnose.py:238`,
   `dump_failures.py:96`, `viz_nms.py:190`, `dump_decode_fixture.py:114`
   call `build_model` without `twist=ckpt.get("twist")` (`twostage.py:61`
   and `export_onnx.py:204` do). Loading `runs/tw1/best.pt` fails with a
   head-shape mismatch, and `docs/twist-head-plan.md:170`'s step is that
   call. 8.5's shared loader fixes all four at once.
6. **`predict.py` writes drawn real photos to a folder git does not
   ignore.** Its default `--out preds` is `model/train/preds/`;
   `.gitignore` covers `model/train/failures/` for exactly this reason.
   Add `model/train/preds` (and check nothing is staged from it).
7. **`tools/eocross` is broken.** `tools/eocross/lib.ts:11` imports
   `randomScramble` from `web/src/eo/solver`, gone since 3.8 (`6d3a6b0`);
   all five scripts go through it. `npx vite-node` (README:41, the script
   headers) is no longer installed, since vitest 5 stopped shipping it, so
   `npx` fetches an unpinned copy. `check.ts:14` imports puppeteer from
   `model/gen/node_modules`. None of `tools/**/*.ts` or
   `web/scripts/cube-fixture.ts` is in `web/tsconfig.json`'s `include`.
   Fix: import from `cube/alg`, add `tsx` or `vite-node` as a devDependency
   with an `npm run eocross:*` script, include `tools/**/*.ts` and
   `scripts/*.ts` in a `tsconfig.tools.json` that `typecheck` also runs.
8. **Wake lock race.** `app/wake.ts:12-18` has no in-flight guard: turning
   the setting off while `request()` is pending keeps the lock; a
   visibilitychange and an init call together can create two sentinels.
9. **A user-visible string sends people to a scanner that no longer
   exists.** `detect/models.ts:40,45` say "use the grid scanner" (removed
   2026-09-14). Same claim in comments at `facekp.ts:27,152`,
   `cubebox.ts:7`. Reword.

### 8.2 Build, deploy, CI, security

10. **Deploy is not gated on CI (S).** `deploy.yml` runs on every push to
    `main`, in parallel with `ci.yml`, and only builds. A red suite still
    deploys. Trigger on `workflow_run` of CI with `conclusion == success`,
    or one workflow with `needs:`. While there: `permissions:` and
    `concurrency:` blocks and `timeout-minutes` in both, `cancel-in-progress:
    false` on the Pages deploy, the `deploy.yml:28` comment names
    `web/.gitattributes` (the rule is at the root), pin `ruff` in the
    python job, cache `~/.cache/puppeteer` and `node_modules` in `ci.yml`
    as `deploy.yml` already does, and add `check:ll` + `check:practice`
    to the headless job (they need only `serveDist`). `check:record`
    can follow once 8.3's dev-server fix lands.
11. **Every page load downloads and benchmarks the detector, even on the
    Solve tab (M).** `app/scanner-bridge.ts:179` mounts the scanner at
    init; `ui/scanner.ts:247,483` then registers the COI service worker (a
    forced reload on first visit) and loads the 28 MB wasm, both models
    and the ORT worker, and on a WebGPU first visit runs 15 inferences per
    execution provider (`facekp.ts:203-208`). `models-*.js` (414 kB) is
    modulepreloaded for the same reason. Import the scanner dynamically on
    first scan-sheet open (or on `requestIdleCallback` after first paint),
    the way `algs/sheet.ts` is. Guard: `check:smart` (the Solve tab must
    not fetch `ort/`), `check:record` (the sheet still comes up docked).
12. **Model and ORT URLs have no cache-busting (S).** `facekp.ts:157-160`,
    `cubebox.ts:52-55`, `session.ts:31,48` are fixed paths and Pages caches
    them ~10 min: after an ORT bump new JS can pair with an old wasm, after
    a model push the version chip can show the new run over the old
    weights. Append `?v=${__BUILD__.hash}` (the build already stamps
    `version.json`).
13. **`copy-ort.mjs` copies a dead 368 kB `ort.min.mjs` (S).** Its comment
    says `label.html` imports it; `label.html` goes through the bundle
    now. Drop it; re-verify with the network panel that the worker fetches
    exactly the `.jsep.mjs` + `.jsep.wasm` pair.
14. **Node is unpinned (S).** No `.nvmrc`, `engines` or `packageManager`;
    vite 8 needs 22.12+. Add `engines.node: ">=22.12"` and `.nvmrc`.
15. **`smartcube-web-bluetooth` is a git+ssh dependency that builds from
    source on every `npm ci` (M, decide).** Its `prepare` runs its own
    rollup + typescript. Vendoring its `dist` the way `cubejs` is vendored
    removes the git fetch and the third-party build; `smart/adapter.ts` is
    the only importer. Also a lazy-load candidate (below).
16. **`main` chunk, the next lazy loads (M).** The smartcube library (208
    kB ESM + rxjs + aes-js + lz-string) is static through `app/smart.ts:11`
    and could load on Connect; `f2l/data.ts` (97 kB source) with the F2L
    tab; the scanner + colour + moves code with item 11. Then ratchet
    `check-size.mjs`'s ceiling down (572 kB measured against 620), and use
    `fileURLToPath` there instead of `new URL().pathname`.
17. **Firestore rules and auth under COEP (S).** `firestore.rules:8-10`
    lets any signed-in account write any collection under its own uid, any
    size up to 1 MiB: restrict to the five collections in
    `store/sync.ts:48` plus a size check; confirm in the console that the
    web key is referrer-restricted (and consider App Check).
    `sync.ts:91`'s `getRedirectResult` on the cross-origin-isolated page
    looks vestigial now that sign-in lives on `signin.html` and its
    `.catch` would hide a COEP block: check in devtools, then delete.
18. **No offline shell (M, the user's call).** `coi-serviceworker.js` is
    pass-through; the installed PWA shows the dinosaur offline. A
    cache-first app shell would make the timer and the drills work
    offline; the models can stay network-only. Also `manifest.json` lacks
    `id`.
19. **Dev-server sinks (no action, noted).** `/__capture` and
    `/__recording` are `configureServer` only and sanitise names, but
    `server.host: true` puts unauthenticated disk writes on the LAN and
    `debug/dump.ts:68` posts to an absolute `/__capture` ignoring
    `BASE_URL`. Fine for a dev rig on a home network; say so in
    `docs/wsl-sandbox.md`.

### 8.3 Tests and the headless checks

20. **`moves-replay.test.ts` spends ~10 s asserting nothing (S).** All three
    `fixtures/solves/*.json` are `hard`, so the only live assertion is
    `frames > 0` (`:147`); `free` (`:83`) is never asserted. Gate the
    per-fixture replay behind `BENCH` and keep one pinned decode on the
    smallest file (`solve-1789369770950`, 294 quads). `npm test` should
    drop to ~7 s.
21. **`colour-replay` runs 30 of its 36 MB with no assertion (S).** Ten of
    fourteen `evidence/*.json` have neither `truth` nor `scrambleTruth`
    and only print (`:141-150`); `scan-debug-1789348275571` locked on the
    phone and nothing pins that it still does; the CASES solves run at
    collection time in the describe body (`:80-90`); "prints the bake-off
    table" is still a tautology after 4.5. Pin the captured `solution` of
    each no-truth file as a no-regression check, move the rest to bench.
22. **`headless.mjs` wastes 60 s on every run (S).** Node's `fetch` rejects
    vite's self-signed certificate, so the readiness loop (`:57-60`) always
    runs all 60 × 1 s before the curl fallback. Start vite in-process
    (`createServer({ server: { port: 0 } })`), which also removes the
    hard-coded `--strictPort` 5198/5199 and the Windows `taskkill`. Every
    check gets a minute faster.
23. **The checks' own hygiene (M).** `check-record` leaks the session
    folder when a wait throws (cleanup is after `finally`) and its rig wait
    regex can match static label text (`:38`); `check-smart` has ≥50 s of
    fixed waits (`:125,:150`, a real-time 16 s replay gap `:135-140`) and a
    0.4-0.7 s window asserted after a 420 ms sleep (`:234-240`), a `||
    true` (`:175`), no `try/finally` (browser left running on a throw),
    and parses `console.log` traces (`:138,:190,:205`) - expose
    `ZZ.follow.history()` from `app/cubefollow.ts:136` instead;
    `check-ll` has no `pageerror` listener. Shared: `SOLVED` / `inverse` /
    `capture()` in smart and ll, the `check`/`failed`/summary pattern in
    all five, `sleep` twice, the quarter-turn split four times in
    check-smart. One `scripts/check-lib.mjs`; `headless.mjs`'s header lists
    three checks of five.
24. **Coverage gaps that are logic, not DOM (M).** `ll/trainer.ts`:
    `spokenLabel :195`, `offRoute :466`, `inHand :478`, `foldSlices` +
    `SLICE_OF_PAIR :494-507`, `repDone :627`, `absorbAuf :666` (the
    AUF-tolerant wrong-turn watcher, `docs/ll-drill-next-steps.md`);
    `timer/trainer.ts` `armed`/`feed`/`finish` (`:248-300`) and
    `rollSession :386`; `f2l/trainer.ts` `saveUrl`/`loadUrl` (`:279-334`,
    incl. old `w=1` links); `ui/cubeview.ts` `rotationToHold`/`beliefCells`
    (`:83-104`); `app/scanner-bridge.ts` `matchText`/`useInTrainer`;
    `colour/client.ts` `sync`/`trimmed` (`:46-61`, with a fake Worker as
    `sampler.test` does). Each pairs with the seam in 8.4 that extracts it.
25. **The rest of the suite's slack (S each).** `f2l.test.ts:133-151,178-190`
    re-parse `state()` thousands of times and `explain()` at `:185` asserts
    nothing; `ll.test.ts:149-176` runs `scrambleFor` 216 times; cubejs
    `initSolver` is paid by three files. Sample in `npm test`, exhaustive
    behind `BENCH`. Weak: `follow.test.ts:195` `toBeTruthy`,
    `exemplar-guard.test.ts:128-135` ("says which two" checks only
    `ranked`), `state.test.ts:110` / `tracker.test.ts:219-220`
    `toBeDefined` beside a `!`. Unseeded: `state.test.ts:14-18,46`,
    `moves.test.ts:10,17`, `f2l.test.ts:88`, `ll.test.ts:188`.
    `timer.test.ts:305-340` fake timers with no `afterEach`. Diagnostic
    prints in `moves-synthetic:115,134,145,162`, `decode:79`. Duplicated
    helpers: `fakeSource`/`fakeStage`/`onCube` (cubefollow, sources,
    shell), `frameWith`/`quadFor` (identify, quality), three LCGs
    (`ll.test.ts:16`'s loses precision above 2^53), `TRUTH` inline six
    times beside `helpers.TRUTH`; the `cubefollow.test.ts:134-137` mock
    drops `shareScramble`'s `from !== activeTab()` guard. Names by letter:
    `identify.test.ts:73,103`.
26. **Config (S).** Move the test config out of `vite.config.ts` (every
    run loads the dev plugins and shells out to `git rev-parse`); a
    `testTimeout` instead of five per-file overrides; install
    `@vitest/coverage-v8` and a `coverage` script (one run would sharpen
    item 24). `fixtures/README.md`: the naming-space reader is
    `exemplar-guard.test.ts:149-150`; `clip-*` "refuse honestly" is not
    asserted; `clip-*.json` live in `evidence/`; the `solves/` and `smart/`
    recipes (`scripts/cube-fixture.ts`, `tools/solve/moves_fixture.py`,
    `scripts/cut-solves.mjs`) and `test/bank` are missing.

### 8.4 Code health in `web/src`

27. **Decide `noUncheckedIndexedAccess` (M to decide, L to enable).** The
    code is written as if it were on: ~843 of ~1,125 `!` are on indexed
    reads and do nothing today (clusters: `colour/decode.ts` 83,
    `moves/anchor.ts` 73, `colour/neighbours.ts` 66, `ll/scramble.ts` 60).
    On, `tsc` reports 353 errors, mostly in files that skipped the habit
    (`anchor` 34, `f2l/model` 34, `detect/orient` 29, `facekp` 29,
    `eo/solver` 23; ~60 in tests). Either turn it on file by file or stop
    writing the `!`. Free today, 0 errors each: `noImplicitOverride`,
    `verbatimModuleSyntax`, `noFallthroughCasesInSwitch`,
    `noImplicitReturns`; `noUnusedParameters` costs one
    (`colour/palette.ts:88`). eslint is `recommended`, not type-checked,
    so there is no `no-floating-promises` (see 30).
28. **The `as unknown as` casts have cheap fixes (S).** 23 casts, no
    `any` but `solver.worker.ts:23`, no ts-ignore, no eslint-disable.
    Seven are `scoped()` returning SVG (`ui/dom.ts:12` constrains `T
    extends HTMLElement`; make it `Element`); three are warp-then-sample
    (`quality.ts:68`, `identify.ts:481`, `sample.worker.ts:67`; let the
    samplers take `ImageDataLike`); four are worker `self` (one `declare
    const self: DedicatedWorkerGlobalScope` in `workers/rpc.ts`); two are
    seg-button `data-v` writes (item 31).
29. **`detect/identify.ts` re-implements `detect/quality.ts` (S).**
    `identify.ts:464-502` repeats `quality.ts:55-80` step for step with its
    own constants, already drifted (`'center obscured'` vs `'centre
    obscured'`). `nameQuads` should call `quadQuality`. While there, its
    header (`:1-19`) and `facekp.ts:10-16,142` still describe it as the
    app's live colour layer; `observeCenter` (`facekp.ts:288`) has no
    callers.
30. **Store writes fired with `void` and nothing catching them (S).**
    `timer/trainer.ts:418` `putSolve`, `main.ts:41` `putAttempt`,
    `ll/favs.ts:66`, `ll/notes.ts:51`, the IIFE at `ll/trainer.ts:787-794`.
    A failed IndexedDB write loses a solve silently. One
    `persistOrToast(promise, what)` in `store/`; `eo/trainer.ts:88`'s
    `.catch(() => undefined)` leaves "EOCross …" on screen for good if the
    worker fails; `f2l/trainer.ts:334` `console.error` in a production
    path.
31. **Semantic duplicates jscpd cannot see (S each, one commit each).**
    Two colour tables (`types.ts:59` `DEFAULT_SCHEME_HEX` vs
    `cube/scheme.ts:7-8`; `types.ts:49` vs `cube/frame.ts:67
    WCA_COLOUR`; a reverse lookup built at `ui/scanner.ts:765`). The
    segmented-button wiring four times (`eo/trainer.ts:299-313`,
    `timer/trainer.ts:440-445,482-492`, `app/cubefollow.ts:261-266`) - a
    `bindSeg(el, get, set)` in `ui/dom.ts`. The "R2 L2 is one M2" rule
    three ways (`ll/model.ts:268`, `timer/track.ts:46-49`,
    `ll/trainer.ts:494-506`) - one helper in `cube/alg.ts`. Two types both
    named `Move` (`cube/alg.ts:6` `{face, times}`, `moves/moves.ts:9` a
    string union) with different parsers and inverses - rename one
    (`FaceTurn`). `f2l/trainer.ts:188 clean()` beside `f2l/model.ts:51
    normalizeAlg` (the `TODO(shared)`), `algs/sheet.ts:102` counting tokens
    beside `moveCount`. `timer/trainer.ts:188` repeats `track-ui`'s
    done-prefix markup. "Days ago" by 24 h windows (`ll/trainer.ts:746`)
    vs calendar days (`timer/when.ts:22-30`), so the two tabs can disagree
    about today. Raw `localStorage` + JSON in `smart/adapter.ts:36-45` and
    `detect/facekp.ts:179-220` beside `readStoredJson`/`writeStored`.
32. **Two SVG line-graph engines (M).** `timer/graph.ts` and
    `ll/practicegraph.ts` each own MARGIN, layout, STYLE, shown-key
    persistence, `HEIGHT = 280`, `GAP = 13`; practicegraph already imports
    `secondsLabel`/`secondsStep` from graph. One `ui/linegraph.ts` for
    axes, day marks, legend.
33. **The seams the ~850-line target implied (M-L, one commit per
    seam, tests with each).** `ll/trainer.ts` (1157): the speech quiz and
    hands-free standby (`184-208`, `353-455`) → `ll/quiz.ts`; the
    wrong-turn / echo logic (`455-560`, nearly pure, item 24); repeat mode
    (`616-707`); the practice table (`724-800`) → `ll/practice-ui.ts`; case
    chips and alg lines (`802-1000`); the 78-line STYLE. `ui/scanner.ts`
    (1350): the exposure controller (`1043-1128`, ~8 state variables) →
    `ui/exposure.ts` with the decision as a pure function in the style of
    `verdict.ts`; the debug readouts (`557-706`); the 73-line TEMPLATE;
    `loop()` stays. `moves/anchor.ts` (715): the pure fitting and cost
    functions (`462-715`) → `moves/anchor-fit.ts`.
34. **Imports that cross between features (S-M).** No cycles (a Tarjan
    pass over 133 files / 521 edges). But `cube/scheme.ts:1` and
    `store/sync.ts:10` import `ui/settings` (move `readStored` /
    `writeStored` / `persisted` to a neutral `src/storage.ts`);
    `ll/trainer.ts:37-38` is the only feature importing `app/` (pass
    `hold` and the source through `mountLL` options as `mountTimer`
    does); `timer/track-ui.ts` is shared by `ll/`, `ui/voice.ts` and
    `app/` and belongs in `ui/`; `ll/practicegraph.ts` imports
    `timer/graph` (item 32).
35. **Cruft (S).** Comments naming files that no longer exist
    (`ui/scanner.ts:11,20`, `ui/hint.ts:31`, `detect/session.ts:33`,
    `camera.ts:136`, `detect/tracker.ts:14`); `src/color-notes.md`
    (M1-era, cited from `assign.ts:11`, `identify.ts:12`; move to
    `docs/archive/`); the legacy (B,6,9) head branch (`facekp.ts:335-354`,
    unreachable since `models.ts` refuses un-stamped models - confirm with
    8.5 item 45); `REFINE = true` (`ui/scanner.ts:126`) always on; the
    `?follow=1` param nothing sets; dead CSS (`.sc-swatches .sc-sw .sc-seed
    .sc-exemplars` in `scanner.css`, `.eo-legend` in `index.html`,
    `.cv-nobt`); unused `window.ZZ` members (`shell.ts:207-209`
    `openScan`…`openAlgs`, `handoff`, `store.{solves,sessions,favs,notes,
    putFav,dirty}`) kept for the console; the voice→say/ask migration
    (`ll/trainer.ts:219-233`) once your browsers have loaded it; CLAUDE.md
    says the solver runs "every ~700 ms", the code is adaptive with a 300
    ms floor (`ui/scanner.ts:137`).

### 8.5 The Python half and `tools/`

36. **A shared loader and geometry module (M).** Checkpoint-to-model is
    written eight times (`twostage.py:58`, `export_onnx.py:191`,
    `diagnose.py:231`, `dump_failures.py:88`, `dump_decode_fixture.py:108`,
    `viz_nms.py:187`, `bbox_eval/score_frames.py:17`,
    `roboflow_audit.py:25`), six with `global INPUT_WH`, four without the
    twist flag (8.1 item 5). `batch_index` three times, drifted
    (`diagnose.py:135`, `export_colour_bank.py:36`, `bbox_eval/common.py:74`).
    Shoelace area ×3, `edges()` ×2, DLT homography ×2, the cube-corner
    table ×2 (both copied from `gen/scene.mjs`), letterbox ×3, sigmoid ×2,
    label glob + `json.loads` ×6, `--ckpt` in nine argparsers.
    `model/train/ckpt.py` (`load_kp`, `load_box`, `add_ckpt_args`) and
    `geom.py`; drop the redundant `sys.path` inserts (`bench_*.py`,
    `score_frames`, `roboflow_audit`).
37. **The Makefile would overwrite the deployed model (S).** `make data`
    renders 20k landscape images into `../data` (does not exist; PORTRAIT
    decision 5 rules out landscape); `make train` → `runs/base`; `make
    export` exports it and `export_onnx.py` deploys by default. CLAUDE.md
    "Commands" lists all three. Retarget to the README's real recipe
    (data_v5/v6, `train_bbox`, `export_bbox`, `check_targets`,
    `check_twist`, `watch`, ruff), add `help`, drop `*-v4`, `deps` runs
    `npm ci`; point CLAUDE.md at it. `gen/package.json`'s `data`/`preview`
    have the same dead target.
38. **Orphans and their requirements (S, some the user's call).**
    `train/detect_server.py` (219 lines, Windows DirectShow, "for a future
    `?detector=local` mode" the app never got) is the only reason
    `opencv-python` and `websockets` are required; `tools/solve/hands_survey.py`
    (319) keeps `mediapipe` (+ opencv-contrib) for an archived experiment;
    `bbox_eval/roboflow_audit.py` needs a checkpoint no longer trained;
    `aspect_test.py` / `occl_test.py` are landscape-era; `score_frames.py`
    hard-codes `PAD=0.45` against `shapes.PAD_VAL` 0.20. Delete or move to
    `model/train/attic/`, and the three packages to
    `requirements-extras.txt`. Historical but cited: `viz_nms`,
    `dump_failures`, `bench_*` (`bench_local.py:1` cites a `bench2.py`
    that does not exist), `tools/solve/overlay_log`, `survey_log`.
39. **Pins (S).** `requirements.txt` says "the pinned older torch" but
    nothing is pinned; `triton-windows` is absent though `--compile auto`
    needs it. A `constraints-windows.txt` (`torch==2.6.*`,
    `triton-windows<3.3`) makes CLAUDE.md's deferred upgrade enforceable;
    add `pytest` and `ruff` (CI installs ruff unpinned). The matplotlib
    comment says "viz_nms only"; `cube_latency.py:289` uses it too. Venv
    paths disagree across usage lines (`.venv/Scripts/python` vs
    `.venv/bin/python`; `ruff.toml:2`).
40. **Python tests, from zero (M).** `check_targets.py` (2.3 s) and
    `check_twist.py` (0.9 s) already exit nonzero: wrap them as the first
    two tests. Pure functions to pin: `check_labels.is_convex_simple` /
    `adjacent`, `import_labels.normalize_winding`,
    `dataset.letterbox_params` / `crop_window`, `diagnose.fit_homography`
    / `rotation_deg`, `bbox_eval/common.iou`, `grid_check.seam_score` on a
    synthetic warp, a seeded `augment` label-consistency check, a tiny
    `pretrained=False` export-to-ORT parity. Trap: `aspect_test.py` /
    `occl_test.py` match `*_test.py` and run top-level code on import -
    `testpaths` or rename. Then `pytest` in the CI python job. ruff: add
    `C4`, `SIM`, `RUF` (35 findings, incl. 7 unused unpacked variables),
    `ARG`; `--select ALL`'s big buckets (quotes, annotations, prints) are
    not worth adopting.
41. **Stale plumbing in `tools/` (S).** `tools/solve/replay_clips.py:16`
    hard-codes a Windows Chrome path; `cube_latency.py:23` hard-codes
    `/usr/bin/ffmpeg` while `overlay_log`/`extract_frames` use
    `imageio_ffmpeg`; `tools/eocross/check.ts:14` (8.1 item 7). No
    `__main__` guard in the seven `bbox_eval/*.py`, `overlay_log.py`,
    `replay_clips.py` (latent spawn-recursion risk on Windows).
42. **Model-side docs drift (S).** `model/README.md:4` "currently at M4";
    pad 0.45 at `:40,:62,:145,:645` vs `shapes.py:45` 0.20 with no note of
    the change; `autoscan-main.ts` (`:85,:645`), `scan.html` (`:780,:858`),
    `bbox_vs_faces.py` (`:648`) are gone; `:1049-1058` describes
    `_zoom_crop` and "stage 1 only at acquisition" (now always two-stage);
    `:1200-1205` the landscape `npm run data`; the layout at `:1249` omits
    `data_v6`, `cloud/`, `roboflow`, the twist tooling, and says "int8
    quantize". `cloud/RUNBOOK.md` is v4-era and two of its commands error
    (`check_labels.py --data`, bare `--crop-trained`): archive or a
    "pre-portrait" header. `PORTRAIT-DESIGN.md:3` still says "start from
    here", `:202` says kpft3+box11 deployed, `:71,:122,:173` pad 0.45.
    `targets.py:6`, `viz_nms.py:8` say "grid is 15x20" (16x16 at 256).
    `export_onnx.py:12-17` explains quantisation in terms of the legacy FC
    head.
43. **Data dirs and the drive (S, mostly the user's call).**
    `tools/wsl/setup-user.sh:45-48` omits `model/data_v6` (linked by hand
    on 09-20); `model/preview_twist` is a real 29 MB dir on the Linux disk;
    dead `.gitignore` entries (`model/data`, `data_v3`, `preview_v2`,
    `val2017.zip`) and its int8 comment; `data_real_val/cache_320x240` is a
    stale cache; `diagnose.py --dump` writes into the held-out val dir;
    `roboflow/*.zip` beside their extractions; a stray
    `/mnt/cube-data/recordings$s/`; `/mnt/cube-data/model/clips` (13 GB)
    and `faces` (2 GB) have no producer in the repo; `data_v4` (14 GB) is
    "unused". `model/runs` holds only `mp/` while runs live in
    `model/train/runs`.
44. **The twist audit ran and its numbers were never written down (S,
    then the user's decision).** `docs/twist-head-plan.md:158-160` says to
    write them into `smart-cube-design.md` 5.3. They exist only on the
    drive (`recordings/{2026-09-19-094131,2026-09-19-105604,
    2026-09-20-141443}/twist-audit/twft1/summary.md`): recall at p≥0.5 is
    0.40 / 0.43 / 0.15, false alarms on rest frames 0.17 / 0.013 / 0.066.
    The plan's rule ("at least half the turns readable → step 3, else 3B")
    points at 3B; the call is the user's. The plan's step 2 still names
    `runs/tw-ft1`, which step 1 says failed; `model/README.md:27-29`
    still advertises `--init kpft8 --twist`, which the plan forbids;
    `MILESTONES.md:547-551` says the decision is open.
45. **The legacy head (M, the user's call).** `model.py:36-135` and 48
    `"legacy"` branches across train/export/diagnose/predict/twostage and
    `web/src/detect/facekp.ts:11,121` exist only so the landscape ft1-ft7
    checkpoints load; PORTRAIT decision 5 drops those and the app refuses
    un-stamped models. Same for the `gap` bbox head in `train_bbox.py`.

### 8.6 Docs and process

46. **CLAUDE.md drift (S, one commit).** Commands: `make data/train/export`
    (item 37); missing `lint`, `typecheck`, `build`, `maintain`, `check:*`;
    `Get-Content -Wait` is Windows (`tail -f` here). Layout: "Kalman
    tracker" (`:47`; it is alpha-beta, as `:23` says); `firebase/` sits
    mid-list so everything after it looks nested under `web/src`; "Blender
    or Three.js" (`:137`; Blender was rejected `:188`); export "quantize"
    (`:140`); fixtures "real frames as PNG" (`:135`; they are JSON);
    "four empty stage panels" (`:167`; five); `model/data/` does not
    exist; `cache_320x240` is now `cache_240x320` / `cache_crop320`;
    "until static QDQ is implemented" (it is; the gate picks fp32).
    Missing: `workers/rpc.ts`, `colour/cells.ts`, `ui/dom.ts`,
    `ui/voice.ts`, `timer/track-ui.ts`, `ll/practicegraph.ts`,
    `debug/detect-overlay.ts`, `build.d.ts`, the `detect/` two-stage files
    (`cubebox`, `facekp`, `twostage`, `models`, `ort.worker`, `quality`,
    `orient`, `gridfit`, `coi`, `identify` as the labeler's namer),
    `web/scripts/`, `web/public/` (scan.html redirect, coi-serviceworker,
    eocross-worker.js), `tools/{eocross,solve,wsl}`, `.github/workflows`,
    `recordings/`, `web/clips/`, `cubebox.onnx`. Pipeline: step 2 omits the
    two stages; step 1 says 640x480 (phones deliver 480x640 portrait); step
    8 lists `nMin` / `marginMin` as lock gates but `solve.ts:360-368` gates
    on faces seen, free ≤ 9, legal, `kMax`, `deltaMin` only (the other two
    feed the UI). "Work on the current milestone only" (`:147`) is
    contradicted by M10b and the LL work.
47. **This plan has become a log (M).** Eight status sections (~240 lines)
    before the plan, out of date order; section 6 mostly done but unmarked
    (README names the Solve tab; the trainer survey has its superseded
    line; hand-pose, BBOX-HANDOFF, PORTRAIT-BRIEF archived; `color.ts` is
    gone but `color-notes.md` survived). Restructure: one drift table with
    a row per pass (date, tests, seconds, main kB, clones, console, pack,
    longest file), a newest-first log below it, ticks in the tables.
48. **Docs inventory (S).** Archive: `housekeeping-plan.md` (closed
    2026-09-22, superseded by this), `colour-pipeline-postmortem.md`
    (history; its paths are dead), `reconstruction-sites-survey.md`
    (nothing references it), `smart-cube-trainer-survey.md` (says it is
    superseded). Add a status line: `other-puzzles-survey.md` (partly
    realised by the Algs sheet). `docs/archive/PORTRAIT-BRIEF.md:115`
    cites `model/BBOX-HANDOFF.md` (now in the archive). `wsl-sandbox.md`
    contradicts itself (`:117` nothing runs on Windows, `:140` training
    does) and `:133` says every launch is `headless: 'shell'` (gated on
    `PUPPETEER_SHELL`, `headless.mjs:27`). Then a `docs/README.md` with
    one line per doc and its status, and an archive index with the reason
    each file moved. CLAUDE.md's "Prior art" lists 4 of 15 docs and files
    `ll-drill-next-steps.md` (a live work list) under it.
49. **Design docs vs code (S-M).** `colour-pipeline-design.md` §5 names
    parameters in SCREAMING_CASE with no values (`N_SAT`…) against
    `DEFAULT_PARAMS` (`nSat` 12, `nMin` 6, `kMax` 9, `deltaMin` 3,
    `marginMin` 1, `nu` 3, `gainPrior` 10, `gainMax` 15, `mergeMin` 0.6);
    `freeBelow` 0.5, `rounds` 3, `SIGMA_FLOOR` 2, `COST_CAP` 30 are not in
    the doc; `M_MIN`/`N_MIN` listed as lock gates but only feed the UI; the
    DECISION at `solve.ts:36-40` says `changed` is a UI hint yet `:367`
    gates on `kMax`; §3.1 and §7 name `color.ts`; §7 omits `complete`,
    `neighbours`, `sampler`, `cells`, `robust`, `client`; ~100 lines of
    dated addenda precede the design. `smart-cube-design.md` §3.1 lists
    `smart/ui.ts` (never built; the chip is in `ui/cubeview.ts` +
    `app/smart.ts`); its MoveSource sketch lacks `kind: 'move'`,
    `ordered`, `ResyncItem.how`, `dispose()`. `solve-tracking-design.md`
    §10 omits `source.ts`, `readersource.ts`, `drive.ts`; "10.3 Next" sits
    after §11; its item 1 (typed `Moves` truth) is superseded by
    `scripts/cube-fixture.ts`.
50. **README and MILESTONES (S; the header is the user's call).** README:
    Git LFS is required (without it the scan sheet says no model); the
    phone URL and the self-signed cert / firewall rule
    (`docs/wsl-sandbox.md:96-113`); Node 22; the check scripts and
    `maintain`; `npx vite-node` (item 7); Algs also has the 3x3 last layer.
    MILESTONES: `:5-13` "no move reader yet" (built the same day); the LL
    work of 09-22..25, the Solve tab's scramble voice, the twist result
    (item 44), the FTO's pictures and 3D player (`:566`) are unrecorded;
    the ledger `:670-717` overlaps this plan (`:708-711` "until
    moves-replay.test.ts exists"); "Offline PWA install" appears twice; the
    cube's arrival date disagrees (09-19 vs 09-21).
51. **Process gaps (S-M).** No `docs/README.md`, no archive index, no
    changelog (the commit log stands in), no index of the 132 `DECISION`
    comments (a `grep -rn DECISION` listing the maintain pass regenerates
    would do), no "how to add a tab" guide (the contract is `Stage` and
    `TABS` in `shell.ts:9-27`, the `index.html` panel, the `main.ts`
    mount, `stages[]`, `feed`/`isDone`; one short section in CLAUDE.md).
    `.claude/settings.local.json` is ignored only by the global excludes.
    Names disagree: `cube-scanner` (package.json), "ZZ trainer"
    (manifest), "Cube trainer + scanner" (README).

### 8.7 Proposed edits to the maintain skill

`.claude/skills/maintain/SKILL.md` is outside what a sandboxed pass can
write, so these are for the user to apply:

- Delete `:8-9` ("move it there from `docs/maintain-skill.md`").
- The TODO grep: add `--exclude-dir=node_modules --exclude-dir=.venv`
  (91 hits against 1 real).
- The fixture-unread check: skip `evidence/`, `solves/`, `smart/` (read
  by glob) and instead assert each is non-empty.
- Branches: add `git worktree list` and `git branch --no-merged main`
  (the unmerged `worktree-wsl-chrome-headless-shell`, 2026-09-18,
  superseded by `PUPPETEER_SHELL`).
- A Git LFS health step: `git lfs ls-files` lists both `.onnx`; `head -c
  40 web/public/models/*.onnx` is not pointer text; `lfs: true` still in
  `deploy.yml`.
- A docs-drift step: every backticked path in CLAUDE.md, README.md and
  `docs/*.md` exists; `ls web/src/*/` against the CLAUDE.md layout.
- `npm outdated` in `model/gen` too.
- Python: `python -m compileall -q model/train model/export tools/solve`
  until 8.5 item 40 gives it tests, and say so in the report.
- Section 3: when section 7/8 has nothing pickable, re-rank from the
  drift report and stop for the user, rather than reporting an empty pass.
- The headless note: cite `docs/wsl-sandbox.md` and `headless.mjs:9-27`,
  and name the two hosts the Chrome download needs
  (`storage.googleapis.com`, `googlechromelabs.github.io`).
- The masks list: "an untracked char device or dotfile at the root is a
  mask" instead of four names (there are a dozen).

### 8.8 Suggested order

| # | items | effort | why |
|---|---|---|---|
| 1 | 8.1 bugs 1-9 | S ×9 | real bugs; each a commit with a test |
| 2 | 10 deploy gate + CI hygiene, 14 Node pin | S | a red suite must not deploy |
| 3 | 22 dev-server readiness, 20-21 the empty 16 s of tests | S | every check and every `npm test` a minute faster |
| 4 | 37 Makefile, 46 CLAUDE.md, 42 model docs | S | the commands a newcomer types must not overwrite the model |
| 5 | 13 dead ort.min, 12 cache-busting, 16 size ratchet | S | deploy correctness after a bump |
| 6 | 11 lazy detector, 16 lazy smartcube / f2l data | M | the Solve tab should not download 34 MB |
| 7 | 36 ckpt.py + geom.py, 38 orphans + extras, 39 pins, 40 first pytest | M | the Python half gets its first tests and one loader |
| 8 | 29, 30, 28, 31 (one dup per commit) | S each | tsc-guarded mechanical work |
| 9 | 23 the checks' hygiene, 25-26 suite slack and config | M | a runnable UI net that does not lie |
| 10 | 33 seams + 24 tests, 32 one graph, 34 imports | M-L | the last structural work; each seam ships with its tests |
| 11 | 47 plan restructure, 48 docs inventory, 49 design docs, 50-51 | S-M | after the code settles |
| 12 | 27 the indexed-access decision, 15 vendor smartcube, 17 rules, 18 offline, 43 the drive, 44 twist, 45 legacy head | decide | the user's calls, in one sitting |

Rows 1-5 are a day and each ships on its own. Row 12 is one
conversation, not a pass.
