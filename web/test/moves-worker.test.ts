// The solve worker's move-tracking protocol, driven the way the page
// drives it: appends per sampled frame, `track` at the lock, `moves` polls
// - the live path of the reader, on the synthetic solve.
import { describe, expect, it } from 'vitest';
import Cube from 'cubejs';
import { handle, type MovesResult, type SolverResponse } from '../src/colour/solve.worker';
import { solve } from '../src/colour/solve';
import { commitmentsFrom } from '../src/moves/anchor';
import { applySeq, parseAlg } from '../src/moves/moves';
import { formatAlg, recordMoves } from '../src/moves/record';
import { CORNER_VIEWS, simulate, simulateFrames, type FrameSpec } from './synth';

const START = new Cube().move("F2 D2 L2 D2 U2 R2 U2 B' L2 B F2 U2 L' F D U B L2 B2 D").asString();

describe('solve worker: move tracking', () => {
  it('reads the turns frame by frame as the page appends them', () => {
    const commit = commitmentsFrom(solve(simulate(START, { seed: 5, frames: 40 }).log))!;
    const moves = parseAlg("R U R' U' F2 D L");
    const specs: FrameSpec[] = [];
    let state = START;
    let t = 1000;
    const push = (n: number, garbage = false) => { for (let i = 0; i < n; i++) { t += 125; specs.push({ state, view: CORNER_VIEWS[0]!, t, garbage, fingers: i % 3 }); } };
    push(4);
    for (const m of moves) { push(1, true); state = applySeq(state, [m]); push(4); }
    const { log } = simulateFrames(specs, { seed: 3, reacquireEvery: 0 });
    const out: SolverResponse[] = [];
    const post = (o: SolverResponse) => out.push(o);
    handle({ type: 'reset' }, post);
    handle({ type: 'track', commit, fromT: 1000 }, post);
    // one append per frame, a poll every few frames
    const byFrame = new Map<number, typeof log.quads>();
    for (const q of log.quads) { if (!byFrame.has(q.frame)) byFrame.set(q.frame, []); byFrame.get(q.frame)!.push(q); }
    let id = 1;
    const seen: string[] = [];
    for (const [frame, quads] of byFrame) {
      handle({ type: 'append', quads, pairings: log.pairings.filter((p) => p.frame === frame), events: [], frames: frame + 1 }, post);
      if (frame % 5 === 4) {
        handle({ type: 'moves', id: id++ }, post);
        const r = (out[out.length - 1] as { result: MovesResult | null }).result!;
        seen.push(`${frame}: ${formatAlg(r.record)} | committed ${r.committed.join(' ')}`);
      }
    }
    handle({ type: 'moves', id }, post);
    const r = (out[out.length - 1] as { result: MovesResult | null }).result!;
    console.log(seen.join('\n'));
    console.log(`final ${formatAlg(r.record)} · ${r.frames} frames · ${(r.msPerFrame + r.anchorMsPerFrame).toFixed(2)} ms/frame`);
    expect(recordMoves(r.record)).toEqual(moves);
    expect(r.committed).toEqual(moves.slice(0, r.committed.length));
    expect(r.committed.length).toBeGreaterThanOrEqual(moves.length - 1);
    expect(r.msPerFrame + r.anchorMsPerFrame).toBeLessThan(8);
  });
});
