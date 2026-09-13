# Cube trainer + scanner

> **Work in progress.** Expect rough edges, missing features, and breaking changes. The camera scanner works grid-first; the learned face detector is training up alongside it (M4/M5).

**Live app: https://moowiz.github.io/cube-trainer/**

A browser app for Rubik's cube practice and scanning — everything runs client-side, nothing leaves your device.

- **EO trainer / ZZF2L tabs** — drill EO recognition and ZZ-style F2L cases.
- **Scan cube tab** — read a scrambled cube's state through your phone camera: hold each face in the 3x3 grid, colors are classified in CIE Lab, the state is validated, and you get a solution you can hand straight to the trainer. There's also a standalone test page at [`/scanner.html`](https://moowiz.github.io/cube-trainer/scanner.html).
- **[`/autoscan.html`](https://moowiz.github.io/cube-trainer/autoscan.html)** — any-order scanner (M6/M7, experimental): turn the cube in view, faces are detected/tracked/sampled automatically, state locks on cubejs validation.
- **[`/detect.html`](https://moowiz.github.io/cube-trainer/detect.html)** — live debug view of the learned face-keypoint detector (quads + confidence + fps, WebGPU/wasm selectable).
- **[`/bbox.html`](https://moowiz.github.io/cube-trainer/bbox.html)** — live debug view of the *stage-1* cube localizer on its own (box + objectness + inference ms). The two detector stages are separate steps, and this page loads only the localizer, never the keypoint model, so a localizer problem can't hide behind a detector problem.
- **[`/label.html`](https://moowiz.github.io/cube-trainer/label.html)** — hand-labeling tool for fine-tuning photos; the Suggest button runs the currently deployed model in-page.

The longer-term plan (see [MILESTONES.md](MILESTONES.md)) is the learned keypoint detector end-to-end, so you can just turn the cube in view — no grid alignment, no prompts. Design notes live in [CLAUDE.md](CLAUDE.md); the model side (synthetic data, training, ONNX export) is documented in [model/README.md](model/README.md).

## Development

```sh
cd web
npm install
npm run dev    # HTTPS dev server (camera needs it) — open the https:// URL on your phone
npm test       # vitest
npm run build  # typecheck + production build
```

`web/index.html` is generated from the trainer HTML at the repo root — run `node tools/patch-trainer-into-web.js` after changing the trainer instead of editing it by hand.

Pushing to `main` deploys to GitHub Pages via [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml).

## License

[MIT](LICENSE)
