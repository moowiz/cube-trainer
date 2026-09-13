"""Live local dashboard for training runs (M5 tooling).

    python watch.py            # serves http://127.0.0.1:8123
    python watch.py --port N

Parses every runs/*-console.log (and runs/<name>/log.txt) into per-epoch
numbers and serves a single page with charts per run (val_px, train+val
loss combined, conf accuracy), 5 newest runs, ~1 min auto-refresh, synced
hover readout across a run's charts. The page refreshes itself when the
newest active run's next epoch is due (5 s - 2 min, 1 min when nothing is
running) instead of on a fixed clock. Local only by default.

Total epochs (for the progress bar and ETA) come from runs/<name>/meta.json,
which train.py writes before epoch 1; runs without one still chart, just
without a projection.
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
    for name, rec in out.items():
        meta = RUNS / name / "meta.json"
        if meta.exists():
            try:
                rec["epochs"] = int(json.loads(meta.read_text())["epochs"])
            except (ValueError, KeyError, OSError):
                pass  # a half-written or hand-made meta just costs the ETA
    return out


PAGE = """<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cube detector training</title>
<style>
:root { color-scheme: dark; }
body { background:#14161a; color:#e8eaf0; font:14px system-ui,sans-serif; margin:0; }
main { max-width:70rem; margin:0 auto; padding:1rem; }
h1 { font-size:1.4rem; margin:0.2rem 0 0.15rem; }
.sub { color:#68707e; font-size:0.8rem; margin:0 0 1rem; }
#dot { display:inline-block; width:7px; height:7px; border-radius:50%; background:#7ce38b;
       margin-right:0.3rem; animation:pulse 2s infinite; }
@keyframes pulse { 50% { opacity:0.25; } }
h2 { font-size:0.95rem; margin:1.6rem 0 0.4rem; }
h2 small { color:#68707e; font-weight:normal; }
.cell { margin:0.45rem 0 0.9rem; }
.ctitle { font-size:0.8rem; font-weight:600; color:#aab2c0; margin:0 0 0.3rem;
          text-transform:uppercase; letter-spacing:0.04em; }
canvas { width:100%; height:170px; background:#1b1e24; border-radius:8px; cursor:crosshair; }
.cap { font-size:0.78rem; color:#8891a0; margin:0.35rem 0 0; line-height:1.45; }
@media (min-width:700px) {
  .cell { display:grid; grid-template-columns:1fr 17rem; gap:1rem; align-items:center; }
  .cap { margin:0; }
}
table { border-collapse:collapse; font-variant-numeric:tabular-nums; margin-top:0.6rem; font-size:0.85rem; }
td,th { padding:0.15rem 0.8rem 0.15rem 0; text-align:right; color:#aab2c0; }
th { color:#e8eaf0; }
.now { color:#7ce38b; }
.eta { color:#e0a458; }
.stale { color:#e06c75; }
.bar { height:4px; background:#242830; border-radius:3px; overflow:hidden; margin:0.15rem 0 0; }
.bar i { display:block; height:100%; background:#7aa2ff; transition:width 0.4s; }
</style>
<main>
<h1>Cube detector &mdash; training dashboard</h1>
<p class="sub"><span id="dot"></span>refreshes when the next epoch is due &middot; <span id="ts">loading&hellip;</span> &middot; 5 most recent runs</p>
<div id="root"></div></main>
<script>
const METRICS = [
  { title:'Corner error (val_px)', fmt:v=>v.toFixed(2),
    series:[{ key:'val_px', label:'val_px', color:'#7aa2ff' }],
    desc:'Mean corner error (px at the model input) on held-out frames — the number that matters. Healthy: falls steeply early, then flattens to a plateau. Rising after a low = overfitting; never falling = data/LR problem.' },
  { title:'Loss — train vs val', fmt:v=>v.toFixed(4),
    series:[{ key:'train_loss', label:'train', color:'#c792ea' },
            { key:'val_loss', label:'val', color:'#e0a458' }],
    desc:'Combined corner+visibility loss. Train (purple) is measured on augmented batches so it sits above what you might expect; val (orange) is held-out frames. Healthy: both decline together. Val flattening or rising while train keeps falling = memorizing, not learning; a sustained rise in train = learning rate too hot.' },
  { title:'Face visibility accuracy', fmt:v=>v.toFixed(3),
    series:[{ key:'conf_acc', label:'val conf acc', color:'#7ce38b' }],
    desc:'How often the model correctly says which faces are visible. Healthy: climbs to ~0.97+ and sticks. Drops here usually mean something structural broke, not noise.' },
];
const PADL = 52, PADR = 14, PADT = 24, PADB = 20;
const ETA_WINDOW = 20;   // epochs of history the rate estimate is built from

function fmtDur(s) {
  s = Math.round(s);
  if (s < 60) return s + 's';
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m} min`;
}
function fmtClock(d) {
  const t = d.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
  return d.toDateString() === new Date().toDateString()
    ? t : d.toLocaleDateString([], { weekday:'short' }) + ' ' + t;
}

// Projection from the recent epoch times. Two independent things make the
// finish time uncertain and both are folded in: the epoch-to-epoch scatter
// (k epochs of it add in quadrature, so it grows as sqrt(k)) and the fact
// that the rate itself is only measured from a short window (that error is
// systematic - it scales with k). Epoch 1 is excluded throughout: it carries
// the torch.compile warm-up and is not a sample of the steady state.
function project(rows, total, mtime) {
  const last = rows[rows.length - 1];
  // Epoch seconds are integers, so a sub-second epoch (overfit runs) logs as
  // "0s": read that as half a second rather than dropping the row, or a fast
  // run gets neither an ETA nor a refresh cadence.
  const w = rows.filter(r => r.epoch > 1).slice(-ETA_WINDOW).map(r => Math.max(r.sec, 0.5));
  const p = { total: total || null, done: !!(total && last.epoch >= total) };
  if (total) p.frac = Math.min(1, last.epoch / total);
  if (w.length) {
    const sorted = [...w].sort((a, b) => a - b);
    p.n = w.length;
    p.med = sorted.length % 2
      ? sorted[(sorted.length - 1) / 2]
      : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
    const mean = w.reduce((a, b) => a + b, 0) / w.length;
    p.sd = w.length > 1
      ? Math.sqrt(w.reduce((a, b) => a + (b - mean) ** 2, 0) / (w.length - 1)) : 0;
  }
  // No epoch line for several epochs' worth of wall clock = it is not running.
  // Runs too young to have a rate fall back to a flat 3 min before saying so.
  const age = Date.now() / 1000 - mtime;
  p.stale = !p.done && age > 3 * (p.med || 60) + 60 ? age : 0;
  if (total && !p.done && p.med) {
    const k = total - last.epoch;
    p.left = k * p.med;
    // Epoch seconds are logged rounded to 1 s, so a run whose epochs all read
    // "16s" shows sd 0 while really varying up to half a second. Add the
    // rounding's own variance (1/12 s^2) so the band never collapses to zero.
    const sdq = Math.sqrt(p.sd * p.sd + 1 / 12);
    p.band = 1.96 * Math.sqrt(k * sdq * sdq + (k * sdq / Math.sqrt(w.length)) ** 2);
    p.at = new Date(Date.now() + p.left * 1000);
  }
  return p;
}

// Refresh roughly when the next epoch is due, rather than on a fixed clock: a
// tick landing mid-epoch redraws the same points, and a 16 s/epoch run should
// not wait a minute to plot one. Driven by the active run whose log was
// written most recently. Clamped at both ends - an overfit run at 0.4 s/epoch
// must not turn this into a poll loop, and a box with nothing running should
// go quiet.
const MIN_REFRESH = 5000, MAX_REFRESH = 120000, IDLE_REFRESH = 60000, SLACK = 3;

function nextDelay(active) {
  if (!active.length) return IDLE_REFRESH;
  const r = active.reduce((a, b) => (b.mtime > a.mtime ? b : a));
  const due = (r.mtime + r.med + SLACK) * 1000 - Date.now();
  // Already overdue (we were asleep through an epoch): come back in one epoch.
  return Math.min(MAX_REFRESH, Math.max(MIN_REFRESH, due > 0 ? due : r.med * 1000));
}

function drawChart(cv, rows, m, hoverI) {
  const ctx = cv.getContext('2d'), dpr = devicePixelRatio;
  const W = cv.width = cv.clientWidth * dpr, H = cv.height = 170 * dpr;
  const padL = PADL*dpr, padR = PADR*dpr, padT = PADT*dpr, padB = PADB*dpr;
  const n = rows.length;
  // one shared y-scale across every series in this chart
  let lo = Infinity, hi = -Infinity;
  for (const s of m.series) for (const r of rows) {
    const v = r[s.key];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  hi = Math.max(hi, lo + 1e-6);
  const X = i => padL + (W - padL - padR) * (n < 2 ? 0 : i / (n - 1));
  const Y = v => H - padB - (H - padT - padB) * (v - lo) / (hi - lo);
  ctx.font = `${10.5*dpr}px system-ui`;
  ctx.strokeStyle = '#2c313a'; ctx.fillStyle = '#8891a0';
  for (const v of [lo, (lo + hi) / 2, hi]) {
    ctx.beginPath(); ctx.moveTo(padL, Y(v)); ctx.lineTo(W - padR, Y(v)); ctx.stroke();
    ctx.fillText(m.fmt(v), 4*dpr, Y(v) + 4*dpr);
  }
  ctx.fillText('ep ' + rows[0].epoch, padL, H - 6*dpr);
  const lastLbl = 'ep ' + rows[n-1].epoch;
  ctx.fillText(lastLbl, W - padR - ctx.measureText(lastLbl).width, H - 6*dpr);
  for (const s of m.series) {
    ctx.strokeStyle = s.color; ctx.lineWidth = 1.8*dpr; ctx.beginPath();
    rows.forEach((r, i) => i ? ctx.lineTo(X(i), Y(r[s.key])) : ctx.moveTo(X(i), Y(r[s.key])));
    ctx.stroke();
  }
  if (hoverI != null) {
    const i = hoverI;
    ctx.strokeStyle = '#525a68'; ctx.lineWidth = dpr;
    ctx.beginPath(); ctx.moveTo(X(i), padT); ctx.lineTo(X(i), H - padB); ctx.stroke();
    for (const s of m.series) {
      ctx.beginPath(); ctx.arc(X(i), Y(rows[i][s.key]), 3.2*dpr, 0, 7);
      ctx.fillStyle = s.color; ctx.fill();
    }
    const parts = m.series.map(s => (m.series.length > 1 ? s.label + ' ' : '') + m.fmt(rows[i][s.key]));
    const txt = `ep ${rows[i].epoch} · ` + parts.join(' / ');
    const tw = ctx.measureText(txt).width;
    const tx = Math.min(Math.max(X(i) - tw/2, padL), W - padR - tw);
    ctx.fillStyle = '#e8eaf0';
    ctx.fillText(txt, tx, 14*dpr);
  } else {
    // legend: each series' name and latest value, in its own color
    let x = padL;
    for (const s of m.series) {
      const txt = s.label + ' · ' + m.fmt(rows[n-1][s.key]);
      ctx.fillStyle = s.color;
      ctx.fillText(txt, x, 14*dpr);
      x += ctx.measureText(txt).width + 16*dpr;
    }
  }
}

async function tick() {
  let delay = IDLE_REFRESH;
  try {
    delay = await render();
  } catch (e) {
    document.getElementById('ts').textContent = 'refresh failed: ' + e;  // server gone: keep trying
  }
  clearTimeout(timer);
  timer = setTimeout(tick, delay);
}

async function render() {
  const runs = await (await fetch('/data')).json();
  const root = document.getElementById('root');
  root.textContent = '';
  const active = [];   // {mtime, med} per run still producing epochs
  const names = Object.keys(runs).sort((a, b) => runs[b].mtime - runs[a].mtime).slice(0, 5);
  for (const name of names) {
    const { mtime, rows } = runs[name];
    const n = rows.length, last = rows[n - 1];
    const p = project(rows, runs[name].epochs, mtime);
    const h = document.createElement('h2');
    let head = `${name} — epoch ${last.epoch}${p.total ? '/' + p.total : ''} (${last.sec}s/epoch)`;
    if (p.done) head += ` <span class="now">· finished</span>`;
    else if (p.stale) head += ` <span class="stale">· stalled, no epoch for ${fmtDur(p.stale)}</span>`;
    else if (p.left != null) head += ` <span class="eta">· ${fmtDur(p.left)} left,`
      + ` done ~${fmtClock(p.at)} ±${fmtDur(p.band)}</span>`
      + ` <small>${p.med.toFixed(1)}±${p.sd.toFixed(1)} s/epoch over the last ${p.n}</small>`;
    h.innerHTML = head + ` <small>last log write ${new Date(mtime * 1000).toLocaleString()}</small>`;
    root.append(h);
    if (!p.done && !p.stale && p.med) active.push({ mtime, med: p.med });
    if (p.frac != null) {
      const bar = document.createElement('div');
      bar.className = 'bar';
      bar.innerHTML = `<i style="width:${(p.frac * 100).toFixed(1)}%"></i>`;
      root.append(bar);
    }
    const charts = [];
    const redraw = (hoverI) => { for (const c of charts) drawChart(c.cv, rows, c.m, hoverI); };
    for (const m of METRICS) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      const left = document.createElement('div');
      const title = document.createElement('p');
      title.className = 'ctitle'; title.textContent = m.title;
      const cv = document.createElement('canvas');
      left.append(title, cv);
      const cap = document.createElement('p');
      cap.className = 'cap'; cap.textContent = m.desc;
      cell.append(left, cap); root.append(cell);
      charts.push({ cv, m });
      // hover is synced across the run's four charts
      cv.addEventListener('mousemove', (ev) => {
        const frac = (ev.offsetX - PADL) / (cv.clientWidth - PADL - PADR);
        redraw(Math.max(0, Math.min(n - 1, Math.round(frac * (n - 1)))));
      });
      cv.addEventListener('mouseleave', () => redraw(null));
    }
    redraw(null);
    const t = document.createElement('table');
    t.innerHTML = '<tr><th>epoch</th><th>train_loss</th><th>val_loss</th><th>val_px</th><th>conf</th><th>s</th></tr>' +
      rows.slice(-5).map(r => `<tr class="${r === last ? 'now' : ''}"><td>${r.epoch}</td><td>${r.train_loss.toFixed(4)}</td><td>${r.val_loss.toFixed(4)}</td><td>${r.val_px.toFixed(2)}</td><td>${r.conf_acc.toFixed(3)}</td><td>${r.sec}</td></tr>`).join('');
    root.append(t);
  }
  const delay = nextDelay(active);
  document.getElementById('ts').textContent =
    `last updated ${new Date().toLocaleTimeString()} · next in ${fmtDur(delay / 1000)}`;
  return delay;
}
let timer = null;
tick();
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
