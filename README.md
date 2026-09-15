# Cube trainer + scanner

> **Work in progress.** Expect rough edges and breaking changes.

**Live app: https://moowiz.github.io/cube-trainer/**

A browser app for Rubik's cube practice and scanning. Everything runs client-side: the detector, the colour solver and the cube solver all run in your browser, nothing leaves your device.

One page, four stage tabs plus a scan button and a settings sheet:

- **EO trainer** — drill EO or EOCross (white down, edges oriented to the front/back axis). Random scrambles, a rotatable cube, timer, hints, and every optimal solution for the goal: the EO list groups solutions by F/B plan, the EOCross list by how many cross moves follow the last EO turn, and the moves you typed get tagged if they were optimal. EOCross optima come from an exact table built in a worker. What optimal EOCross looks like, measured: [docs/eocross-patterns.md](docs/eocross-patterns.md).
- **F2L** — ZZ-style F2L case drills.
- **OCLL / PLL** — last-layer drills: a random case (OCLL 7, PLL 21) or the cube handed over from the previous stage or a scan, the top-down diagram, timer, hints that reveal the case, Check on the moves you did, and the standard alg with the AUF for the angle shown. F2L (tracked) → OCLL → PLL chain with a Continue button at each step.
- **📷 Scan** — point the rear camera at your cube and turn it in view. A two-stage detector (cube localizer → face corners) finds and tracks up to three faces per frame, stickers are sampled into an evidence log, and a constrained colour decoder locks the 54-sticker state only when it can certify it (legal, enough evidence, clear margins). While you scan it checks the cube against the open stage's scramble, live ("38 of 54 stickers read, all match"); a lock says whether it was the scramble, works out which stage the cube is at and opens that tab with it loaded. The debug panel shows the pipeline stage by stage and exports the evidence log for replay tests.
- **⚙** — the colour you hold in front (white stays down) and each stage's options, in one place.

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

`web/index.html` is the trainer page itself: the stage tabs, the scan and settings sheets, and the inline EO and F2L trainers. `src/trainer-main.ts` mounts the scanner into it and routes a locked scan to the stage the cube is at (`src/stage.ts`).

Scanner replays without a phone: `?tab=scan&clip=/clips/<name>.mp4` plays a recording through the real pipeline (see `web/src/ui/scanner.ts` for the flags). `node tools/eocross/check.mjs` checks the EOCross solver headlessly.

Pushing to `main` deploys to GitHub Pages via [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml).

## License

[MIT](LICENSE)
