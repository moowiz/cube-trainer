# model/ — synthetic data + keypoint model

Produces (eventually) `web/public/models/facekp.onnx`, the face keypoint
detector. Currently at **M3: synthetic data generation**. Training and export
land in M4.

## Synthetic data generator (`gen/`)

Renders a 3x3 cube — stickered (70%) or stickerless (30%) — with a real random
scramble, random camera pose, random warm/cool lighting with occasional glare,
and random backgrounds. Procedural grids and tiles are over-represented in the
backgrounds on purpose: they are the hard negatives (bathroom tiles, keyboards)
from MILESTONES M3.

> **DECISION:** Three.js in headless Chrome (puppeteer), not Blender and not
> the `gl` native module. It matches the web app's rendering stack exactly,
> installs cleanly on Windows, and is fast enough (~20k images overnight at
> worst). Revisit Blender only if realism proves to be the bottleneck at M5.

```
cd gen
npm install
npm run preview   # 60 images into ../data/preview — eyeball these first
npm run viz       # draw labels back onto preview images -> ../data/preview/viz
npm run data      # the full 20k set into ../data (resumes if interrupted)
```

(`make data` / `make preview` / `make viz` do the same where make exists.)

Optional: drop real photos (e.g. a COCO subset) into `model/backgrounds/`;
40% of samples will then use them as backgrounds instead of procedural ones.

### Output format

```
data/
  images/img_000001.png     640x480
  labels/img_000001.json
```

Each label:

```json
{
  "image": "images/img_000001.png",
  "width": 640, "height": 480,
  "style": "stickered",
  "faces": {
    "U": { "visible": true, "facing": 0.83, "corners": [[x,y],[x,y],[x,y],[x,y]] },
    "R": { "...": "all six faces always present" }
  },
  "meta": { "seed": 1000004, "scrambleMoves": 22, "fov": 44.2, "bgKind": "procedural", "lightKelvins": [3100] }
}
```

- `corners` are float pixel coordinates in order **[top-left, top-right,
  bottom-right, bottom-left] of that face in its cubejs sticker-layout
  orientation** (the corners touching stickers 1, 3, 9, 7). They are reported
  for all six faces, including ones facing away — filter on `visible`.
- `visible` = the face normal points toward the camera (`facing > 0.15`) and
  the face center is inside the frame.
- `meta.seed` fully determines the sample (deterministic RNG), so any image can
  be re-rendered.

`visualize.mjs` draws the quads back on the images (visible faces bright and
thick, hidden faces dim and thin; corner 0 gets the biggest dot, corner 1 the
next) — this is the M3 "labels visualize correctly" check.

## Layout

```
gen/      generator (Node + three + puppeteer)   <- M3, done
data/     generated images + labels              <- gitignored
train/    keypoint model + training              <- M4
export/   torch -> onnx -> int8 quantize         <- M4
```
