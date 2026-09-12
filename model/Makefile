# On Windows without make, use the npm scripts in gen/ instead:
#   cd gen; npm run preview; npm run viz; npm run data
GEN = gen
CORNER_BIAS ?= 0

deps:
	cd $(GEN) && npm install

data: deps
	cd $(GEN) && node generate.mjs --count 20000 --out ../data --cornerBias $(CORNER_BIAS)

preview: deps
	cd $(GEN) && node generate.mjs --count 60 --out ../data/preview --cornerBias $(CORNER_BIAS)

viz:
	cd $(GEN) && node visualize.mjs --data ../data/preview --count 12

# M4 (hands/clutter/hard-shadow/corner-bias): preview-v4 renders a small batch
# into ../preview_v4; data-v4 is the full run, not to be launched casually.
preview-v4: deps
	cd $(GEN) && node generate.mjs --count 24 --out ../preview_v4 --cornerBias $(CORNER_BIAS)

data-v4: deps
	cd $(GEN) && node generate.mjs --count 20000 --out ../data_v4 --cornerBias $(CORNER_BIAS)

viz-v4:
	cd $(GEN) && node visualize.mjs --data ../preview_v4 --count 24

PY = .venv/Scripts/python

overfit:
	cd train && ../$(PY) train.py --data ../data --overfit 50 --epochs 120 --out runs/overfit

train:
	cd train && ../$(PY) train.py --data ../data --epochs 30 --out runs/base

export:
	cd export && ../$(PY) export_onnx.py --ckpt ../train/runs/base/best.pt

.PHONY: deps data preview viz preview-v4 data-v4 viz-v4 overfit train export
