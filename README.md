# Cube trainer + scanner

> **Work in progress.** Expect rough edges and breaking changes.

**Live app: https://moowiz.github.io/cube-trainer/**

A browser app for Rubik's cube practice and scanning. Everything runs client-side: the detector, the colour solver and the cube solver all run in your browser, nothing leaves your device.

One page: a Solve tab and four stage tabs, a scan button, a Cube sheet for a smart cube, an Algs sheet for the other puzzles, and a settings sheet:

- **Solve** — the timer that replaces csTimer: WCA random-state scrambles (the next one prefetched), a press-and-release pad or the smart cube's own turns to start and stop, averages with csTimer's trim, the history as a graph, csTimer's export file in and out. With a smart cube the scramble is followed on screen as you apply it, and the solve can drag the tabs through the stages as the cube crosses into them (or stay put: its own choice).
- **EO trainer** — drill EO or EOCross (white down, edges oriented to the front/back axis). Random scrambles, a rotatable cube, timer, hints, and every optimal solution for the goal: the EO list groups solutions by F/B plan, the EOCross list by how many cross moves follow the last EO turn, and the moves you typed get tagged if they were optimal. EOCross optima come from an exact table built in a worker. What optimal EOCross looks like, measured: [docs/eocross-patterns.md](docs/eocross-patterns.md).
- **F2L** — ZZ-style F2L case drills.
- **OCLL / PLL** — last-layer drills: a random case (OCLL 7, PLL 21) or the cube handed over from the previous stage or a scan, the top-down diagram, timer, hints that reveal the case, Check on the moves you did, and the standard alg with the AUF for the angle shown. F2L (tracked) → OCLL → PLL chain with a Continue button at each step.
- **📷 Scan** — point the rear camera at your cube and turn it in view. A two-stage detector (cube localizer → face corners) finds and tracks up to three faces per frame, stickers are sampled into an evidence log, and a constrained colour decoder locks the 54-sticker state only when it can certify it (legal, enough evidence, clear margins). While you scan it checks the cube against the open stage's scramble, live ("38 of 54 stickers read, all match"); a lock says whether it was the scramble, works out which stage the cube is at and opens that tab with it loaded. The debug panel shows the pipeline stage by stage and exports the evidence log for replay tests.
- **Listed solutions and algs** — tap a line to put it in the moves box, hover (or tap) a move to see the cube before and after it with what the move is (y, S, wide moves...), ▶ to show the line's result on the picture.
- **✋ Fingertricks** — on every stage: the scramble, a solution you tapped, or the moves you typed, step by step - what each layer does and the usual finger for it, common triggers (sexy move, sledgehammer, R U R' inserts) as one step, and where a regrip is coming.
- **Cube** — a GAN smart cube over Web Bluetooth (docs/smart-cube-design.md): what the app believes the cube looks like, resyncs (solved, from a scan, the cube's own report), and its turns feeding every drill as they happen. A last-layer drill can read the alg aloud or ask you the case and hear your answer.
- **Algs** — the other puzzles' cheat sheet (2x2, 4x4, 5x5, Pyraminx, Skewb, FTO): case pictures, algs with triggers, a 3D player you can drag and step through; every cube alg is verified by test.
- **⚙** — the colour you hold in front (white stays down), each stage's options, and an optional Google sign-in that syncs solves, drill attempts and favourite algs to Firestore (`firebase/`); everything works signed out, locally.

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
npm run check:smart   # the smart-cube path replayed through the built page in headless Chrome (also check:detect, check:record, check:rig)
```

`web/index.html` is markup only; `src/main.ts` mounts the Solve tab (`src/timer`) and the four stage trainers (`src/eo`, `src/f2l`, `src/ll`) on one shared cube core (`src/cube`: alg parser, states, geometry, pieces, renderer, colour scheme, frames) and one drill scaffold (`src/ui/drill.ts`), wires the shell (`src/shell.ts`) and bridges the scanner. Scrambles are shown in WCA orientation (white up, green front); the trainers work white down with your chosen colour in front.

Scanner replays without a phone: `?tab=scan&clip=/clips/<name>.mp4` plays a recording through the real pipeline (see `web/src/ui/scanner.ts` for the flags). `cd web && npx vite-node --root .. ../tools/eocross/check.ts` checks the EOCross solver headlessly against the built page.

Pushing to `main` deploys to GitHub Pages via [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml).

## License

[MIT](LICENSE)
