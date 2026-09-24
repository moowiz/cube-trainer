// The practice graph: one line per case, its running ao5 (ao3 until there
// are five) at every try of that case, over every timed try of the stage
// in order - so the cases can be compared on one scale and a case that is
// stuck stands out from the ones coming down. A legend chip per case
// toggles its line; the day marks on the x axis are the Solve tab's. The
// layout is a pure function into an SVG string; the mount adds the legend,
// the hover and the tooltip. No chart library, as timer/graph.ts.

import type { AttemptRecord } from '../store/types';
import { averageOf } from '../timer/stats';
import { secondsLabel, secondsStep } from '../timer/graph';
import { ensureStyle, esc } from '../ui/dom';
import { readStoredJson, writeStored } from '../ui/settings';
import type { LLCase } from './cases';

// DECISION: the average of the last five tries once there are five, of the last three before that
// (the trimmed three: the median), nothing under three. Waiting for five would leave most of the
// table's cases off the graph for an evening.
export const AVG_N = 5, MIN_N = 3;

interface CasePoint {
  /** the try's index among every timed try of the stage (the x axis) */
  i: number;
  when: number;
  /** ms, this try */
  t: number;
  /** ms, the running average at this try; null under MIN_N tries */
  v: number | null;
}
export interface CaseLine { id: string; name: string; colour: string; points: CasePoint[] }

// DECISION: twenty hues, no two neighbours alike, so the drill's 21 cases each get one (the last
// wraps); a line's colour is by its place in the case list and never changes when others are hidden.
const CASE_COLOURS = ['#2A78D6', '#EB6834', '#1BAF7A', '#4A3AA7', '#D6299A', '#B58A00', '#0F8FA8', '#C0392B', '#5B8C1A', '#7D4FD6', '#E07B00', '#2C6E49', '#A03E78', '#6B7280', '#008B8B', '#8B4513', '#3B5BDB', '#C2185B', '#558B2F', '#795548'];
export const colourOf = (k: number): string => CASE_COLOURS[k % CASE_COLOURS.length]!;

/** Every case's line from the stage's attempts (any order), and the wall clock of every timed try in x order. */
export function caseLines(attempts: readonly AttemptRecord[], cases: readonly LLCase[]): { lines: CaseLine[]; whens: number[] } {
  const timed = attempts.filter((a) => !a.deleted && a.time !== null && a.caseId).sort((a, b) => a.when - b.when);
  const byCase = new Map<string, CasePoint[]>();
  timed.forEach((a, i) => {
    const pts = byCase.get(a.caseId!) ?? byCase.set(a.caseId!, []).get(a.caseId!)!;
    const so = pts.map((p) => p.t).concat(a.time!);
    const k = so.length;
    const v = k < MIN_N ? null : averageOf(so.slice(-Math.min(AVG_N, k)), Math.min(AVG_N, k)) ?? null;
    pts.push({ i, when: a.when, t: a.time!, v });
  });
  return { lines: cases.map((c, k) => ({ id: c.id, name: c.name, colour: colourOf(k), points: byCase.get(c.name) ?? [] })), whens: timed.map((a) => a.when) };
}

export interface CaseGraphOpts { width: number; height: number; /** the case ids drawn */ shown: readonly string[]; /** the day of each try, as shown */ days: readonly string[] }
export interface CaseGraph {
  width: number; height: number; x0: number; x1: number; y0: number; y1: number; lo: number; hi: number;
  /** the drawn lines: the path and its points' positions, for the hover */
  lines: { id: string; name: string; colour: string; d: string; dots: { x: number; y: number; p: CasePoint }[] }[];
  endLabels: { id: string; name: string; colour: string; x: number; y: number }[];
  yTicks: { y: number; label: string }[];
  xTicks: { x: number; label: string }[];
}

const MARGIN = { left: 40, right: 44, top: 14, bottom: 24 };

