#!/usr/bin/env bash
# Push from inside the Claude Code sandbox (docs/wsl-sandbox.md).
#
# The sandbox tunnels SSH through its proxy (its own GIT_SSH_COMMAND carries
# the ProxyCommand) but denies ~/.ssh, so this uses a deploy key that is
# scoped to this one repository and lives outside ~/.ssh:
#
#   ~/.ssh-cube/cube-trainer       ed25519 private key, added to the repo on
#                                  GitHub as a deploy key WITH write access
#   ~/.ssh-cube/known_hosts        GitHub's host keys (ssh-keyscan github.com)
#
# The key can push to this repo and nothing else; the account's own keys stay
# denied. Allowed for auto mode by "Bash(tools/wsl/push.sh:*)" in
# ~/.claude/settings.json.
#
#   tools/wsl/push.sh [branch]      default: main
set -euo pipefail
branch=${1:-main}
keydir=$HOME/.ssh-cube
[ -r "$keydir/cube-trainer" ] || { echo "no deploy key at $keydir/cube-trainer (see the header of this script)" >&2; exit 2; }
[ -r "$keydir/known_hosts" ] || { echo "no $keydir/known_hosts: run  ssh-keyscan github.com > $keydir/known_hosts" >&2; exit 2; }
export GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh} -i $keydir/cube-trainer -o IdentitiesOnly=yes -o UserKnownHostsFile=$keydir/known_hosts"
exec git push git@github.com:moowiz/cube-trainer.git "$branch"
