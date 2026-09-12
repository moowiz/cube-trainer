# cube-trainer

Reads the state of a 3x3 Rubik's cube from a live camera feed, entirely in
the browser — no server, no APIs. Detection is a learned face-keypoint model
(ONNX, running on-device via onnxruntime-web); output is a validated
54-sticker cube state and a solution.

**Live pages** (GitHub Pages, deployed from `main`):

- **App / scanner:** https://moowiz.github.io/cube-trainer/
- **Detector debug view:** https://moowiz.github.io/cube-trainer/detect.html
- **Labeling tool:** https://moowiz.github.io/cube-trainer/label.html —
  hand-label cube photos for fine-tuning; the Suggest button runs the
  currently deployed model in-page.

Repo halves: [`web/`](web/) is the TypeScript app, [`model/`](model/) is the
Python side (synthetic data generation, training, ONNX export — see
[`model/README.md`](model/README.md)). Roadmap and status live in
[`MILESTONES.md`](MILESTONES.md); working conventions in
[`CLAUDE.md`](CLAUDE.md).
