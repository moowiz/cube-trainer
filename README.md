# Cube trainer + scanner

> **Work in progress.** Expect rough edges and breaking changes.

**Live app: https://moowiz.github.io/cube-trainer/**

A browser app for Rubik's cube practice and scanning. Everything runs client-side: the detector, the colour solver and the cube solver all run in your browser, nothing leaves your device.

One page, three tabs:

- **EO trainer** — drill EO or EOCross (white down, edges oriented to the front/back axis). Random scrambles, a rotatable cube, timer, hints, and every optimal solution for the goal: the EO list groups solutions by F/B plan, the EOCross list by how many cross moves follow the last EO turn, and the moves you typed get tagged if they were optimal. EOCross optima come from an exact table built in a worker. What optimal EOCross looks like, measured: [docs/eocross-patterns.md](docs/eocross-patterns.md).
- **ZZF2L** — ZZ-style F2L case drills.
- **Scan cube** — point the rear camera at a scrambled cube and turn it in view. A two-stage detector (cube localizer → face corners) finds and tracks up to three faces per frame, stickers are sampled into an evidence log, and a constrained colour decoder locks the 54-sticker state only when it can certify it (legal, enough evidence, clear margins). A lock hands the cube to the EO trainer as a scramble. The debug panel shows the pipeline stage by stage and exports the evidence log for replay tests.

Also [`/label.html`](https://moowiz.github.io/cube-trainer/label.html), the hand-labelling tool for fine-tuning photos and clips; its Suggest button runs the deployed model in-page.

A version chip in the bottom-left corner of every page shows the git revision and the deployed detector runs.

Milestones and status: [MILESTONES.md](MILESTONES.md). Working conventions and the per-frame pipeline: [CLAUDE.md](CLAUDE.md). Design notes: [docs/](docs/) (colour pipeline design and post-mortem, solve tracking, EOCross patterns). The model side (synthetic data, training, fine-tuning on real photos, ONNX export) is in [model/README.md](model/README.md).

## Development

```sh
cd web
npm install
npm run dev    # HTTPS dev server (camera needs it) — open the https:// URL on your phone
npm test       # vitest: pure-function tests plus evidence-log replays against phone captures
npm run build  # typecheck + production build
```

`web/index.html` is generated from the trainer HTML at the repo root — run `node tools/patch-trainer-into-web.js` after changing the trainer instead of editing it by hand.

Scanner replays without a phone: `?tab=scan&clip=/clips/<name>.mp4` plays a recording through the real pipeline (see `web/src/ui/scanner.ts` for the flags). `node tools/eocross/check.mjs` checks the EOCross solver headlessly.

Pushing to `main` deploys to GitHub Pages via [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml).

## License

[MIT](LICENSE)
