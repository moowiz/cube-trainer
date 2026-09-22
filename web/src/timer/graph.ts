// The Solve tab's graph (docs/smart-cube-design.md 4.1 Results): every
// solve as a dot and the running ao5 / ao12 / ao50 / ao100 as lines, over
// the session or over everything. The layout is a pure function of the
// times (ms, null = DNF, newest last) into positions, then into an SVG
// string; the mount adds the hover layer (a crosshair and a tooltip on
// the nearest solve), the legend that toggles the lines, and the table
// view. No chart library: the page has no framework either.

import { averageOf, formatTime, type Time } from './stats';
import { ensureStyle, esc } from '../ui/dom';
import { readStoredJson, writeStored } from '../ui/settings';

export interface Window { key: string; n: number; colour: string }
// DECISION: the four averages every timer shows, in a fixed colour order (blue, orange, aqua,
// violet) checked for colour-blind separation; a line's colour never changes when another is
// hidden. Aqua is light on this surface, so every line also carries its name at its end.
export const WINDOWS: readonly Window[] = [
  { key: 'ao5', n: 5, colour: '#2a78d6' },
  { key: 'ao12', n: 12, colour: '#eb6834' },
  { key: 'ao50', n: 50, colour: '#1baf7a' },
  { key: 'ao100', n: 100, colour: '#4a3aa7' },
];

/** The average of n ending at every index: undefined before there are n, null for a DNF average. */
export function rolling(times: readonly Time[], n: number): (Time | undefined)[] {
  return times.map((_, i) => (i + 1 < n ? undefined : averageOf(times.slice(i + 1 - n, i + 1), n)));
}

/** The value at the p-th percentile (0..1) of the sorted numbers, by nearest rank. */
export function percentile(sorted: readonly number[], p: number): number | undefined {
  if (!sorted.length) return undefined;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))];
}

/** A tick step in seconds so that the range has at most `max` ticks. */
export function secondsStep(range: number, max: number): number {
  const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 20, 30, 60, 120, 300, 600, 1200, 1800, 3600];
  return steps.find((s) => range / s <= max) ?? steps[steps.length - 1]!;
}

/** A tick step in solve counts so that n solves have at most `max` ticks. */
export function countStep(n: number, max: number): number {
  const steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000, 10_000];
  return steps.find((s) => n / s <= max) ?? steps[steps.length - 1]!;
}

