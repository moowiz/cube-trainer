"""Replay solve recordings (web/clips/solves/*.webm) through the scan tab in
headless Chrome, one at a time, in solve mode (log kept past the lock, never
trimmed). Each run POSTs its evidence log to the dev server's capture sink,
which writes web/test/fixtures/evidence/replay-<stem>.json; move it next to
the clip afterwards (a solve log is not a colour-solver fixture).
usage: python tools/solve/replay_clips.py [--port 5173] <stem-or-file>...
Needs `npm run dev` running (predev copies the ORT runtime)."""
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time

CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
args = sys.argv[1:]
port = "5173"
if args and args[0] == "--port": port, args = args[1], args[2:]
BASE = f"https://localhost:{port}/"
clips = args
for clip in clips:
    stem = re.sub(r"\.webm$", "", os.path.basename(clip))
    out = f"replay-{stem}.json"
    url = f"{BASE}?tab=scan&clip=/clips/solves/{stem}.webm&autostart=1&autocapture=1&solve=1&post={out}"
    prof = tempfile.mkdtemp(prefix="chrome-replay-")
    cmd = [CHROME, "--headless=new", f"--user-data-dir={prof}", "--ignore-certificate-errors",
           "--autoplay-policy=no-user-gesture-required", "--enable-logging=stderr", "--v=0",
           "--window-size=800,1200", url]
    print(f"== {stem} -> {out}", flush=True)
    t0 = time.time()
    p = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, errors="replace")
    done = False
    try:
        for line in p.stderr:
            if "CLIP ENDED" in line or "CAPTURED" in line or "clip failed" in line:
                m = re.search(r'"(CLIP ENDED.*?|CAPTURED.*?|clip failed.*?)"', line)
                print(f"  [{time.time()-t0:6.1f}s] {m.group(1) if m else line.strip()[:200]}", flush=True)
            if "CAPTURED" in line or "clip failed" in line:
                done = True
                time.sleep(3)  # let the POST finish
                break
            if time.time() - t0 > 200:
                print("  timeout", flush=True)
                break
    finally:
        p.kill()
        p.wait()
        shutil.rmtree(prof, ignore_errors=True)
    print(f"  {'ok' if done else 'FAILED'} in {time.time()-t0:.0f}s", flush=True)
