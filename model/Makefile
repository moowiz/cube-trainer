# On Windows without make, use the npm scripts in gen/ instead:
#   cd gen; npm run preview; npm run viz; npm run data
GEN = gen

deps:
	cd $(GEN) && npm install

data: deps
	cd $(GEN) && node generate.mjs --count 20000 --out ../data

preview: deps
	cd $(GEN) && node generate.mjs --count 60 --out ../data/preview

viz:
	cd $(GEN) && node visualize.mjs --data ../data/preview --count 12

PY = .venv/Scripts/python

overfit:
	cd train && ../$(PY) train.py --data ../data --overfit 50 --epochs 120 --out runs/overfit

train:
	cd train && ../$(PY) train.py --data ../data --epochs 30 --out runs/base

export:
	cd export && ../$(PY) export_onnx.py --ckpt ../train/runs/base/best.pt

.PHONY: deps data preview viz overfit train export
