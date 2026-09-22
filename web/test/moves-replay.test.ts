// The move reader on recorded solves (design 5.3): every fixture under
// fixtures/solves/ (tools/solve/moves_fixture.py) is read from its lock;
// the per-frame trace and the record are printed, the decode is timed, and
// when the fixture carries a truth the record must reach the end state and
// match the moves up to commuting order and double-turn spelling ("U U" is
// U2). A fixture's truth is the cubejs solution the app displayed, so a
// slipped move in the real solve shows up here as a disagreement to
// investigate, not necessarily a reader bug.
//
// A fixture marked `hard` (why, in the field) is printed and timed but not
// asserted: the two dim-room recordings of 2026-09-14 show one lit face and
// hands over the rest, which no reader can turn into a full sequence
// (docs/solve-tracking-design.md 1: one face is useless).
//
// Diagnostics per fixture, all printed:
// - free / pinned record (the pinned one ends in the known end state when
//   any path in the beam does);
// - the frame trace and the items with their windows and certificates;
// - forced alignment of the truth: the best timing of the truth sequence
//   over the frames, then per frame whether the truth beats every
//   single-move neighbour (wins / ties / losses). Many losses = the
//   frames do not support the truth as read - the anchoring, the truth,
//   or the timing is wrong there; the rows show which face and what
//   neighbour fits instead.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BENCH } from './helpers';
import type { EvidenceLog } from '../src/colour/types';
import { quadCost, type Commitments } from '../src/moves/anchor';
import { applyMoveIdx, applySeq, commute, faceOf, MOVES, parseAlg, type Move } from '../src/moves/moves';
import { formatAlg, formatItems, recordMoves } from '../src/moves/record';
import { forcedAlignment, formatTrace, readMoves } from '../src/moves/reader';
import { FACE_ORDER } from '../src/types';
import { reweight } from './evidence';

interface SolveFixture {
  version?: number;
  source: { live: string; log: string | null; model: string | null; recording: string | null };
  note: string;
  hard?: string | null;
  start: string;
  end: string | null;
  truth: string | null;
  fromT: number;
  commitments: Commitments;
  evidenceLog: EvidenceLog;
}

/** Consecutive turns of one face merged ("U U" -> U2, "R2 R" -> R', "U U'" -> nothing), then commuting neighbours in URFDLB face order. */
export function canonicalMoves(moves: readonly Move[]): Move[] {
  const out: Move[] = [];
  const turns = (m: Move): number => (m.endsWith('2') ? 2 : m.endsWith("'") ? 3 : 1);
  for (const m of moves) {
    const last = out[out.length - 1];
    if (last && faceOf(last) === faceOf(m)) {
      const n = (turns(last) + turns(m)) % 4;
      out.pop();
      if (n) out.push((n === 1 ? last[0] : n === 2 ? `${last[0]}2` : `${last[0]}'`) as Move);
      continue;
    }
    out.push(m);
  }
  for (let pass = 0; pass < out.length; pass++) {
    for (let i = 1; i < out.length; i++) {
      if (commute(out[i - 1]!, out[i]!) && faceOf(out[i - 1]!) > faceOf(out[i]!)) [out[i - 1], out[i]] = [out[i]!, out[i - 1]!];
    }
  }
  return out;
}

