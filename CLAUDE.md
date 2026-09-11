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
- The user can always tap a sticker to override it.

## Pipeline (per frame)

1. Capture: `getUserMedia`, rear camera, 640x480, into a `<video>`.
2. Detect: keypoint model → 4 corners + confidence for each visible face (up to 3).
3. Track: Kalman filter on corners. Run the detector every 2–3 frames, interpolate between.
4. Rectify: homography-warp each face quad to a 90x90 canvas.
5. Sample: average a ~12px patch at each of the 9 cell centers. Convert to CIE Lab.
6. Classify: rolling k-means over all samples, k=6, Lab distance. Seeded once ≥6 distinct clusters seen.
7. Identify: center sticker → face id. Two adjacent faces in one frame → relative orientation.
8. Assemble: per-sticker vote counts into a 54-entry state. Lock when converged and `cubejs` accepts it.

## Conventions

- Face order and notation follow the standard: U R F D L B. Sticker indexing follows cubejs's facelet string order (U1..U9, R1..R9, F1..F9, D1..D9, L1..L9, B1..B9).
- Color scheme is NOT hardcoded. Centers define it. Default assumption for UI only: white U, green F (standard scheme, white opposite yellow, green opposite blue, red opposite orange).
- Colors are compared in Lab, never RGB or raw HSV. HSV is allowed only as a debug view.
- Models are exported to ONNX with static input shape and int8 quantization. Runtime is `onnxruntime-web` with the `webgpu` execution provider and `wasm` fallback. Never assume WebGPU exists.
- All image-processing steps are pure functions on `ImageData` or typed arrays so they can be unit-tested without a camera.

## Repo layout

```
web/
  src/
    camera.ts        getUserMedia setup, frame pump
    detect/          ORT session, pre/post-processing, Kalman tracker
    rectify.ts       homography + warp
    color.ts         Lab conversion, sampling, k-means
    state.ts         54-sticker vote model, convergence, cubejs validation
    ui/              overlay canvas, sticker grid, tap-to-fix
    debug/           HSV/Lab views, frame dump, fps counter
  public/models/     facekp.onnx (gitignored; built by model/)
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
- Every milestone ends with something runnable on a phone. Prefer an ugly working step over a clean partial one.
- When a step is ambiguous (thresholds, model size, frame rate), pick a sensible default, note it in a `// DECISION:` comment, and move on. Don't stop to ask.
- Debug views are first-class. When adding a processing step, add a way to see its output in the debug panel.
- Test fixtures beat mocks. When something misbehaves on a real frame, save the frame to `web/test/fixtures/` and write a test against it.
- Keep `model/` and `web/` independent: `web/` must run (with the grid-overlay fallback) even if no model file is present.

## Commands

```
cd web && npm run dev        # vite dev server, https for camera access
cd web && npm test           # vitest
cd model && make data        # generate synthetic set
cd model && make train
cd model && make export      # writes web/public/models/facekp.onnx
```

## Known hard cases (don't be surprised)

- Red vs orange and white vs yellow under warm indoor light.
- Specular glare on the face nearest the light — often wipes out one sticker.
- Stickerless cubes: no black borders, so edge-based methods fail. This is why we use a learned detector.
- Tiles/grids in the background (bathroom, keyboard) produce false face candidates.
