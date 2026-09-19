#!/usr/bin/env bash
# User half of the WSL2 setup (docs/wsl-sandbox.md). Run as yourself, once,
# after setup-root.sh. Idempotent: re-run after pulling to refresh deps.
#
#   bash tools/wsl/setup-user.sh
#
# Puts the repo at ~/cube_stuff (the Linux filesystem: /mnt/* is 9p and
# slow), points the gitignored data dirs at /mnt/cube-data (= D:\cube-data),
# installs node 22 / python 3.13 toolchains, and writes the Claude Code
# sandbox policy into ~/.claude/settings.json (user scope: a file the
# sandbox itself can never write).
set -euo pipefail

REPO="${CUBE_REPO:-$HOME/cube_stuff}"
DATA=/mnt/cube-data
NODE_VERSION=22.17.1   # matches web/.nvmrc and the Windows install
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

[ -d "$DATA" ] && mountpoint -q "$DATA" || { echo "$DATA is not mounted (see /etc/fstab)"; exit 1; }

# --- toolchains -------------------------------------------------------------
if [ ! -s "$HOME/.nvm/nvm.sh" ]; then
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
fi
# shellcheck disable=SC1091
. "$HOME/.nvm/nvm.sh"
nvm install "$NODE_VERSION" >/dev/null
nvm alias default "$NODE_VERSION" >/dev/null
echo "node $(node --version)"

if ! command -v uv >/dev/null; then
  curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="$HOME/.local/bin:$PATH"
fi
echo "uv $(uv --version)"

# --- repo -------------------------------------------------------------------
if [ ! -d "$REPO/.git" ]; then
  git clone https://github.com/moowiz/cube-trainer.git "$REPO"
fi
cd "$REPO"

# gitignored data lives on the external drive; symlinks keep every path in
# Makefiles/scripts unchanged. Each entry is repo-relative.
for rel in \
  model/data_v4 model/data_v5 model/data_real model/data_real_val \
  model/backgrounds model/negatives model/roboflow model/preview_v5 \
  model/runs model/train/runs model/export/out model/gen/logs \
  stephens_photos recordings web/clips web/test/bank; do
  mkdir -p "$DATA/$rel"
  if [ -e "$rel" ] && [ ! -L "$rel" ]; then
    if [ -z "$(ls -A "$rel")" ]; then rmdir "$rel"; else echo "!! $rel exists and is not empty; not replacing with a symlink"; continue; fi
  fi
  mkdir -p "$(dirname "$rel")"
  ln -sfn "$DATA/$rel" "$rel"
done
echo "data symlinks -> $DATA"

# --- web --------------------------------------------------------------------
(cd web && npm ci --no-audit --no-fund)
(cd model/gen && npm ci --no-audit --no-fund)   # puppeteer + three (renders)

# --- model ------------------------------------------------------------------
(cd model \
  && uv venv --python 3.13 --allow-existing .venv \
  && uv pip install --python .venv/bin/python torch torchvision \
  && uv pip install --python .venv/bin/python -r requirements.txt)
model/.venv/bin/python -c "import torch; print('torch', torch.__version__, 'cuda', torch.cuda.is_available(), torch.cuda.get_device_name(0) if torch.cuda.is_available() else '')"

# --- Claude Code sandbox policy (user scope) --------------------------------
mkdir -p "$HOME/.claude"
python3 - "$HERE/claude-settings.json" "$HOME/.claude/settings.json" <<'PY'
import json, sys, os
policy = json.load(open(sys.argv[1]))
path = sys.argv[2]
cur = json.load(open(path)) if os.path.exists(path) else {}
cur.update(policy)          # top-level keys from the template win (sandbox, permissions, model...)
json.dump(cur, open(path, "w"), indent=2)
print("wrote", path)
PY

echo
echo "user setup done. Next: 'gh auth login' (once), then 'cd $REPO && claude' and run /sandbox."
