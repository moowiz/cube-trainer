# MILESTONES.md

Each milestone ends with something you can run on a phone. Don't start the next one until the "done when" holds.

---

## M0 — Skeleton

Vite + TypeScript project in `web/`. Camera feed rendered to a canvas. FPS counter. HTTPS dev server (camera requires it). Deployable as static files.

**Done when:** the app opens on a phone, shows the rear camera at ~60 fps, and `npm test` runs one trivial test.

---

## M1 — Grid overlay scanner (the baseline product)

Fixed 3x3 grid overlay on the video. Sample 9 cells per frame. Lab conversion + k-means classification. Scan six faces in U R F D L B order with an on-screen prompt. Face locks after N stable frames. Full state assembled, validated with cubejs, solution displayed. Tap any sticker to override.

This is the fallback path that must keep working forever.

**Done when:** you can scan a scrambled cube in a normally lit room and get a valid state on the first try most of the time, and cubejs produces a solution.

**Watch for:** red/orange split. If k-means merges them, seed centroids from the six centers instead of random init.

---

## M2 — Test harness and debug tooling

Save-frame button that dumps the current `ImageData` plus the detected sticker colors to `web/test/fixtures/`. Debug panel with Lab and HSV views, cluster centroids, per-sticker confidence. Unit tests for `color.ts` and `state.ts` against fixtures.

**Done when:** a color misread can be reproduced from a fixture in a test without a camera.

---

## M3 — Synthetic data generator

In `model/gen/`: render a stickered and a stickerless cube with random scrambles, random camera pose (all three-face views), random lighting (including warm light and glare), random backgrounds (COCO or similar, plus procedural grids/tiles as hard negatives). Output image + per-face 4-corner labels + visibility flags. Target 20k images.

**Done when:** rendered images look plausible next to phone photos of your cubes, and labels visualize correctly when drawn back on the image.

**Decision to make here:** Blender (better realism, slower iteration) vs Three.js headless (faster, easier to match the web renderer). Default to Three.js unless realism is clearly the bottleneck.

---

## M4 — Face keypoint model

Small keypoint detector (MobileNetV3 or similar backbone, heatmap or direct-regression head) predicting up to 3 faces × 4 corners + per-face confidence. Train on synthetic data. Export to ONNX, int8 quantize, verify it loads in `onnxruntime-web`.

**Done when:** on a held-out synthetic set, mean corner error < 3 px at 320x240 input, and the ONNX model runs in the browser on a phone at ≥15 fps (measure, don't guess).

**Watch for:** WebGPU availability. Benchmark both `webgpu` and `wasm` providers; if wasm is too slow, shrink the model before optimizing anything else.

---

## M5 — Real-data fine-tune

Hand-label 200–400 real frames (your two GANs, several rooms, both scheme orientations). Fine-tune. Re-export.

**Done when:** the detector finds faces on the M2 fixture frames without manual alignment.

---

## M6 — Tracking + rectification in the app

Wire the detector into `web/`. Kalman filter on corners. Run detection every 2–3 frames, interpolate. Homography warp each face to 90x90. Feed rectified faces into the M1 sampling/classification path.

**Done when:** you can hold the cube at any angle and see the overlay stick to the faces smoothly; sticker colors populate without the fixed grid.

---

## M7 — Any-order state assembly

Center-sticker face identification. Use adjacency of co-visible faces to orient each face's 9 stickers correctly in the global frame. Per-sticker voting across frames. Lock on convergence + cubejs validation. Highlight low-confidence stickers for tap-to-fix.

**Done when:** you can scan a scrambled cube by just turning it around in view with no prompts, and get a valid state.

---

## M8 — Hardening

- Glare handling: drop samples where L is saturated, weight votes by confidence.
- Hard-negative retraining with background grids.
- Low-light behavior.
- Graceful degradation: if detection confidence stays low for N seconds, offer the M1 grid mode.
- Performance pass on a low-end phone.

**Done when:** it works in your kitchen, bathroom, and outdoors, on both GANs, and on a friend's stickerless cube.

---

## Later / maybe

- 2x2 and other puzzles (needs a new detector head and state model).
- Scanning a cube mid-solve for a "where am I" trainer.
- Offline PWA install.
