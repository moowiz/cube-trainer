// Client for the EOCross worker (public/eocross-worker.js): the exact
// distance table over edge orientation x white-edge positions. Started on
// first use; requests queue behind the build. Also the per-scramble analysis
// the EO trainer's strategy hint is written from.

import { FACE_MOVES, moveStr, movesStr, type Move } from '../cube/alg';
import { CROSS_HOME, EDGE_MOVES, type EdgeState } from '../cube/pieces';
import { applyMoves, lastEoTurn, solutionShape, type SolutionSet } from './solver';
import { esc } from '../ui/dom';

export type XStatus = 'off' | 'building' | 'ready' | 'failed';

type Pending = { resolve: (v: unknown) => void; reject: () => void };

export class EOCrossClient {
  status: XStatus = 'off';
  depth = 0;
  private worker: Worker | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 0;
  /** called on every status change and answer, for the UI to repaint */
  onStatus: () => void = () => undefined;

  ensure(): boolean {
    if (this.worker) return true;
    if (this.status === 'failed') return false;
    try { this.worker = new Worker('eocross-worker.js'); } catch { this.status = 'failed'; return false; }
    this.status = 'building';
    this.worker.onerror = () => { this.status = 'failed'; this.worker = null; for (const p of this.pending.values()) p.reject(); this.pending.clear(); this.onStatus(); };
    this.worker.onmessage = (ev: MessageEvent) => {
      const m = ev.data;
      if (m.type === 'progress') { this.depth = m.depth; this.onStatus(); }
      else if (m.type === 'ready') { this.status = 'ready'; this.onStatus(); }
      else { const p = this.pending.get(m.id); if (!p) return; this.pending.delete(m.id); p.resolve(m); }
    };
    this.worker.postMessage({ type: 'init', perm: EDGE_MOVES.map((t) => t.perm), flip: EDGE_MOVES.map((t) => t.flip), home: CROSS_HOME });
    return true;
  }

  private ask<T>(msg: Record<string, unknown>): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.ensure()) return reject();
      const id = ++this.nextId;
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker!.postMessage({ ...msg, id });
    });
  }

  /** Every optimal EOCross solution of a state (the list capped at 3000; `count` is exact). */
  async solve(st: EdgeState): Promise<SolutionSet> {
    const m = await this.ask<{ length: number; count: number; truncated: boolean; solutions: number[][] }>({ type: 'solve', eo: st.eo, slots: st.slots, cap: 3000 });
    return { length: m.length, count: m.count, truncated: m.truncated, solutions: m.solutions.map((s) => s.map((i) => FACE_MOVES[i])) };
  }

  /** EOCross distances of many states at once. */
  async dists(items: EdgeState[]): Promise<number[]> {
    const m = await this.ask<{ ds: number[] }>({ type: 'dists', items });
    return m.ds;
  }

  /** What to say while there is no answer yet. */
  note(): string {
    if (this.status === 'failed') return 'The EOCross solver could not start (eocross-worker.js is missing).';
    if (this.status === 'ready') return 'Solving…';
    return `Building the EOCross table (${this.depth}/10)…`;
  }
}

/** What the shortest EOs of a scramble leave behind: the best EOCross total any of them can reach. */
export interface EoOutlook { best: number; good: number; n: number; example: Move[] }

export async function eoOutlook(client: EOCrossClient, start: EdgeState, eo: SolutionSet, xLength: number): Promise<EoOutlook> {
  const ds = await client.dists(eo.solutions.map((s) => applyMoves(start, s)));
  const totals = ds.map((d) => eo.length + d);
  const best = Math.min(...totals);
  return { best, good: totals.filter((t) => t === xLength).length, n: eo.solutions.length, example: eo.solutions[totals.indexOf(best)] };
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const count = <T,>(arr: T[]): [T, number][] => {
  const h = new Map<T, number>();
  for (const v of arr) h.set(v, (h.get(v) ?? 0) + 1);
  return [...h.entries()].sort((a, b) => b[1] - a[1]);
};

export const STRATEGY_SHORT = 'Plan the EO with the white edges in view. EO is finished by the last F/B quarter turn; everything before it is setup, so use it to place white edges. Most often that last turn also drops in the final cross edge (three home, the fourth on that face’s side), otherwise one or two cross moves follow it. A one-move-longer EO that sets the cross up usually beats the shortest EO.';

/** What THIS scramble's optimal EOCross solutions do, as HTML bullets (docs/eocross-patterns.md has the averages). */
export function caseStrategy(start: EdgeState, eo: SolutionSet, x: SolutionSet, outlook: EoOutlook | null): string {
  const e = eo.length, L = x.length;
  const stats = x.solutions.map((s) => ({ s, ...solutionShape(start, s) }));
  const li: string[] = [];
  li.push(`<b>Optimal EO is ${e} moves; optimal EOCross is ${L}</b> (${plural(x.count, 'solution')}).`);
  if (outlook) {
    if (outlook.best > L) li.push(`Any ${e}-move EO leaves at least a ${outlook.best - e}-move cross: ${outlook.best} in all. The ${L}-move solutions spend more on EO to save more on the cross.`);
    else li.push(`${outlook.good} of the ${plural(outlook.n, 'shortest EO')} lead to an optimal EOCross (e.g. ${esc(movesStr(outlook.example))}); the others leave a longer cross.`);
  }
  const eoLens = count(stats.map((t) => t.eoLen));
  const lensTxt = eoLens.map(([v, c]) => `${v}${eoLens.length > 1 ? ` (${c})` : ''}`).join(' or ');
  const lo = Math.min(...eoLens.map((x) => x[0])) - e, hi = Math.max(...eoLens.map((x) => x[0])) - e;
  const extraTxt = hi <= 0 ? 'a shortest EO' : `${lo === hi ? lo : `${lo}–${hi}`} more than the shortest EO`;
  const tails = count(stats.map((t) => movesStr(t.tail)));
  const tailTxt = tails.map(([v, c]) => (v || 'nothing') + (tails.length > 1 ? ` (${c})` : '')).join(' · ');
  const dOnly = stats.every((t) => t.tail.length === 1 && t.tail[0].face === 'D' && t.atEO === 0);
  li.push(`EO is finished after ${lensTxt} moves (${extraTxt}), then ${tails.length === 1 && !tails[0][0] ? 'nothing: the last F/B turn completes the cross.' : `these cross moves: ${esc(tailTxt)}${dOnly ? ' – the cross is already built, just turned; the D aligns it.' : '.'}`}`);
  const ins = stats.filter((t) => t.atEO > t.before).length, home = count(stats.map((t) => t.atEO));
  li.push(`When EO is done, ${home.map(([v, c]) => `${v}/4${home.length > 1 ? ` (${c})` : ''}`).join(' or ')} white edges are home${ins ? `; the last F/B turn itself drops one in (${ins === stats.length ? 'every solution' : `${ins} of ${stats.length}`})` : ''}.`);
  const ex = stats[0];
  const k = lastEoTurn(ex.s);
  li.push(`For example: <span style="word-spacing:.3em">${esc(movesStr(ex.s.slice(0, k + 1)))}${ex.tail.length ? ` <b>|</b> ${esc(ex.tail.map(moveStr).join(' '))}` : ''}</span> - EO, then the cross.`);
  return `<ul>${li.map((x) => `<li>${x}</li>`).join('')}</ul>`;
}
