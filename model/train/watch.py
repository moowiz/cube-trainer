"""Live local dashboard for training runs (M5 tooling).

    python watch.py            # serves http://127.0.0.1:8123
    python watch.py --port N

Parses every runs/*-console.log (and runs/<name>/log.txt) into per-epoch
numbers and serves a single page with small-multiple charts per run
(val_px, val_loss, train_loss, conf accuracy), newest run first,
refreshing about once a minute. Local only by default.
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
        if rows and (name not in out or len(rows) > len(out[name]["rows"])):
            out[name] = {"mtime": lf.stat().st_mtime, "rows": rows}
    return out


PAGE = """<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Training runs</title>
<style>
:root { color-scheme: dark; }
body { background:#14161a; color:#e8eaf0; font:14px system-ui,sans-serif; margin:0; }
main { max-width:64rem; margin:0 auto; padding:1rem; }
h1 { font-size:1.1rem; } h2 { font-size:0.95rem; margin:1.6rem 0 0.4rem; }
h2 small { color:#68707e; font-weight:normal; }
.grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:0.6rem; }
canvas { width:100%; height:170px; background:#1b1e24; border-radius:8px; }
table { border-collapse:collapse; font-variant-numeric:tabular-nums; margin-top:0.5rem; font-size:0.85rem; }
td,th { padding:0.15rem 0.8rem 0.15rem 0; text-align:right; color:#aab2c0; }
th { color:#e8eaf0; }
.now { color:#7ce38b; }
</style>
<main><h1>Training runs <span id="ts" style="color:#68707e;font-weight:normal"></span></h1><div id="root"></div></main>
<script>
const METRICS = [
  { key:'val_px',     label:'val_px (lower=better)', color:'#7aa2ff', fmt:v=>v.toFixed(2) },
  { key:'val_loss',   label:'val_loss',              color:'#e0a458', fmt:v=>v.toFixed(4) },
  { key:'train_loss', label:'train_loss',            color:'#c792ea', fmt:v=>v.toFixed(4) },
  { key:'conf_acc',   label:'val conf accuracy',     color:'#7ce38b', fmt:v=>v.toFixed(3) },
];

function drawChart(cv, rows, m) {
  const ctx = cv.getContext('2d'), dpr = devicePixelRatio;
  const W = cv.width = cv.clientWidth * dpr, H = cv.height = 170 * dpr;
  const vals = rows.map(r => r[m.key]), n = rows.length;
  const lo = Math.min(...vals), hi = Math.max(...vals, lo + 1e-6);
  const padL = 52*dpr, padR = 14*dpr, padT = 24*dpr, padB = 20*dpr;
  const X = i => padL + (W - padL - padR) * (n < 2 ? 0 : i / (n - 1));
  const Y = v => H - padB - (H - padT - padB) * (v - lo) / (hi - lo);
  ctx.font = `${10.5*dpr}px system-ui`;
  ctx.strokeStyle = '#2c313a'; ctx.fillStyle = '#8891a0';
  for (const v of [lo, (lo + hi) / 2, hi]) {
    ctx.beginPath(); ctx.moveTo(padL, Y(v)); ctx.lineTo(W - padR, Y(v)); ctx.stroke();
    ctx.fillText(m.fmt(v), 4*dpr, Y(v) + 4*dpr);
  }
  // epoch ticks: first and last
  ctx.fillText('ep ' + rows[0].epoch, padL, H - 6*dpr);
  const lastLbl = 'ep ' + rows[n-1].epoch;
  ctx.fillText(lastLbl, W - padR - ctx.measureText(lastLbl).width, H - 6*dpr);
  ctx.strokeStyle = m.color; ctx.lineWidth = 1.8*dpr; ctx.beginPath();
  rows.forEach((r, i) => i ? ctx.lineTo(X(i), Y(r[m.key])) : ctx.moveTo(X(i), Y(r[m.key])));
  ctx.stroke();
  ctx.fillStyle = m.color;
  ctx.fillText(m.label + ' · ' + m.fmt(vals[n-1]), padL, 14*dpr);
}

async function tick() {
  const runs = await (await fetch('/data')).json();
  document.getElementById('ts').textContent = '· updated ' + new Date().toLocaleTimeString();
  const root = document.getElementById('root');
  root.textContent = '';
  const names = Object.keys(runs).sort((a, b) => runs[b].mtime - runs[a].mtime);
  for (const name of names) {
    const { mtime, rows } = runs[name];
    const last = rows[rows.length - 1];
    const h = document.createElement('h2');
    const when = new Date(mtime * 1000).toLocaleString();
    h.innerHTML = `${name} — epoch ${last.epoch} (${last.sec}s/epoch) <small>last log write ${when}</small>`;
    const grid = document.createElement('div');
    grid.className = 'grid';
    root.append(h, grid);
    for (const m of METRICS) {
      const cv = document.createElement('canvas');
      grid.append(cv);
      drawChart(cv, rows, m);
    }
    const t = document.createElement('table');
    t.innerHTML = '<tr><th>epoch</th><th>train_loss</th><th>val_loss</th><th>val_px</th><th>conf</th><th>s</th></tr>' +
      rows.slice(-5).map(r => `<tr class="${r === last ? 'now' : ''}"><td>${r.epoch}</td><td>${r.train_loss.toFixed(4)}</td><td>${r.val_loss.toFixed(4)}</td><td>${r.val_px.toFixed(2)}</td><td>${r.conf_acc.toFixed(3)}</td><td>${r.sec}</td></tr>`).join('');
    root.append(t);
  }
}
tick(); setInterval(tick, 60000);
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
