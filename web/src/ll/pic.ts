// The top-down last-layer picture the OCLL / PLL drill and the case
// reference share: the top face and the four side strips in the trainer's
// colour scheme (algs/pic.ts's picTop, the same picture for any n), and for
// PLL the arrows from each piece to where it goes.

import { picTop, TOP_CELL } from '../algs/pic';
import { type Vec } from '../cube/geometry';
import { type LLKind } from './cases';
import { pllArrows } from './model';
import { ensureStyle } from '../ui/dom';

const STYLE = `
  .ll-pic .ll-arrow { fill: none; stroke: #1b222c; stroke-width: 3; stroke-linecap: round; }
  .ll-pic .ll-arrow-halo { fill: none; stroke: #fff; stroke-width: 7; stroke-linecap: round; opacity: .85; }
  .ll-pic .ll-head { fill: #1b222c; stroke: #fff; stroke-width: 1.5; }
  .ll-pic svg { display: block; width: 100%; height: auto; }
  .ll-pic rect { stroke: #2b3340; stroke-width: 1.2; }
`;
export function ensurePicStyle(): void {
  ensureStyle('ll-pic-style', STYLE);
}

/** The inner SVG (viewBox 0 0 200 200) for the facelet string `f`: the picture, and for PLL the arrows. */
export function picSvg(f: string, kind: LLKind): string {
  return picTop(3, f, 1) + (kind === 'pll' ? arrowsSvg(pllArrows(f) ?? []) : '');
}

/** The arrows over the top face: a 2-cycle as one double-headed arrow, a cycle as one arrow per piece, corners nudged off the edge lines. */
function arrowsSvg(arrows: { from: Vec; to: Vec }[]): string {
  const pitch = TOP_CELL(3, 1);
  const at = (p: Vec): [number, number] => [100 + p[0] * pitch, 100 + p[2] * pitch]; // cell centres: x from the R axis, y from the F axis (front is down)
  const key = (a: Vec, b: Vec) => `${a[0]},${a[2]}>${b[0]},${b[2]}`;
  const seen = new Set<string>();
  let out = '';
  for (const { from, to } of arrows) {
    if (seen.has(key(from, to))) continue;
    seen.add(key(from, to));
    const back = arrows.some((o) => o.from[0] === to[0] && o.from[2] === to[2] && o.to[0] === from[0] && o.to[2] === from[2]);
    if (back) seen.add(key(to, from));
    const [x1, y1] = at(from), [x2, y2] = at(to);
    const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy), ux = dx / len, uy = dy / len;
    const pad = pitch * 0.28, ax = x1 + ux * pad, ay = y1 + uy * pad, bx = x2 - ux * pad, by = y2 - uy * pad;
    const head = (x: number, y: number, dxx: number, dyy: number) => `<polygon class="ll-head" points="${x},${y} ${x - dxx * 10 + dyy * 5.5},${y - dyy * 10 - dxx * 5.5} ${x - dxx * 10 - dyy * 5.5},${y - dyy * 10 + dxx * 5.5}"/>`;
    out += `<line class="ll-arrow-halo" x1="${ax}" y1="${ay}" x2="${bx}" y2="${by}"/><line class="ll-arrow" x1="${ax}" y1="${ay}" x2="${bx}" y2="${by}"/>${head(bx, by, ux, uy)}${back ? head(ax, ay, -ux, -uy) : ''}`;
  }
  return out;
}
