# CLAUDE.md — Browser Rubik's Cube Scanner

## What this is

A web app that reads the state of a 3x3 Rubik's cube from a live camera feed, entirely in the browser. No external APIs, no server-side inference. Output is a validated 54-sticker cube state (and a solution via cubejs).

Two halves:

- `web/` — the app. TypeScript, Vite, vanilla DOM (no framework unless a milestone says otherwise). Runs on phones.
- `model/` — Python. Synthetic data generation, keypoint model training, ONNX export. Produces `web/public/models/facekp.onnx`.

## Non-negotiables

- Everything runs client-side. Never add a network call for inference or image processing.
- Must work on a mid-range Android phone in Chrome. Target ≥15 fps end-to-end with the detector, 60 fps without it.
- Never trust a single frame. Every sticker reading is a vote; the cube state is only "locked" after convergence and cubejs validation.
- The user can always tap a sticker to override it. (Not yet true of the auto scanner: it refuses to lock rather than guess; tap-to-fix went with the grid scanner on 2026-09-14 and is owed.)

## Pipeline (per frame)

1. Capture: `getUserMedia`, rear camera, 640x480, into a `<video>`.
2. Detect: keypoint model → 4 corners + confidence for each visible face (up to 3).
3. Track: alpha-beta filter on corners, state kept at measurement time. Run the detector every 2–3 frames, interpolate between. The view is delayed by the detector's measured latency (`framering.ts`) so every overlay is drawn on the frame its corners came from; a late detection is fused at its own frame time and extrapolated, never fused as current.
4. Rectify: homography-warp each face quad to a 90x90 canvas.
5. Sample: robust patch statistics (trimmed median, clip/dark fractions, spread, censoring) at each of the 9 cell centers; the centre cell reads a diagonal ring around the logo. Each reading gets a quality WEIGHT (blur, motion, view angle, size, track age, glare, seam) - never a gate.
6. Log: readings go into an append-only EvidenceLog keyed by track id and cell, with letter-free shared-edge pairings between co-visible quads. The log IS the capture format; the solver is a pure function of it (`web/src/colour/`).
7. Solve (in a worker, every ~700 ms): per-track robust aggregation -> six-colour palette + per-frame illumination fitted under the cube's constraints -> tracks grouped into faces (co-visibility veto) -> letters and rotations from geometry, names from ordinal ranks -> 54x6 costs -> exact constrained decoder (9 per colour, distinct centres, legality search, delta certificate). Design: `docs/colour-pipeline-design.md`.
8. Lock: only on the decoder's certificates (legal, evidence floor, few changes, delta and margin floors). A wrong lock is worse than no lock.

## Conventions

- Face order and notation follow the standard: U R F D L B. Sticker indexing follows cubejs's facelet string order (U1..U9, R1..R9, F1..F9, D1..D9, L1..L9, B1..B9).
- Detector corner labels are order-free up to cyclic rotation: the training loss takes the min over the 4 cyclic shifts of the target quad, because on a dead-on lone face the starting corner is unobservable — demanding it made the model average the 4 rotations into shrunken diamonds. Labels are clicked going around the face (any start/direction; winding normalized at import); orientation is recovered downstream (pipeline step 7).
- Color scheme is NOT hardcoded. Centers define it. Default assumption for UI only: white U, green F (standard scheme, white opposite yellow, green opposite blue, red opposite orange).
- **Say colours, not face letters.** In conversation, reports, debug views, label audits, test names and comments, refer to faces and stickers by colour ("the orange centre", "yellow labelled as orange") - never "the L face" or "labelled R". Letters (U R F D L B) are only for code paths that need cubejs's facelet convention (`state.ts`, the label JSON's slot names, the solver's final string), and even there a comment should name the colour. Why: the letters are one indirection away from what anyone can see in a photo, and every letter/colour mix-up so far (ten wrong slots across batches 7-8) hid behind them.
- Colors are compared in Lab, never RGB or raw HSV. HSV is allowed only as a debug view.
- Models are exported to ONNX with static input shape. int8 is aspirational: dynamic quantization shifts corners ~24 px (the FC regression head quantizes terribly), so `export_onnx.py` gates on measured shift and ships fp32 until static QDQ calibration is implemented. Runtime is `onnxruntime-web` with the `webgpu` execution provider and `wasm` fallback. Never assume WebGPU exists.
- All image-processing steps are pure functions on `ImageData` or typed arrays so they can be unit-tested without a camera.

## Repo layout