describe('recorded solves', () => {
  const dir = new URL('./fixtures/solves/', import.meta.url);
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : [];
  it('lists the fixtures', () => { console.log(`solve fixtures: ${files.length ? files.join(', ') : 'none yet'}`); });
  for (const file of files) {
    it(file, { timeout: 120000 }, () => {
      const d = JSON.parse(readFileSync(new URL(file, dir), 'utf8')) as SolveFixture;
      reweight(d.evidenceLog, d.version);
      const truth = d.truth ? parseAlg(d.truth) : null;
      const end = d.end ?? (truth ? applySeq(d.start, truth) : undefined);
      // unconstrained first: what the reader says on its own...
      const free = readMoves(d.evidenceLog, d.commitments, { fromT: d.fromT });
      // ...then with the known end state, the offline decoder's prerogative
      const pinned = end ? readMoves(d.evidenceLog, d.commitments, { fromT: d.fromT, end }) : free;
      const r = pinned.reader;
      const frames = r.frames.length;
      const lines = [
        `\n${file}: ${d.note}${d.hard ? `\nHARD (not asserted): ${d.hard}` : ''}`,
        `${d.source.model ?? ''} ${d.source.log ?? d.source.live}: ${frames} frames over ${(((r.frames[frames - 1]?.t ?? 0) - (r.frames[0]?.t ?? 0)) / 1000).toFixed(0)} s, ${d.evidenceLog.quads.length} quads`,
        `truth   ${d.truth ?? '(none)'}`,
        `free    ${formatAlg(free.record)}  -> ${free.record.end === end ? 'reaches the end state' : 'does NOT reach the end state'} (margin ${free.record.margin.toFixed(1)})`,
      ];
      if (end) lines.push(`pinned  ${formatAlg(pinned.record)}  -> ${pinned.record.endMatches ? 'end state in the beam' : 'end state NOT in the beam'}`);
      lines.push(formatTrace(r.trace, { from: d.fromT }), formatItems(pinned.record, d.fromT));
      lines.push(`anchor ${pinned.anchorMs.toFixed(0)} ms, decode ${r.ms.toFixed(0)} ms (${(r.ms / Math.max(1, frames)).toFixed(2)} ms/frame)`);
      if (truth) {
        // the forced alignment of the truth against every single-move
        // neighbour is a diagnostic (npm run bench): printed, never asserted
        if (BENCH) {
          const fa = forcedAlignment(r.frames, d.start, truth);
          let wins = 0, ties = 0, losses = 0;
          const rows: string[] = [];
          let prev = 0;
          r.frames.forEach((f, i) => {
            const k = fa.at[i]!;
            const st = fa.states[k]!;
            let tc = 0;
            for (const q of f.quads) tc += quadCost(st, q).cost;
            let alt = Infinity;
            let altM = '';
            for (const m of MOVES) {
              let c = 0;
              const s2 = applyMoveIdx(st, m);
              for (const q of f.quads) c += quadCost(s2, q).cost;
              if (c < alt) { alt = c; altM = m; }
            }
            if (alt - tc > 0.5) wins++; else if (tc - alt > 0.5) losses++; else ties++;
            const parts = f.quads.map((q) => { const c = quadCost(st, q); return `${FACE_ORDER[q.face]}${c.k} c${c.cost.toFixed(1)}`; });
            rows.push(`${((f.t - d.fromT) / 1000).toFixed(2).padStart(7)} s${String(k).padStart(2)}${k !== prev ? ` ** ${truth.slice(prev, k).join(' ')}` : '   '} ${(alt - tc).toFixed(1).padStart(6)} ${altM.padEnd(3)} ${parts.join(' | ')}`);
            prev = k;
          });
          lines.push(`forced alignment of the truth: cost ${fa.cost.toFixed(1)}; per frame the truth beats every single-move neighbour ${wins}x, ties ${ties}x, loses ${losses}x`, '      t  state  truth-vs-best-neighbour  faces', ...rows);
        }
        const got = canonicalMoves(recordMoves(pinned.record));
        const want = canonicalMoves(truth);
        const agree = got.filter((m, i) => m === want[i]).length;
        lines.push(`agreement ${agree}/${want.length} (read ${got.length})`);
        console.log(lines.join('\n'));
        if (!d.hard) {
          expect(pinned.record.end).toBe(end);
          expect(got).toEqual(want);
        }
      } else {
        console.log(lines.join('\n'));
      }
      expect(frames).toBeGreaterThan(0);
      // a throughput budget, not a correctness check: only under npm run bench
      if (BENCH) expect(r.ms / Math.max(1, frames)).toBeLessThan(10);
    });
  }
});
