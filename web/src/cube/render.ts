// Pictures of a cube: the 3D view (mild perspective, ink outlines, no body)
// and the net, both as SVG. Each sticker is one element carrying its
// facelet index in data-idx, so a trainer can colour, class, mark, and
// listen to clicks on stickers without owning any geometry. The 3D view is
// a general polygon painter (renderPolys: cull, sort by depth, project)
// that the cube feeds its facelet quads and the FTO its triangles; orbit()
// drags either.

import { STICKERS, type Vec } from './geometry';

export interface View { rx: number; ry: number }
export const DEFAULT_VIEW: View = { rx: 28, ry: -35 };

/** What to draw for one facelet. */
export interface Cell {
  fill: string;
  /** extra class on the sticker element (pair, solved, hit, center...) */
  cls?: string;
  /** a dot on the sticker (EO's bad-edge marks) */
  mark?: boolean;
}

const deg = (d: number) => (d * Math.PI) / 180;
function rotView(p: Vec, view: View): Vec {
  const cy = Math.cos(deg(view.ry)), sy = Math.sin(deg(view.ry)), cx = Math.cos(deg(view.rx)), sx = Math.sin(deg(view.rx));
  let [x, y, z] = p;
  [x, z] = [x * cy + z * sy, -x * sy + z * cy];
  [y, z] = [y * cx - z * sx, y * sx + z * cx];
  return [x, y, z];
}
const W = 340, SCALE = 78, D = 16;
function project(p: Vec, view: View, scale: number): [number, number] {
  const [x, y, z] = rotView(p, view);
  const k = D / (D - z);
  return [x * scale * k, -y * scale * k];
}
function tangents(n: Vec): [Vec, Vec] {
  const a = n.findIndex((v) => v !== 0);
  return a === 0 ? [[0, 1, 0], [0, 0, 1]] : a === 1 ? [[1, 0, 0], [0, 0, 1]] : [[1, 0, 0], [0, 1, 0]];
}
const add = (a: Vec, b: Vec, k = 1): Vec => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const fmt = (v: number) => v.toFixed(1);

/** One polygon to paint: its corners and outward normal in model space, and how to draw it. */
export interface Poly {
  pts: readonly Vec[];
  n: Vec;
  fill: string;
  /** extra class on the element */
  cls?: string;
  /** data-idx on the element (a sticker index), for click handlers */
  idx?: number;
  /** a dot at the centre (EO's bad-edge marks) */
  mark?: boolean;
}

/**
 * Paint polygons into `svg` from `view`: the ones facing away are dropped, the rest are drawn far to near by
 * the depth of their centre. `scale` is pixels per model unit inside a viewBox `W` wide centred on the origin
 * (the cube's cubie units at 78; a unit-radius puzzle wants more).
 */
export function renderPolys(svg: SVGSVGElement, polys: readonly Poly[], view: View, scale = SCALE): void {
  const seen = polys
    .map((p) => {
      const c = p.pts.reduce((a, b) => add(a, b), [0, 0, 0] as Vec);
      return { p, nz: rotView(p.n, view)[2], z: rotView(c, view)[2] / p.pts.length };
    })
    .filter((o) => o.nz > 0)
    .sort((a, b) => a.z - b.z);
  let out = '';
  for (const { p } of seen) {
    const pts = p.pts.map((q) => project(q, view, scale));
    out += `<polygon${p.idx === undefined ? '' : ` data-idx="${p.idx}"`} class="${p.cls ?? ''}" points="${pts.map((q) => q.map(fmt).join(',')).join(' ')}" fill="${p.fill}"/>`;
    if (p.mark) {
      const c = p.pts.reduce((a, b) => add(a, b), [0, 0, 0] as Vec);
      const [px, py] = project([c[0] / p.pts.length, c[1] / p.pts.length, c[2] / p.pts.length], view, scale);
      out += `<circle cx="${fmt(px)}" cy="${fmt(py)}" r="5" fill="#1b222c" opacity=".8"/>`;
    }
  }
  svg.setAttribute('viewBox', `${-W / 2} ${-W / 2} ${W} ${W}`);
  svg.innerHTML = out;
}