```
web/
  src/
    camera.ts        getUserMedia setup, frame pump
    framering.ts     recent frames frozen on arrival; the synced (latency-delayed) view
    detect/          ORT session, pre/post-processing, Kalman tracker
    rectify.ts       homography + warp
    color.ts         Lab conversion, patch statistics, sampling geometry, Hungarian
    colour/          the colour solver: types, evidence log + weights, colorspace
                     (pluggable embedding), robust stats, palette, illum, faces
                     (track grouping), naming, decode (exact decoder), solve,
                     solve.worker + client
    state.ts         validateState (legality oracle), rotation helpers, cubejs solve
    cube/            THE cube code every trainer shares: alg (one parser for turns/slices/wide/rotations),
                     state (facelets from an alg, rotations undone), geometry (facelet -> 3D), pieces
                     (edge/corner tables, EO bits, the 12-edge move model the solvers and the EOCross
                     worker use), render (3D + net SVG), scheme (colour setting), frame (trainer / WCA /
                     solver letter maps)
    ui/              drill.ts (the timed-drill scaffold EO/OCLL/PLL sit on), scanner.ts (the scan sheet:
                     camera, overlay, evidence, lock, live scramble check), cubeview.ts (the Cube sheet:
                     what the app believes the cube looks like, the smart cube's controls and resyncs),
                     fingertricks.ts (the tricks sheet: a move sequence finger by finger, triggers as one
                     step), hint, settings
    moves/           the camera move reader (reader, anchor, record) AND the MoveSource contract every
                     consumer of turns reads (source.ts: cube / camera / typed / replay) and the drill
                     driver (drive.ts: arms at the scramble state, feeds the turns after it)
    smart/           the smart cube (docs/smart-cube-design.md): adapter.ts (the only file that imports
                     smartcube-web-bluetooth), clock (two-clock fit), sync (the belief reducer), capture
                     (JSONL + replay), source (CubeSource). Fixtures in test/fixtures/smart/; the headless
                     check `node scripts/check-smart.mjs` replays one through the built page
    timer/           the Solve tab (the timer that replaces csTimer): trainer (the tab), stats (averages,
                     csTimer's 5% trim), cstimer (its export file both ways), track (scramble following)
    store/           the solve store: types (records in WCA notation), local (IndexedDB, always), sync
                     (optional Firestore layer, Google sign-in), firebase (the only SDK import, lazy)
firebase/            firestore.rules (per-user) + firebase.json; paste into the console or deploy with the CLI
    shell.ts         tabs, sheets, toast, keys, the `stages` registry (window.ZZ is a facade for tooling)
    eo/              solver (2^12 table, families, plans), eocross (worker client + per-scramble strategy), trainer
    f2l/             the ZZF2L case finder: data (the sheet), model (slots, cases, scramble generators), trainer
    ll/              OCLL / PLL drills: cases (algs verified by test), model (identify modulo AUF, chain partner),
                     scramble (an optimal phase-2 solver: face-turn scrambles for PLL states), pic (the top-down
                     picture), reference (the case list sheet: pictures, algs with triggers, chains), trainer
    handoff.ts       a locked scan as a scramble in the trainer's frame, and the reverse for the live check
    follow.ts        following a solve: lock + turns read -> trainer scramble, turns relabelled between
                     frames (relabelTurns), and the settled stage change
    stage.ts         which ZZ stage a cube is at (EO / F2L / OCLL / PLL), off a facelet string
    main.ts          mounts every stage into index.html, wires the shell, bridges the scanner
    debug/           HSV/Lab views, frame dump, fps counter
  public/models/     facekp.onnx + facekp.json (committed so Pages serves them; built by model/)
  test/              fixtures = real frames as PNG + expected outputs
model/
  gen/               Blender or Three.js synthetic scene, scramble + pose randomizer
  data/              (gitignored) generated + hand-labeled images
  train/             keypoint model, loss, augmentation
  export/            torch → onnx → quantize, plus a sanity check that ORT-web loads it
  README.md
MILESTONES.md
```

## Working style

- Read `MILESTONES.md` first. Work on the current milestone only; don't pull forward work from later ones.
- Delegate to subagents where appropriate: a self-contained module with a
  clear contract (one file, defined inputs/outputs, no architectural
  decisions) goes to a cheaper model (sonnet) while the main thread keeps
  working. Keep architecture, cross-module interfaces, and anything
  judgment-heavy in the main thread. Fix the contract (data shapes, file
  paths, conventions) in the prompt before spawning.
- Commit work to save it, and push to GitHub (`origin`, HTTPS remote). Pushing `main` also deploys the app to GitHub Pages via `.github/workflows/deploy.yml`.
- Every milestone ends with something runnable on a phone. Prefer an ugly working step over a clean partial one.
- When a step is ambiguous (thresholds, model size, frame rate), pick a sensible default, note it in a `// DECISION:` comment, and move on. Don't stop to ask.
- Debug views are first-class. When adding a processing step, add a way to see its output in the debug panel.
- When launching a training/fine-tuning run (or any long background job that
  logs progress), immediately give the user a copy-pasteable command to watch
  it, e.g. `Get-Content <log path> -Wait -Tail 10`. For training runs, ALSO
  start the live dashboard unless it's already up (`model/train/watch.py`,
  serves http://localhost:8123; probe the port first — a second launch just
  fails to bind) and hand the user that URL. Redirect training output to
  `runs/<name>-console.log` so the dashboard picks the run up.
