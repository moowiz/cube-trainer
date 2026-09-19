#!/usr/bin/env bash
# Root half of the WSL2 setup (docs/wsl-sandbox.md): packages only.
#   wsl -d Ubuntu-26.04 -u root -- bash /path/to/setup-root.sh
# Idempotent. The user half (setup-user.sh) does everything under $HOME.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

apt-get update
# sandbox deps (bubblewrap = filesystem isolation, socat = network proxy relay,
# ripgrep = Claude Code's grep), toolchain, gh for git-over-https auth
apt-get install -y --no-install-recommends \
  bubblewrap socat ripgrep \
  build-essential git curl ca-certificates unzip jq gh \
  ffmpeg
# headless Chrome (puppeteer, model/gen + web/scripts/check-*.mjs) shared libs
apt-get install -y --no-install-recommends \
  libnss3 libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 libdrm2 libxkbcommon0 \
  libxcomposite1 libxdamage1 libxrandr2 libgbm1 libasound2t64 libpango-1.0-0 \
  libcairo2 libxfixes3 libxext6 libx11-xcb1 fonts-liberation

# Ubuntu 24.04+ AppArmor may stop bubblewrap creating user namespaces
# (sandboxing docs, "Set up Linux and WSL2"). Key absent => nothing to do.
if [ "$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" = "1" ]; then
  cat > /etc/apparmor.d/bwrap <<'AA'
abi <abi/4.0>,
include <tunables/global>
profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
  include if exists <local/bwrap>
}
AA
  systemctl reload apparmor || apparmor_parser -r /etc/apparmor.d/bwrap
  echo "installed AppArmor profile for bwrap"
fi

echo "root setup done"
