# Cube trainer + scanner

> **Work in progress.** Expect rough edges, missing features, and breaking changes. The camera scanner works grid-first; the learned face detector is training up alongside it (M4/M5).

**Live app: https://moowiz.github.io/cube-trainer/**

A browser app for Rubik's cube practice and scanning — everything runs client-side, nothing leaves your device.

- **EO trainer / ZZF2L tabs** — drill EO recognition and ZZ-style F2L cases.
- **Scan cube tab** — read a scrambled cube's state through your phone camera: hold each face in the 3x3 grid, colors are classified in CIE Lab, the state is validated, and you get a solution you can hand straight to the trainer.
- **[`/scan.html`](https://moowiz.github.io/cube-trainer/scan.html)** — the one camera page. *Auto* (default): turn the cube in view, the two-stage detector (cube localizer → face corners) finds, tracks and samples faces, and the state locks on cubejs validation. *Grid* ([`?mode=grid`](https://moowiz.github.io/cube-trainer/scan.html?mode=grid)): the same grid scanner as the trainer tab. The *Debug* panel replaces the old detect/bbox pages: execution provider, detection cadence, stage-1 box/ROI and heatmap overlays, a localizer-only switch, per-sticker readout, raw-frame and naming-evidence exports for labeling.
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
