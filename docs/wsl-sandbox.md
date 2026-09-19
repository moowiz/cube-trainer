# Claude Code in WSL2, sandboxed

Set up 2026-09-18. Claude Code runs inside an Ubuntu 26.04 WSL2 distro, with
its OS-enforced sandbox (bubblewrap + a network proxy) on for every shell
command. Native Windows has no such sandbox; that is the whole reason for
the move.

## What the boundary is

Three layers, from the outside in:

1. **The VM.** WSL2 is a Hyper-V VM. `/etc/wsl.conf` turns off the automount
   of Windows drives and interop, so from Linux there is no `C:` and no way
   to launch a Windows executable. The one Windows path Linux can see is
   `D:\cube-data`, mounted by `/etc/fstab` at `/mnt/cube-data` (9p/drvfs).
2. **The sandbox** (`~/.claude/settings.json` in WSL, user scope, from
   `tools/wsl/claude-settings.json`). Every Bash command runs with:
   - writes allowed only in the repo (the working directory), `/mnt/cube-data`,
     the session temp dir and the package caches (`~/.npm`, `~/.cache`,
     `~/.local/share/uv`); everything else on the Linux side is read-only;
   - reads of `~/.ssh`, `~/.gnupg`, `~/.claude.json`,
     `~/.claude/.credentials.json`, `~/.git-credentials`, `~/.netrc` denied;
   - the gh token in `~/.config/gh/hosts.yml` masked: commands see a
     placeholder, the proxy substitutes the real token only on requests to
     `github.com` / `api.github.com`, so `gh` works and nothing that runs
     can read the token. `git push` over HTTPS does NOT: git sends the
     placeholder as basic auth, which the proxy does not rewrite, and
     GitHub answers "Invalid username or token" (found 2026-09-18), and
     GitHub's git endpoint takes no other auth form. The remote is SSH
     since that day; the sandbox tunnels SSH through the proxy (its own
     `GIT_SSH_COMMAND`) but `~/.ssh` is denied, so pushes go through
     `tools/wsl/push.sh` with a **deploy key scoped to this one repo**
     (`~/.ssh-cube/cube-trainer`, write access, plus a `known_hosts` from
     `ssh-keyscan`), readable inside but able to reach nothing else. The
     account's own keys stay denied. `Bash(tools/wsl/push.sh:*)` is allowed
     in the settings so auto mode does not treat the push as a bypass.
     `.git/config` and `.git/config.lock` are masked too: `git remote
     set-url` and any other config write fails inside with "could not lock
     config file";
   - network only to the allowlist (GitHub, npm, PyPI, PyTorch, Google
     storage for Chrome/mediapipe downloads); any other host prompts;
   - `allowUnsandboxedCommands: false` — no per-command escape hatch — and
     `failIfUnavailable: true` — if bubblewrap is missing, refuse rather
     than run unsandboxed.
   The policy file is outside the writable set, so nothing a command does
   can widen the policy for the next command. Project settings cannot turn
   filesystem isolation off (Claude Code rule), so a poisoned checkout
   cannot either.
3. **The blast radius that remains**: the repo checkout and `/mnt/cube-data`.
   Untrusted code can read, alter or delete both. The repo is on GitHub. The
   irreplaceable data (`stephens_photos`, `model/data_real*`) has a second
   copy in `D:\cube-backup`, which is NOT mounted into WSL. Refresh it after a
   labelling session (robocopy from `D:\cube-data`).

Not covered: the RunPod MCP tools are not shell commands and do not pass
through the sandbox; they are gated by the permission prompt.

To try something genuinely untrusted, clone it in a scratch directory outside
the repo and run it there: the sandbox makes only the working directory
writable, so a throwaway checkout can only hurt itself.

## Layout