- Test fixtures beat mocks. When something misbehaves on a real frame, save the frame to `web/test/fixtures/` and write a test against it. For the colour solver the fixture is the phone's `Capture debug` JSON (it holds the whole evidence log): drop it in `web/test/fixtures/evidence/` with a `truth` field and `colour-replay.test.ts` picks it up.
- Keep `model/` and `web/` independent: `web/` must run (the trainer works, the scan sheet says no model is deployed) even if no model file is present.
- `web/index.html` is markup only (tab bar, four empty stage panels, the scan and settings sheets, the toast) plus `src/main.ts`. No inline scripts: every trainer is a TypeScript module on `src/cube/*`. Do not add a second cube model, parser, or renderer - extend `src/cube/`.
- Scrambles are SHOWN and TYPED in WCA orientation (white up, green front: `cube/frame.ts` toWca/fromWca); every trainer WORKS in its own frame (white down, the chosen colour in front), which is what the pictures and the moves you type use.

## Commands

```
cd web && npm run dev        # vite dev server, https for camera access
cd web && npm test           # vitest
cd model && make data        # generate synthetic set
cd model && make train
cd model && make export      # writes web/public/models/facekp.onnx
```

## Hard-won facts (don't relearn these)

- Real labeled data beats render realism, by a lot: 22 hand-labeled photos took real-photo error 58 → 4.6 px; the HDRI/rounded-cubie generator realism pass was worth a further ~20% on top. Full experiment ladder and current best numbers live in `model/README.md`. A Blender port was evaluated and rejected as not the bottleneck.
- A held-out real-photo val split exists: `model/data_real_val/` (~20 photos
  stratified across batches, plus designated batch6 picks in
  `stephens_photos/batch6/val-picks.json`). NEVER pass it to `--data`, never
  "fix" its labels based on model behavior. train.py reports `real_px` on it
  every epoch; fine-tunes should use `--select real` so `best.pt` is picked
  on real photos (this replaces the old "deploy last.pt" workaround, which
  existed because synthetic-dominated val favored the least-adapted epoch).
  Only ~40 photos: trends are meaningful, 1-2% differences are noise.
- `model/data_real/` and `stephens_photos/` are gitignored **on purpose** — personal photos, public repo. Never commit them. The hand labels exist only on this machine; occasionally remind the user to back up `stephens_photos/labels-all.json`.
- The real-data loop is: `check_labels.py` (geometry checks, run before importing) → `import_labels.py` (re-imports update edited labels in place; the dataset cache fingerprints label files so edits trigger a rebuild) → fine-tune ~15 epochs at lr 5e-5 with `--data <synthetic>,../data_real*150 --init <base>` → export → deploy. Labeling conventions are in `model/README.md`.
- The training cache (`cache_320x240/`) and `--data root*N` oversampling make fine-tunes a few minutes; a 150-epoch from-scratch run on the 54k set is ~45 min compiled at 8 workers (2026-09-12: sync-free step + torch.compile, see `model/README.md` "Training performance"). CPU ceiling agreed with the user: ~80% (~12 DataLoader workers) — never saturate the machine.
- Killing a running train.py does NOT kill its DataLoader workers on Windows:
  orphaned `spawn_main` python processes linger and hold the inherited
  `runs/<name>-console.log` handle, so relaunches die with "file is being
  used by another process" — hunt them down first. Detached launches of
  train.py (Start-Process cmd/batch) silently fail on this machine anyway
  (instant exit 0): run training as a normal session background task and use
  `--resume` after interruptions.

## Prior art

- `docs/rubiks-vision-analysis.md` — analysis of gillis.oldfeldt/rubiks-vision
  (a comparable browser scanner: whole-cube 54-keypoint pose, learned colour
  model, exact 9-per-colour decoder). Verdict: keep our per-face
  architecture; port the separable pieces (exact decoder, quality gates,
  wasm threads). Read it before redesigning the colour lock or the tracker.
- `docs/colour-pipeline-postmortem.md` — what one day of phone testing taught
  about the old colour half (centre-cluster identity, ordinal naming, per-cell
  voting): the failure log and why it was structurally fragile.
- `docs/colour-pipeline-design.md` — the replacement (implemented 2026-09-13
  in `web/src/colour/`): principles, stages, how each hard case is handled,
  the parameter list, the evidence-log capture format and replay method.
  Read it before touching anything under `web/src/colour/`.

## Known hard cases (don't be surprised)

- Red vs orange and white vs yellow under warm indoor light. Handled by the
  constrained decoder (nine per colour, distinct centres) and the ordinal
  naming by hue; when the evidence genuinely cannot separate them the delta
  certificate refuses the lock instead of guessing.
- Specular glare on the face nearest the light — often wipes out one sticker.
- Stickerless cubes: no black borders, so edge-based methods fail. This is why we use a learned detector.
- Tiles/grids in the background (bathroom, keyboard) produce false face candidates.
