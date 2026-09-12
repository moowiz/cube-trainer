# Cloud runbook — generate data + train a base model on a rented GPU box

Why: local from-scratch runs are dataloader-bound and capped at 8 workers /
~56% CPU to keep the machine usable (~7.5 h at 125k samples). A rented box
has no such ceiling: generate the synthetic set *on the box* (parallel
headless-Chrome instances) and train with 24+ workers. Whole cycle ≈ 4–6
box-hours ≈ $3–10 on a 4090.

**Privacy rule (non-negotiable): personal photos never leave this machine.**
`model/data_real/`, `model/data_real_val/`, `stephens_photos/` stay local.
The cloud run is synthetic-only: pass `--real-val ''` (disables the
real-photo eval; those numbers are produced locally after pulling the
checkpoint). The generator's photo backgrounds are fetched from free public
sources by `gen/fetch-backgrounds.mjs`, so fetching them on the box is fine.

## 1. What to rent

- GPU: RTX 4090 / 3090 / A5000 — all plenty (the model is ~6M params; VRAM
  needs are a few GB). Do NOT pay A100/H100 prices.
- **vCPU is the real spec: >= 24 (32 preferred).** Rendering and the
  dataloader are CPU-bound; the GPU mostly waits.
- RAM 32+ GB, disk ~60 GB.
- Image/template: Ubuntu 22.04 with PyTorch + CUDA 12.x preinstalled
  (RunPod's "PyTorch" template or equivalent). Interruptible/spot is fine —
  train.py `--resume` makes interruptions cheap.

## 2. Setup (once per box, ~10 min)

```bash
git clone https://github.com/moowiz/cube-trainer.git cube_stuff
cd cube_stuff/model

# Python deps (torch usually preinstalled on the template; if not:
# pip install torch --index-url https://download.pytorch.org/whl/cu121)
pip install numpy pillow

# Node 20 + generator deps (puppeteer downloads its own Chrome)
curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y nodejs
cd gen && npm install
# shared libs headless Chrome needs on a bare Ubuntu image:
apt-get install -y libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
  libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 \
  libpango-1.0-0 libcairo2 libasound2

node fetch-backgrounds.mjs   # free photo backgrounds the scenes composite
node fetch-hdris.mjs         # the 16 CC0 HDRI light probes - NOT optional
```

`model/backgrounds/` is gitignored, so a fresh checkout has neither photo
backgrounds nor HDRIs. Missing HDRIs are not an error: generate.mjs prints
`no HDRIs ... falling back to analytic lights only` on stderr and renders the
entire set under flat analytic lighting - a quietly different distribution
from the one signed off on the previews, and the README credits the HDRI pass
with a real chunk of the sim-to-real gain. `fetch-hdris.mjs` exits non-zero if
it cannot get all 16, so run it before generating and read its last line.

## 3. Generate the synthetic set

data_v4 recipe (frozen 2026-09-12, generator at commit ae1976f or later):
`--cornerBias 0.4`; everything else is a built-in generator feature at its
own rate — hands with palm/forearm/fat fingers (~50%), clutter (~20%), hard
cast shadows (~25%), center logo on the white face (~80%, wide glyph
family), GAN-style tile profile (35% of stickered), one misaligned layer
(22%), and an auto-exposure floor that re-renders any frame whose cube
meters under 0.15 mean luminance (see scene.mjs DECISION comments). Target
~54k images ≈ 10 GB (measured 190 KB/image). The generator is reviewed and
signed off on previews (2026-09-12): do not change it between parts.

Parallelize by running N instances into separate roots (the generator
numbers images per-root; don't point two instances at one root), and give
**each part a distinct `--seed`** — the per-image seed derives from it, so
two parts with the same seed render identical images. Note the local
machine already holds a 3200-image `model/data_v4` rendered with seed 1;
the cloud set REPLACES it (same seed 1 in part 1 reproduces those same
scenes first, which is fine — never merge the local root into the cloud
parts or you get duplicates).

```bash
cd cube_stuff/model/gen
for i in 1 2 3 4 5 6; do
  node generate.mjs --count 9000 --out ../data_v4_part$i --seed $i \
    --cornerBias 0.4 > gen$i.log 2>&1 &
done
wait   # one instance renders 7-9 img/s locally; 6 in parallel on a 32-core box ≈ 20-30 min for 54k
```

Merge parts into one root (labels reference images by relative path, so a
renumbering copy is required — adjust the paths, then):

```bash
cd cube_stuff/model
python - <<'EOF'
import json, shutil
from pathlib import Path
dst = Path("data_v4"); (dst/"images").mkdir(parents=True); (dst/"labels").mkdir()
n = 0
for part in sorted(Path(".").glob("data_v4_part*")):
    for lf in sorted((part/"labels").glob("*.json")):
        n += 1
        lab = json.loads(lf.read_text())
        src_img = part / lab["image"]
        stem = f"img_{n:06d}"
        new_img = f"images/{stem}{src_img.suffix}"
        shutil.copy(src_img, dst / new_img)
        lab["image"] = new_img
        (dst/"labels"/f"{stem}.json").write_text(json.dumps(lab))
print("merged", n)
EOF
```

Sanity-check before burning GPU time: eyeball ~30 images (a contact sheet
pulled back with scp is enough), `python train/check_labels.py --data
data_v4` (geometry checks), and audit the exposure floor from the label
meta — `exposureBoost` > 1 should be ~5% of samples and `cubeLum` < 0.15
essentially zero (locally: 173 boosted / 1 below floor out of 3200). If a
non-trivial fraction sits below the floor, the box's Chrome is rendering
differently (missing HDRIs or GPU-less swiftshader path) — fix before
training.

## 4. Train

```bash
cd cube_stuff/model/train
python train.py --head center --data ../data_v4 --epochs 150 --batch 64 --workers 24 \
  --real-val '' --out runs/v4base > runs/v4base-console.log 2>&1 &
tail -f runs/v4base-console.log
```

- `--real-val ''` is the privacy switch (see top). best.pt selection falls
  back to synthetic val_px, which is correct for a from-scratch base.
- `--head center` is the anonymous-quad head. It is already the DEFAULT, so
  the flag is belt-and-braces — spell it out anyway so a copy-pasted command
  can never silently train the superseded head. Three things follow from it:
  do NOT run a legacy twin for comparison (`runs/long4` already is that
  baseline; the table is in `model/README.md`); `--init` from any existing
  checkpoint is impossible and unwanted, since the two heads share no
  weights, so this run is from scratch; and `val_conf_acc` in the log now
  means detection F1, not visibility accuracy, so never read it against
  long4's column.
- Dashboard, optional: `python ../train/watch.py` on the box, then from the
  local machine `ssh -L 8123:localhost:8123 <box>` and open
  http://localhost:8123.
- Interrupted spot instance? Re-rent, re-clone, re-upload nothing — data is
  still on the volume if you kept it; `python train.py ... --resume
  runs/v4base` with IDENTICAL args continues.

## 5. Pull results, tear down

```bash
# from the LOCAL machine:
scp <box>:cube_stuff/model/train/runs/v4base/best.pt  model/train/runs/v4base-cloud/
scp <box>:cube_stuff/model/train/runs/v4base/last.pt  model/train/runs/v4base-cloud/   # optional, enables local --resume
scp <box>:cube_stuff/model/train/runs/v4base/log.txt  model/train/runs/v4base-cloud/
```

Optionally tar+pull `data_v4` too (or regenerate locally later; the
generator is the asset, the images are a cache). **Then terminate the
instance** — storage keeps billing on most providers.

Local follow-up (the part that needs the personal photos, ~15 min):

```bash
cd model/train
python train.py --head center --data ../data_v4,../data_real*150 --init runs/v4base-cloud/best.pt \
  --epochs 15 --lr 5e-5 --select real --out runs/v4ft
cd ../export && python export_onnx.py --ckpt ../train/runs/v4ft/best.pt --crop-trained
```

(`--crop-trained` only if the base was trained with the crop-heavy augment
mix — check augment.py's zoom_crop probability is 0.7 on the box's checkout.)