/** Draw the cube into `svg` from `view`; `cells[i]` describes facelet i. */
export function render3d(svg: SVGSVGElement, cells: readonly Cell[], view: View): void {
  const polys: Poly[] = STICKERS.map((s) => {
    const cell = cells[s.idx]!;
    const [t1, t2] = tangents(s.n);
    const c = add(s.pos, s.n, 0.5);
    return { pts: [add(add(c, t1, .45), t2, .45), add(add(c, t1, -.45), t2, .45), add(add(c, t1, -.45), t2, -.45), add(add(c, t1, .45), t2, -.45)], n: s.n, fill: cell.fill, cls: cell.cls, idx: s.idx, mark: cell.mark };
  });
  renderPolys(svg, polys, view);
}

// the net: face origins in cells and the two axes each face is read along
const NET: Record<string, { o: [number, number]; u: Vec; v: Vec }> = {
  U: { o: [3, 0], u: [1, 0, 0], v: [0, 0, 1] }, L: { o: [0, 3], u: [0, 0, 1], v: [0, -1, 0] }, F: { o: [3, 3], u: [1, 0, 0], v: [0, -1, 0] },
  R: { o: [6, 3], u: [0, 0, -1], v: [0, -1, 0] }, B: { o: [9, 3], u: [-1, 0, 0], v: [0, -1, 0] }, D: { o: [3, 6], u: [1, 0, 0], v: [0, 0, -1] },
};
const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** The unfolded cube into `svg`. */
export function renderNet(svg: SVGSVGElement, cells: readonly Cell[]): void {
  const S = 32, pad = 8;
  let out = '';
  for (const s of STICKERS) {
    const L = NET[s.face], cell = cells[s.idx];
    const u = dot(s.pos, L.u) + 1, v = dot(s.pos, L.v) + 1;
    const x = pad + (L.o[0] + u) * S, y = pad + (L.o[1] + v) * S;
    out += `<rect data-idx="${s.idx}" class="${cell.cls ?? ''}" x="${x + 1}" y="${y + 1}" width="${S - 2}" height="${S - 2}" rx="3" fill="${cell.fill}"/>`;
    if (cell.mark) out += `<circle cx="${x + S / 2}" cy="${y + S / 2}" r="4.5" fill="#1b222c" opacity=".8"/>`;
  }
  svg.setAttribute('viewBox', `0 0 ${12 * S + 2 * pad} ${9 * S + 2 * pad}`);
  svg.innerHTML = out;
}

/** The facelet index of a click on a picture, or null. */
export function clickedFacelet(e: Event): number | null {
  const el = (e.target as Element | null)?.closest?.('[data-idx]');
  return el ? Number((el as HTMLElement).dataset.idx) : null;
}

/**
 * Drag to orbit a 3D picture (does not turn the cube). `onChange` redraws; `lastDrag()` tells a
 * click handler whether the pointer just finished dragging, so a tap is not mistaken for a drag.
 */
export function orbit(svg: SVGSVGElement, view: View, onChange: () => void, enabled: () => boolean = () => true): { lastDrag(): number } {
  let drag: { x: number; y: number; rx: number; ry: number; id: number; moved: boolean } | null = null;
  let last = 0;
  svg.addEventListener('pointerdown', (e) => {
    if (!enabled()) return;
    drag = { x: e.clientX, y: e.clientY, rx: view.rx, ry: view.ry, id: e.pointerId, moved: false };
    svg.setPointerCapture(e.pointerId);
  });
  svg.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
    drag.moved = true;
    view.ry = drag.ry + dx * 0.6;
    view.rx = Math.max(-80, Math.min(80, drag.rx + dy * 0.6));
    onChange();
  });
  const end = () => { if (drag?.moved) last = performance.now(); drag = null; };
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);
  return { lastDrag: () => last };
}
