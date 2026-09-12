"""Live local dashboard for training runs (M5 tooling).

    python watch.py            # serves http://127.0.0.1:8123
    python watch.py --port N

Parses every runs/*-console.log (and runs/<name>/log.txt) into per-epoch
numbers and serves a single auto-refreshing page charting val_px, losses and
conf accuracy. Local only by default; nothing leaves the machine.
"""
from __future__ import annotations

import argparse
import json
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

RUNS = Path(__file__).parent / "runs"
LINE = re.compile(
    r"epoch\s+(\d+)\s+train_loss\s+([\d.]+)\s+val_loss\s+([\d.]+)\s+"
    r"val_px\s+([\d.]+)\s+val_conf_acc\s+([\d.]+)\s+(\d+)s")


def parse_runs():
    out = {}
    logs = list(RUNS.glob("*-console.log")) + list(RUNS.glob("*/log.txt"))
    for lf in logs:
        name = lf.stem.replace("-console", "") if lf.suffix == ".log" else lf.parent.name
        rows = [
            {"epoch": int(m[1]), "train_loss": float(m[2]), "val_loss": float(m[3]),
             "val_px": float(m[4]), "conf_acc": float(m[5]), "sec": int(m[6])}
            for m in LINE.finditer(lf.read_text(errors="ignore"))
        ]
        if rows and (name not in out or len(rows) > len(out[name])):
            out[name] = rows
    return out


PAGE = """<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Training runs</title>
<style>
:root { color-scheme: dark; }
body { background:#14161a; color:#e8eaf0; font:14px system-ui,sans-serif; margin:0; }
main { max-width:60rem; margin:0 auto; padding:1rem; }
h1 { font-size:1.1rem; } h2 { font-size:0.95rem; margin:1.4rem 0 0.3rem; }
canvas { width:100%; height:220px; background:#1b1e24; border-radius:8px; }
table { border-collapse:collapse; font-variant-numeric:tabular-nums; margin-top:0.4rem; font-size:0.85rem; }
td,th { padding:0.15rem 0.8rem 0.15rem 0; text-align:right; color:#aab2c0; }
th { color:#e8eaf0; }
.now { color:#7ce38b; }
</style>
<main><h1>Training runs <span id="ts" style="color:#68707e;font-weight:normal"></span></h1><div id="root"></div></main>
<script>
async function tick() {
  const runs = await (await fetch('/data')).json();
  document.getElementById('ts').textContent = '· ' + new Date().toLocaleTimeString();
  const root = document.getElementById('root');
  root.textContent = '';
  const names = Object.keys(runs).sort().reverse();
  for (const name of names) {
    const rows = runs[name];
    const h = document.createElement('h2');
    const last = rows[rows.length-1];
    h.textContent = `${name} — epoch ${last.epoch}, val_px ${last.val_px.toFixed(2)}, conf ${last.conf_acc.toFixed(3)} (${last.sec}s/epoch)`;
    const cv = document.createElement('canvas');
    root.append(h, cv);
    const ctx = cv.getContext('2d');
    const W = cv.width = cv.clientWidth * devicePixelRatio, H = cv.height = 220 * devicePixelRatio;
    const px = rows.map(r => r.val_px), n = rows.length;
    const lo = Math.min(...px), hi = Math.max(...px, lo + 0.1);
    const X = i => 40*devicePixelRatio + (W - 60*devicePixelRatio) * (n<2 ? 0 : i/(n-1));
    const Y = v => H - 24*devicePixelRatio - (H - 44*devicePixelRatio) * (v - lo) / (hi - lo);
    ctx.strokeStyle = '#333a45'; ctx.fillStyle = '#8891a0';
    ctx.font = `${11*devicePixelRatio}px system-ui`;
    for (const v of [lo, (lo+hi)/2, hi]) {
      ctx.beginPath(); ctx.moveTo(X(0), Y(v)); ctx.lineTo(W-18*devicePixelRatio, Y(v)); ctx.stroke();
      ctx.fillText(v.toFixed(2), 4*devicePixelRatio, Y(v)+4*devicePixelRatio);
    }
    ctx.strokeStyle = '#7aa2ff'; ctx.lineWidth = 2*devicePixelRatio; ctx.beginPath();
    rows.forEach((r,i) => i ? ctx.lineTo(X(i), Y(r.val_px)) : ctx.moveTo(X(i), Y(r.val_px)));
    ctx.stroke();
    ctx.fillStyle = '#7aa2ff';
    ctx.fillText('val_px', W-70*devicePixelRatio, 16*devicePixelRatio);
    const t = document.createElement('table');
    t.innerHTML = '<tr><th>epoch</th><th>train_loss</th><th>val_loss</th><th>val_px</th><th>conf</th></tr>' +
      rows.slice(-5).map(r => `<tr class="${r===last?'now':''}"><td>${r.epoch}</td><td>${r.train_loss.toFixed(4)}</td><td>${r.val_loss.toFixed(4)}</td><td>${r.val_px.toFixed(2)}</td><td>${r.conf_acc.toFixed(3)}</td></tr>`).join('');
    root.append(t);
  }
}
tick(); setInterval(tick, 5000);
</script>"""


class H(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/data":
            body = json.dumps(parse_runs()).encode()
            ctype = "application/json"
        else:
            body = PAGE.encode()
            ctype = "text/html; charset=utf-8"
        self.send_response(200)
        self.send_header("content-type", ctype)
        self.send_header("cache-control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):  # keep the console quiet
        pass


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8123)
    ap.add_argument("--host", default="127.0.0.1",
                    help="use 0.0.0.0 to watch from your phone on the same wifi")
    args = ap.parse_args()
    print(f"serving http://{'localhost' if args.host == '127.0.0.1' else args.host}:{args.port}  (Ctrl+C to stop)")
    ThreadingHTTPServer((args.host, args.port), H).serve_forever()
