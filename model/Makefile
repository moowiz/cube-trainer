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

train:
	@echo "M4: not implemented yet (see MILESTONES.md)"

export:
	@echo "M4: not implemented yet (see MILESTONES.md)"

.PHONY: deps data preview viz train export