export function layoutCaseGraph(lines: readonly CaseLine[], n: number, opts: CaseGraphOpts): CaseGraph {
  const { width, height } = opts;
  const x0 = MARGIN.left, x1 = width - MARGIN.right, y0 = MARGIN.top, y1 = height - MARGIN.bottom;
  const drawn = lines.filter((l) => opts.shown.includes(l.id) && l.points.some((p) => p.v !== null));
  const vals = drawn.flatMap((l) => l.points.map((p) => p.v)).filter((v): v is number => v !== null);
  let lo = vals.length ? Math.min(...vals) : 0, hi = vals.length ? Math.max(...vals) : 1000;
  if (hi <= lo) hi = lo + 1000;
  const pad = (hi - lo) * 0.08;
  lo = Math.max(0, lo - pad); hi += pad;
  const step = secondsStep((hi - lo) / 1000, Math.max(3, Math.floor((y1 - y0) / 36)));
  lo = Math.floor(lo / 1000 / step) * step * 1000;
  hi = Math.ceil(hi / 1000 / step) * step * 1000;
  const xOf = (i: number): number => (n <= 1 ? (x0 + x1) / 2 : x0 + ((x1 - x0) * i) / (n - 1));
  const yOf = (t: number): number => y1 - ((y1 - y0) * (t - lo)) / (hi - lo);
  const out: CaseGraph['lines'] = [];
  for (const l of drawn) {
    let d = '', pen = false;
    const dots: { x: number; y: number; p: CasePoint }[] = [];
    for (const p of l.points) {
      if (p.v === null) continue;
      const x = xOf(p.i), y = yOf(p.v);
      d += `${pen ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
      pen = true; dots.push({ x, y, p });
    }
    out.push({ id: l.id, name: l.name, colour: l.colour, d, dots });
  }
  // the end labels, pushed apart so they never sit on each other (timer/graph.ts's rule)
  const endLabels = out.map((l) => ({ id: l.id, name: l.name, colour: l.colour, x: l.dots[l.dots.length - 1]!.x + 6, y: l.dots[l.dots.length - 1]!.y })).sort((a, b) => a.y - b.y);
  const GAP = 13;
  for (let k = 1; k < endLabels.length; k++) endLabels[k]!.y = Math.max(endLabels[k]!.y, endLabels[k - 1]!.y + GAP);
  for (let k = endLabels.length - 1; k >= 0; k--) {
    const cap = k === endLabels.length - 1 ? y1 : endLabels[k + 1]!.y - GAP;
    if (endLabels[k]!.y > cap) endLabels[k]!.y = cap;
  }
  const yTicks: { y: number; label: string }[] = [];
  for (let s = lo / 1000; s <= hi / 1000 + 1e-9; s += step) yTicks.push({ y: yOf(s * 1000), label: secondsLabel(Math.round(s * 10) / 10) });
  const xTicks: { x: number; label: string }[] = [];
  let lastX = -Infinity, prev = '';
  opts.days.forEach((day, i) => {
    if (i >= n || day === prev) return;
    prev = day;
    const x = xOf(i);
    if (x - lastX < 76) return;
    lastX = x; xTicks.push({ x, label: day });
  });
  return { width, height, x0, x1, y0, y1, lo, hi, lines: out, endLabels, yTicks, xTicks };
}

export function caseGraphSvg(g: CaseGraph): string {
  const grid = g.yTicks.map((t) => `<line class="pg-grid" x1="${g.x0}" x2="${g.x1}" y1="${t.y.toFixed(1)}" y2="${t.y.toFixed(1)}"/>`).join('');
  const ys = g.yTicks.map((t) => `<text class="pg-tick" x="${g.x0 - 6}" y="${(t.y + 3.5).toFixed(1)}" text-anchor="end">${t.label}</text>`).join('');
  const anchor = (x: number): string => (x - g.x0 < 30 ? 'start' : g.x1 - x < 30 ? 'end' : 'middle');
  const xs = g.xTicks.map((t) => `<text class="pg-tick" x="${t.x.toFixed(1)}" y="${g.y1 + 16}" text-anchor="${anchor(t.x)}">${esc(t.label)}</text>`).join('');
  const lines = g.lines.map((l) => `<g class="pg-case" data-id="${esc(l.id)}"><path class="pg-line" d="${l.d}" stroke="${l.colour}"/>${l.dots.map((d) => `<circle class="pg-dot" cx="${d.x.toFixed(1)}" cy="${d.y.toFixed(1)}" r="2" fill="${l.colour}"/>`).join('')}</g>`).join('');
  const labels = g.endLabels.map((l) => `<text class="pg-label" x="${l.x.toFixed(1)}" y="${(l.y + 3.5).toFixed(1)}" fill="${l.colour}">${esc(l.name)}</text>`).join('');
  return `<svg class="pg-svg" width="${g.width}" height="${g.height}" viewBox="0 0 ${g.width} ${g.height}" role="img" aria-label="Each case's running average over the tries">` +
    `${grid}<line class="pg-axis" x1="${g.x0}" x2="${g.x1}" y1="${g.y1}" y2="${g.y1}"/>${ys}${xs}${lines}${labels}<circle class="pg-hit" r="5" hidden/></svg>`;
}

const STYLE = `
  .pg { position: relative; }
  .pg-svg { display: block; width: 100%; height: auto; touch-action: pan-y; }
  .pg-grid { stroke: var(--line); stroke-width: 1; }
  .pg-axis { stroke: var(--grey); stroke-width: 1; }
  .pg-tick { font-size: 11px; fill: var(--ink-2); font-variant-numeric: tabular-nums; }
  .pg-label { font-size: 11px; font-weight: 600; }
  .pg-line { fill: none; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
  .pg-svg.hot .pg-case:not(.hot) { opacity: .25; }
  .pg-hit { fill: var(--ink); stroke: var(--panel); stroke-width: 2; }
  .pg-tip { position: absolute; pointer-events: none; background: rgba(20,22,28,.94); color: #e8eaf0; font-size: 12px; line-height: 1.5; padding: 6px 9px; border-radius: 8px; white-space: nowrap; box-shadow: 0 4px 14px rgba(0,0,0,.25); z-index: 2; }
  .pg-tip b { font-weight: 600; color: #fff; }
  .pg-legend { display: flex; flex-wrap: wrap; gap: 5px; padding: 8px 0 4px; align-items: center; }
  .pg-legend .btn { display: inline-flex; align-items: center; gap: 5px; padding: 3px 8px; font-size: 13px; }
  .pg-legend .btn .k { width: 12px; height: 3px; border-radius: 2px; }
  .pg-legend .btn:not(.on) { color: var(--ink-2); } .pg-legend .btn:not(.on) .k { opacity: .25; }
  .pg-legend .btn.none { color: var(--ink-2); opacity: .55; }
  .pg-empty { color: var(--ink-2); font-size: 14px; padding: 24px 0; text-align: center; }
`;

export interface CaseGraphData { lines: CaseLine[]; whens: number[]; dayOf(when: number): string }
const HEIGHT = 280;

/**
 * Draw the graph and its legend into `root`: `draw` for new data, `only(id)` to show one case alone
 * (the table: tapping a name; "all" in the legend brings the rest back). `shownKey` keeps which cases
 * are hidden; with nothing stored every case is on.
 */
export function mountCaseGraph(root: HTMLElement, shownKey: string): { draw(d: CaseGraphData): void; only(id: string): void } {
  ensureStyle('practice-graph-style', STYLE);
  /** the cases switched off; empty by default, so a case never has to be switched on */
  let hidden = new Set<string>();
  { const saved = readStoredJson(shownKey); if (Array.isArray(saved)) hidden = new Set(saved.filter((k): k is string => typeof k === 'string')); }
  root.innerHTML = '<div class="pg-legend"></div><div class="pg"><div class="pg-plot"></div><div class="pg-tip" hidden></div></div>';
  const legend = root.querySelector<HTMLElement>('.pg-legend')!, plot = root.querySelector<HTMLElement>('.pg-plot')!, tip = root.querySelector<HTMLElement>('.pg-tip')!;
  let data: CaseGraphData = { lines: [], whens: [], dayOf: () => '' };
  let g: CaseGraph | null = null;
  const isOn = (id: string) => !hidden.has(id);
  const save = () => writeStored(shownKey, JSON.stringify([...hidden]));

  function drawLegend(): void {
    // a case tried but with no line yet (under MIN_N tries) is listed greyed, so its absence is not a
    // mystery; a case never tried is not listed at all
    legend.innerHTML = data.lines.filter((l) => l.points.length).map((l) => {
      const has = l.points.some((p) => p.v !== null);
      return `<button type="button" class="btn ${isOn(l.id) ? 'on' : ''} ${has ? '' : 'none'}" data-id="${esc(l.id)}" aria-pressed="${isOn(l.id)}" title="${has ? '' : `under ${MIN_N} timed tries: no line yet`}"><span class="k" style="background:${l.colour}"></span>${esc(l.name)}</button>`;
    }).join('') + '<button type="button" class="eo-link" data-all="on">all</button><button type="button" class="eo-link" data-all="off">none</button>';
  }
  legend.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('button[data-id]'), all = (e.target as HTMLElement).closest<HTMLElement>('button[data-all]');
    if (all) hidden = all.dataset.all === 'on' ? new Set() : new Set(data.lines.map((l) => l.id));
    else if (b) { const id = b.dataset.id!; if (hidden.has(id)) hidden.delete(id); else hidden.add(id); }
    else return;
    save(); drawLegend(); draw();
  });

  function draw(): void {
    hide();
    const width = Math.max(200, plot.clientWidth || root.clientWidth || 320);
    const n = data.whens.length;
    if (!data.lines.some((l) => l.points.some((p) => p.v !== null))) { g = null; plot.innerHTML = `<div class="pg-empty">A case gets a line after ${MIN_N} timed tries.</div>`; return; }
    g = layoutCaseGraph(data.lines, n, { width, height: HEIGHT, shown: data.lines.map((l) => l.id).filter(isOn), days: data.whens.map((w) => data.dayOf(w)) });
    plot.innerHTML = g.lines.length ? caseGraphSvg(g) : '<div class="pg-empty">No case picked: tap one in the legend.</div>';
  }

  // the hover: the nearest point on any drawn line, its line lit, the rest dimmed
  function hide(): void {
    tip.hidden = true;
    const svg = plot.querySelector<SVGSVGElement>('svg');
    if (!svg) return;
    svg.classList.remove('hot');
    svg.querySelectorAll('.pg-case.hot').forEach((c) => c.classList.remove('hot'));
    svg.querySelector<SVGElement>('.pg-hit')?.setAttribute('hidden', '');
  }
  function show(ev: PointerEvent): void {
    if (!g) return;
    const svg = plot.querySelector<SVGSVGElement>('svg');
    if (!svg) return;
    const r = svg.getBoundingClientRect(), scale = g.width / r.width;
    const px = (ev.clientX - r.left) * scale, py = (ev.clientY - r.top) * scale;
    let best: { line: CaseGraph['lines'][number]; dot: { x: number; y: number; p: CasePoint }; d: number } | null = null;
    for (const line of g.lines) for (const dot of line.dots) {
      const d = Math.hypot(dot.x - px, (dot.y - py) * 0.5); // x counts double: a finger lands beside a point, not on it
      if (!best || d < best.d) best = { line, dot, d };
    }
    if (!best || best.d > 40) { hide(); return; }
    svg.classList.add('hot');
    svg.querySelectorAll('.pg-case').forEach((c) => c.classList.toggle('hot', (c as SVGElement).dataset.id === best!.line.id));
    const hit = svg.querySelector<SVGElement>('.pg-hit')!;
    hit.setAttribute('cx', String(best.dot.x)); hit.setAttribute('cy', String(best.dot.y)); hit.removeAttribute('hidden');
    const p = best.dot.p, k = best.line.dots.findIndex((d) => d.p === p) + 1;
    const n = Math.min(AVG_N, k + MIN_N - 1);
    tip.innerHTML = `<div><b>${esc(best.line.name)}</b> · ${esc(data.dayOf(p.when))}</div><div>ao${n} <b>${(p.v! / 1000).toFixed(2)}</b> · this try ${(p.t / 1000).toFixed(2)}</div>`;
    tip.hidden = false;
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
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => { if (data.whens.length) draw(); }).observe(plot);

  return {
    draw: (d) => { data = d; drawLegend(); draw(); },
    only: (id) => { hidden = new Set(data.lines.map((l) => l.id).filter((x) => x !== id)); save(); drawLegend(); draw(); },
  };
}