/** An axis label in seconds: 12, 1:05. */
export function secondsLabel(sec: number): string {
  if (sec < 60) return Number.isInteger(sec) ? String(sec) : sec.toFixed(1);
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export interface GraphOpts {
  width: number;
  height: number;
  /** the windows drawn as lines (the rest are still computed for the table and the tooltip) */
  shown: readonly string[];
  /** the day of each solve, as shown: the x-axis then marks the day changes instead of solve numbers */
  days?: readonly string[];
}

interface GraphPoint { i: number; x: number; y: number; t: number; /** above the top of the scale: drawn pinned there */ clipped: boolean }
interface GraphLine { key: string; colour: string; d: string; /** the last drawn point, for the end label */ end: { x: number; y: number } | null }

export interface Graph {
  width: number; height: number;
  /** the plot area */
  x0: number; x1: number; y0: number; y1: number;
  /** ms at the bottom and the top of the scale */
  lo: number; hi: number;
  points: GraphPoint[];
  lines: GraphLine[];
  /** the end labels after being pushed apart: one per drawn line, in the line's colour */
  endLabels: { key: string; colour: string; x: number; y: number }[];
  yTicks: { y: number; label: string }[];
  xTicks: { x: number; label: string }[];
  /** the best single, labelled */
  best: GraphPoint | null;
  /** every window's running average, by key (for the tooltip and the table) */
  series: Record<string, (Time | undefined)[]>;
  /** x of solve i */
  xOf(i: number): number;
}

const MARGIN = { left: 40, right: 48, top: 14, bottom: 24 };

export function layoutGraph(times: readonly Time[], opts: GraphOpts): Graph {
  const { width, height } = opts;
  const x0 = MARGIN.left, x1 = width - MARGIN.right, y0 = MARGIN.top, y1 = height - MARGIN.bottom;
  const n = times.length;
  const series: Record<string, (Time | undefined)[]> = {};
  for (const w of WINDOWS) series[w.key] = rolling(times, w.n);
  const singles = times.filter((t): t is number => t !== null).sort((a, b) => a - b);
  // DECISION: the scale stops at the 98th percentile of the singles (or the highest average on
  // show, if higher) so one two-minute solve does not flatten a session of fifteens; the solves
  // above it sit pinned at the top as triangles and the tooltip gives their real time.
  let hi = percentile(singles, 0.98) ?? 1000;
  for (const w of WINDOWS) if (opts.shown.includes(w.key)) for (const v of series[w.key]!) if (typeof v === 'number' && v > hi) hi = v;
  let lo = singles[0] ?? 0;
  if (hi <= lo) hi = lo + 1000;
  const pad = (hi - lo) * 0.06;
  lo = Math.max(0, lo - pad); hi += pad;
  const step = secondsStep((hi - lo) / 1000, Math.max(3, Math.floor((y1 - y0) / 36)));
  lo = Math.floor(lo / 1000 / step) * step * 1000;
  hi = Math.ceil(hi / 1000 / step) * step * 1000;
  const xOf = (i: number): number => (n <= 1 ? (x0 + x1) / 2 : x0 + ((x1 - x0) * i) / (n - 1));
  const yOf = (t: number): number => y1 - ((y1 - y0) * (t - lo)) / (hi - lo);
  const points: GraphPoint[] = [];
  let best: GraphPoint | null = null;
  times.forEach((t, i) => {
    if (t === null) return;
    const clipped = t > hi;
    const p = { i, x: xOf(i), y: clipped ? y0 : yOf(t), t, clipped };
    points.push(p);
    if (!best || t < best.t) best = p;
  });
  const lines: GraphLine[] = [];
  for (const w of WINDOWS) {
    if (!opts.shown.includes(w.key)) continue;
    let d = '', pen = false, end: { x: number; y: number } | null = null;
    series[w.key]!.forEach((v, i) => {
      if (typeof v !== 'number') { pen = false; return; } // a DNF average breaks the line
      const x = xOf(i), y = yOf(v);
      d += `${pen ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
      pen = true; end = { x, y };
    });
    if (end) lines.push({ key: w.key, colour: w.colour, d, end });
  }
  // the end labels, pushed apart so they never sit on each other
  const endLabels = lines.map((l) => ({ key: l.key, colour: l.colour, x: l.end!.x + 6, y: l.end!.y })).sort((a, b) => a.y - b.y);
  const GAP = 13;
  for (let k = 1; k < endLabels.length; k++) endLabels[k]!.y = Math.max(endLabels[k]!.y, endLabels[k - 1]!.y + GAP);
  for (let k = endLabels.length - 1; k >= 0; k--) {
    const cap = k === endLabels.length - 1 ? y1 : endLabels[k + 1]!.y - GAP;
    if (endLabels[k]!.y > cap) endLabels[k]!.y = cap;
  }
  const yTicks: { y: number; label: string }[] = [];
  for (let s = lo / 1000; s <= hi / 1000 + 1e-9; s += step) yTicks.push({ y: yOf(s * 1000), label: secondsLabel(Math.round(s * 10) / 10) });
  const xTicks: { x: number; label: string }[] = [];
  if (opts.days) {
    // a tick where the day changes, skipping the ones that would sit on the last tick's label
    let lastX = -Infinity, prev = '';
    opts.days.forEach((d, i) => {
      if (i >= n || d === prev) return;
      prev = d;
      const x = xOf(i);
      if (x - lastX < 76) return;
      lastX = x; xTicks.push({ x, label: d });
    });
  } else if (n) {
    const xs = countStep(n, Math.max(2, Math.floor((x1 - x0) / 64)));
    for (let i = xs - 1; i < n; i += xs) xTicks.push({ x: xOf(i), label: String(i + 1) });
    if (xs > 1 && n >= 2 && !xTicks.length) xTicks.push({ x: xOf(n - 1), label: String(n) });
  }
  return { width, height, x0, x1, y0, y1, lo, hi, points, lines, endLabels, yTicks, xTicks, best, series, xOf };
}

/** The SVG for a layout. Marks carry the colour; every word is in ink. */
export function graphSvg(g: Graph): string {
  const grid = g.yTicks.map((t) => `<line class="gr-grid" x1="${g.x0}" x2="${g.x1}" y1="${t.y.toFixed(1)}" y2="${t.y.toFixed(1)}"/>`).join('');
  const ys = g.yTicks.map((t) => `<text class="gr-tick" x="${g.x0 - 6}" y="${(t.y + 3.5).toFixed(1)}" text-anchor="end">${t.label}</text>`).join('');
  // a label at the plot's edge hangs inward rather than off the svg
  const anchor = (x: number): string => (x - g.x0 < 30 ? 'start' : g.x1 - x < 30 ? 'end' : 'middle');
  const xs = g.xTicks.map((t) => `<text class="gr-tick" x="${t.x.toFixed(1)}" y="${g.y1 + 16}" text-anchor="${anchor(t.x)}">${esc(t.label)}</text>`).join('');
  const dots = g.points.map((p) => (p.clipped
    ? `<path class="gr-clip" data-i="${p.i}" d="M${(p.x - 3.5).toFixed(1)} ${(p.y + 6).toFixed(1)}h7l-3.5 -6z"/>`
    : `<circle class="gr-dot" data-i="${p.i}" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="2.2"/>`)).join('');
  const lines = g.lines.map((l) => `<path class="gr-line" data-key="${l.key}" d="${l.d}" stroke="${l.colour}"/>`).join('');
  const ends = g.lines.map((l) => `<circle class="gr-end" cx="${l.end!.x.toFixed(1)}" cy="${l.end!.y.toFixed(1)}" r="4" fill="${l.colour}"/>`).join('');
  const labels = g.endLabels.map((l) => `<text class="gr-label" x="${l.x.toFixed(1)}" y="${(l.y + 3.5).toFixed(1)}">${l.key}</text>`).join('');
  let best = '';
  if (g.best) {
    const b = g.best;
    // the label sits to whichever side has room, above the dot
    const left = b.x > (g.x0 + g.x1) / 2;
    best = `<circle class="gr-best" cx="${b.x.toFixed(1)}" cy="${b.y.toFixed(1)}" r="4"/>` +
      `<text class="gr-label" x="${(b.x + (left ? -7 : 7)).toFixed(1)}" y="${Math.max(g.y0 + 10, b.y - 7).toFixed(1)}" text-anchor="${left ? 'end' : 'start'}">best ${formatTime(b.t)}</text>`;
  }
  return `<svg class="gr-svg" width="${g.width}" height="${g.height}" viewBox="0 0 ${g.width} ${g.height}" role="img" aria-label="Solve times with running averages">` +
    `${grid}<line class="gr-axis" x1="${g.x0}" x2="${g.x1}" y1="${g.y1}" y2="${g.y1}"/>${ys}${xs}${dots}${lines}${ends}${best}${labels}` +
    `<line class="gr-cross" x1="0" x2="0" y1="${g.y0}" y2="${g.y1}" hidden/><circle class="gr-hit" r="5" hidden/></svg>`;
}

const STYLE = `
  .gr { position: relative; }
  .gr-svg { display: block; width: 100%; height: auto; touch-action: pan-y; }
  .gr-grid { stroke: var(--line); stroke-width: 1; }
  .gr-axis { stroke: var(--grey); stroke-width: 1; }
  .gr-tick { font-size: 11px; fill: var(--ink-2); font-variant-numeric: tabular-nums; }
  .gr-label { font-size: 11px; font-weight: 600; fill: var(--ink); }
  .gr-dot { fill: var(--ink-2); opacity: .45; }
  .gr-clip { fill: var(--ink-2); opacity: .7; }
  .gr-line { fill: none; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
  .gr-end { stroke: var(--panel); stroke-width: 2; }
  .gr-best { fill: var(--ink); stroke: var(--panel); stroke-width: 2; }
  .gr-cross { stroke: var(--ink-2); stroke-width: 1; }
  .gr-hit { fill: var(--ink); stroke: var(--panel); stroke-width: 2; }
  .gr-tip { position: absolute; pointer-events: none; background: rgba(20,22,28,.94); color: #e8eaf0; font-size: 12px; line-height: 1.5; padding: 6px 9px; border-radius: 8px; white-space: nowrap; box-shadow: 0 4px 14px rgba(0,0,0,.25); z-index: 2; }
  .gr-tip b { font-weight: 600; color: #fff; }
  .gr-tip .k { display: inline-block; width: 12px; height: 3px; border-radius: 2px; vertical-align: middle; margin-right: 5px; }
  .gr-legend { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 0 4px; }
  .gr-legend .btn { display: inline-flex; align-items: center; gap: 6px; padding: 4px 9px; font-size: 13px; }
  .gr-legend .btn .k { width: 14px; height: 3px; border-radius: 2px; }
  .gr-legend .btn:not(.on) { color: var(--ink-2); } .gr-legend .btn:not(.on) .k { opacity: .3; }
  .gr-legend .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--ink-2); opacity: .6; }
  .gr-empty { color: var(--ink-2); font-size: 14px; padding: 24px 0; text-align: center; }
  .gr-table { margin-top: 10px; font-size: 13px; }
  .gr-table summary { cursor: pointer; color: var(--ink-2); }
  .gr-table table { border-collapse: collapse; width: 100%; margin-top: 6px; font-variant-numeric: tabular-nums; }
  .gr-table th, .gr-table td { text-align: right; padding: 3px 6px; border-bottom: 1px solid var(--line); }
  .gr-table th { color: var(--ink-2); font-weight: 500; font-size: 12px; }
  .gr-table td:nth-child(2), .gr-table th:nth-child(2) { text-align: left; }
  .gr-table .note { color: var(--ink-2); font-size: 12px; padding: 4px 0; }
`;

export interface GraphData {
  /** ms, null = DNF, oldest first */
  times: Time[];
  /** wall clock of each, same order */
  whens: number[];
  /** the x-axis labels are dates rather than solve numbers (the all-time view) */
  dated?: boolean;
  /** "19 Sep" for a wall clock */
  dayOf(when: number): string;
}

const SHOWN_KEY = 'zz-graph-shown';
const HEIGHT = 280;
// DECISION: the table view lists the newest rows only past this many; ten thousand rows of seven
// cells is more DOM than a phone should build for a fallback.
const TABLE_ROWS = 300;

/** Draw the graph, its legend and its table into `root`; returns the redraw for new data. */
export function mountGraph(root: HTMLElement): (data: GraphData) => void {
  ensureStyle('graph-style', STYLE);
  let shown = new Set<string>(WINDOWS.map((w) => w.key));
  { const saved = readStoredJson(SHOWN_KEY); if (Array.isArray(saved)) shown = new Set(saved.filter((k) => WINDOWS.some((w) => w.key === k))); }
  root.innerHTML = '<div class="gr-legend"></div><div class="gr"><div class="gr-plot"></div><div class="gr-tip" hidden></div></div><details class="gr-table"><summary>Table</summary><div class="gr-rows"></div></details>';
  const legend = root.querySelector<HTMLElement>('.gr-legend')!, plot = root.querySelector<HTMLElement>('.gr-plot')!;
  const tip = root.querySelector<HTMLElement>('.gr-tip')!, rows = root.querySelector<HTMLElement>('.gr-rows')!, table = root.querySelector<HTMLDetailsElement>('.gr-table')!;
  let data: GraphData = { times: [], whens: [], dayOf: () => '' };
  let g: Graph | null = null;

  function drawLegend(): void {
    legend.innerHTML = `<span class="btn" style="cursor:default"><span class="dot"></span>solve</span>` +
      WINDOWS.map((w) => `<button type="button" class="btn ${shown.has(w.key) ? 'on' : ''}" data-key="${w.key}" aria-pressed="${shown.has(w.key)}"><span class="k" style="background:${w.colour}"></span>${w.key}</button>`).join('');
  }
  legend.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('button[data-key]');
    if (!b) return;
    const k = b.dataset.key!;
    if (shown.has(k)) shown.delete(k); else shown.add(k);
    writeStored(SHOWN_KEY, JSON.stringify([...shown]));
    drawLegend(); draw();
  });

  function draw(): void {
    hide();
    const width = Math.max(200, plot.clientWidth || root.clientWidth || 320);
    if (!data.times.length) { g = null; plot.innerHTML = '<div class="gr-empty">No solves to graph yet.</div>'; rows.innerHTML = ''; return; }
    g = layoutGraph(data.times, { width, height: HEIGHT, shown: [...shown], days: data.dated ? data.whens.map((w) => data.dayOf(w)) : undefined });
    plot.innerHTML = graphSvg(g);
    if (table.open) drawTable();
  }
  function drawTable(): void {
    if (!g) { rows.innerHTML = ''; return; }
    const n = data.times.length, from = Math.max(0, n - TABLE_ROWS);
    const cells: string[] = [];
    for (let i = n - 1; i >= from; i--) {
      cells.push(`<tr><td>${i + 1}</td><td>${esc(data.dayOf(data.whens[i]!))}</td><td>${formatTime(data.times[i])}</td>${WINDOWS.map((w) => `<td>${formatTime(g!.series[w.key]![i])}</td>`).join('')}</tr>`);
    }
    rows.innerHTML = `${from ? `<div class="note">The last ${TABLE_ROWS} of ${n}.</div>` : ''}<table><thead><tr><th>#</th><th>when</th><th>time</th>${WINDOWS.map((w) => `<th>${w.key}</th>`).join('')}</tr></thead><tbody>${cells.join('')}</tbody></table>`;
  }
  table.addEventListener('toggle', () => { if (table.open) drawTable(); });

  // the hover layer: the nearest solve by x, a crosshair on it, the tooltip beside the pointer
  function hide(): void {
    tip.hidden = true;
    plot.querySelector<SVGElement>('.gr-cross')?.setAttribute('hidden', '');
    plot.querySelector<SVGElement>('.gr-hit')?.setAttribute('hidden', '');
  }
  function show(ev: PointerEvent): void {
    if (!g) return;
    const svg = plot.querySelector<SVGSVGElement>('svg');
    if (!svg) return;
    const r = svg.getBoundingClientRect();
    const scale = g.width / r.width;
    const px = (ev.clientX - r.left) * scale;
    const n = data.times.length;
    const i = n <= 1 ? 0 : Math.round(((px - g.x0) / (g.x1 - g.x0)) * (n - 1));
    if (i < 0 || i >= n) { hide(); return; }
    const t = data.times[i];
    const x = g.xOf(i);
    const cross = svg.querySelector<SVGElement>('.gr-cross')!, hit = svg.querySelector<SVGElement>('.gr-hit')!;
    cross.setAttribute('x1', String(x)); cross.setAttribute('x2', String(x)); cross.removeAttribute('hidden');
    const p = g.points.find((q) => q.i === i);
    if (p) { hit.setAttribute('cx', String(p.x)); hit.setAttribute('cy', String(p.y)); hit.removeAttribute('hidden'); } else hit.setAttribute('hidden', '');
    const avgs = WINDOWS.filter((w) => shown.has(w.key)).map((w) => `<div><span class="k" style="background:${w.colour}"></span>${w.key} <b>${formatTime(g!.series[w.key]![i])}</b></div>`).join('');
    tip.innerHTML = `<div>#${i + 1} · ${esc(data.dayOf(data.whens[i]!))} · <b>${formatTime(t)}</b>${p?.clipped ? ' (above the scale)' : ''}</div>${avgs}`;
    tip.hidden = false;
    // beside the pointer, on the left when it would run off the right edge; on a phone the finger
    // is on the crosshair, so the tip sits at the top of the plot on the other side instead
    const wrap = plot.getBoundingClientRect();
    const left = ev.clientX - wrap.left, top = ev.clientY - wrap.top;
    const narrow = wrap.width < 520;
    const flip = narrow ? left > wrap.width / 2 : left + 12 + tip.offsetWidth > wrap.width;
    tip.style.left = `${flip ? Math.max(0, left - tip.offsetWidth - 12) : Math.min(left + 12, wrap.width - tip.offsetWidth)}px`;
    tip.style.top = `${narrow ? 0 : Math.max(0, Math.min(wrap.height - tip.offsetHeight, top - 20))}px`;
  }
  plot.addEventListener('pointermove', show);
  plot.addEventListener('pointerdown', show);
  plot.addEventListener('pointerleave', hide);

  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => { if (data.times.length) draw(); }).observe(plot);
  drawLegend();
  return (d) => { data = d; draw(); };
}
