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
     `github.com` / `api.github.com`, so `git push` works and nothing that
     runs can read the token;
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
  stephens_photos, recordings, web/clips
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