```
~/cube_stuff                 the repo, on the Linux ext4 disk (never under /mnt: 9p is slow)
  model/data_v4, data_v5,    -> /mnt/cube-data/model/...   (symlinks, tools/wsl/setup-user.sh)
  model/data_real*, runs,
  stephens_photos, recordings, web/clips, web/test/bank
/mnt/cube-data               = D:\cube-data  (the external 12 TB G-DRIVE)
D:\cube-backup               second copy of the hand-labelled data; invisible to WSL
```

The 11 GB memory-mapped training caches (`cache_*/`) live inside the data
dirs, i.e. on the drive over 9p. Measure an epoch before a long run; if it is
far off the ~17 s Windows figure, copy the active set to the Linux disk
(`rsync -a /mnt/cube-data/model/data_v5 ~/data/` and pass `--data ~/data/data_v5`).

## Files

- `%USERPROFILE%\.wslconfig` — VM caps (24 GB / 16 CPUs, the machine stays
  usable), `networkingMode=mirrored` so the dev server in WSL is `localhost`
  from Windows Chrome and the PC's LAN address from the phone.
- `/etc/wsl.conf` — systemd, automount off, interop off.
- `/etc/fstab` — the `D:\cube-data` drvfs mount.
- `tools/wsl/setup-root.sh` — packages (bubblewrap, socat, ripgrep, gh,
  ffmpeg, headless-Chrome libs).
- `tools/wsl/setup-user.sh` — nvm/node 22, uv/python 3.13, clone, symlinks,
  `npm ci`, the venv with CUDA torch, and the sandbox policy merge into
  `~/.claude/settings.json`. Re-runnable.

## Daily use

```
wsl                          # a WSL shell (Windows Terminal has a profile)
cd ~/cube_stuff && claude    # /sandbox shows the policy; the Dependencies tab must be absent
cd web && npm run dev        # phone: https://<pc-lan-ip>:5173 as before
```

`model/Makefile` picks `.venv/bin/python` on Linux; the README's
`.venv\Scripts\python` lines read `.venv/bin/python` here.

Applying a `.wslconfig` / `wsl.conf` change: `wsl --shutdown` from PowerShell,
then start a shell again.

### Firewall for the phone (mirrored networking)

In mirrored mode WSL binds on the host's interfaces and the Hyper-V firewall
applies. If the phone cannot reach the dev server, allow the port once
(PowerShell as admin):

```
New-NetFirewallHyperVRule -Name vite-wsl -DisplayName "vite dev server (WSL)" -Direction Inbound -VMCreatorId '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}' -Protocol TCP -LocalPorts 5173,5198
```

## What still runs on Windows

Nothing needs to. The browser owns the camera (Windows Chrome or the phone)
and the recording rig POSTs to the dev server, so the webcam never has to
exist on the Linux side. The headless checks (`web/scripts/check-*.mjs`) use
Chrome's fake camera device and run on Linux. The one lost convenience is a
headless Chrome opened on the *real* LifeCam for a diagnosis; do that from a
browser you open yourself.

## Chrome and torch inside the sandbox (2026-09-19)

Two walls the sandbox's seccomp filter puts up, both hit while building
the twist head's data; neither has a flag-level fix:

- **Full Chrome cannot start** (`~/.config` is read-only so crashpad has no
  database, and the process singleton needs an `AF_UNIX` socket, which is
  denied). `chrome-headless-shell` has neither and does have WebGL over
  SwiftShader, workers and the fake camera, so every `puppeteer.launch`
  says `headless: 'shell'` - the generator (`model/gen/generate.mjs`, 1.5
  renders/s at 480x640) included. It has no WebGPU adapter; that leg of
  the detector check is a skip here, not a failure.
- **DataLoader workers cannot start**: torch shares tensors between
  processes over Unix sockets (`resource_sharer`), so any
  `num_workers > 0` dies with `PermissionError: Operation not permitted`.
  Pass `--workers 0` to `train.py` for a smoke run in the sandbox (36
  images overfit at ~110 img/s on the CPU; there is no GPU here - real
  runs stay on Windows). The label caches build single-process below 200
  images and are fine.
