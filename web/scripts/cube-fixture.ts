// A move-reader fixture from a recording session with the smart cube as the
// truth (docs/smart-cube-design.md 4.2, the `--truth cube` of
// tools/solve/moves_fixture.py): for one timed solve, the scanner's evidence
// over the solve's window, the cube's turns inside it with both clocks, the
// cube's state at the window's ends, and the reader's commitments fitted
// from the evidence alone - the palette by the colour solver, its colours
// named by hue and lettered by the standard scheme (the GAN's), the start
// state from the cube. No scan lock is needed: the cube says what the cube
// is, the evidence says what the colours look like.
//
//   npx vite-node scripts/cube-fixture.ts ../recordings/<session> [--solve N] [--lead 3] [--tail 1] [--note "..."] [--hard "why"]
//
// Writes test/fixtures/solves/<session>-NN.json (moves-replay.test.ts reads
// every file there). The evidence must cover the window: a session whose
// log was trimmed says so and is skipped.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { EvidenceLog } from '../src/colour/types';
import { letterOfName } from '../src/colour/naming';
import { solve } from '../src/colour/solve';
import type { Commitments } from '../src/moves/anchor';
import type { Move } from '../src/moves/moves';
import { Capture, type CaptureEvent } from '../src/smart/capture';
import { statusAfter } from '../src/smart/belief';
import { DEFAULT_SCHEME_NAMES, FACE_ORDER, type ColorName, type FaceId } from '../src/types';

interface SessionMeta { session: string; startedAt: number; t0: number; cube?: { name: string; protocol: string; scheme: Record<FaceId, ColorName> } }
interface SolveLine { id: string; when: number; t0: number; t1: number; scramble: string; time: number; moves?: { m: string; t: number }[] }

const args = process.argv.slice(2);
const opt = (name: string, dflt: string): string => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1]! : dflt; };
const dir = args.find((a) => !a.startsWith('--') && !args.includes(`--${a}`) && !/^\d+(\.\d+)?$/.test(a) && !args[args.indexOf(a) - 1]?.startsWith('--'));
if (!dir) { console.error('usage: npx vite-node scripts/cube-fixture.ts <session dir> [--solve N] [--lead S] [--tail S] [--note "..."]'); process.exit(2); }
const only = Number(opt('solve', '0'));
const LEAD = Number(opt('lead', '3')), TAIL = Number(opt('tail', '1'));
const note = opt('note', '');
const hard = opt('hard', '') || null; // why the reader is not expected to get this one yet: the test prints instead of asserting

const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as SessionMeta;
const solves = readFileSync(join(dir, 'solves.jsonl'), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as SolveLine);
const cap = Capture.parse(readFileSync(join(dir, 'cube.jsonl'), 'utf8'));
const evidence = JSON.parse(readFileSync(join(dir, 'evidence.json'), 'utf8')) as { version?: number; evidenceLog: EvidenceLog; model?: string };
const log = evidence.evidenceLog;

// the cube's letters must be the reader's: the reader letters its palette by the standard scheme
const scheme = meta.cube?.scheme ?? cap.header.scheme;
for (const f of FACE_ORDER) if (scheme[f] !== DEFAULT_SCHEME_NAMES[f]) { console.error(`the cube's ${f} is ${scheme[f]}, the reader's is ${DEFAULT_SCHEME_NAMES[f]}: relabelling is not implemented`); process.exit(1); }

/** host (performance.now) ms -> wall-clock ms, the evidence log's clock */
const wall = (t: number): number => meta.startedAt + (t - meta.t0);

// The cube's send time for each turn: the counter through a line fitted over the whole session - the
// slope only when it spans a minute (the cube drifts ~0.02%; BLE jitter swings a short fit by more),
// the offset from the lower envelope of the residuals (arrivals are only ever late). ClockFit's rule.
const turns = cap.events.filter((e): e is Extract<CaptureEvent, { kind: 'move' }> => e.kind === 'move');
const sendTime = (() => {
  const xs = turns.map((m) => m.tRaw ?? NaN), ys = turns.map((m) => m.t);
  if (xs.some(Number.isNaN) || xs.length < 2) return (m: typeof turns[number]) => m.t;
  const lo = Math.min(...xs), hi = Math.max(...xs);
  let b = 1;
  if (hi - lo >= 60_000) {
    const mx = xs.reduce((a, x) => a + x, 0) / xs.length, my = ys.reduce((a, y) => a + y, 0) / ys.length;
    let sxx = 0, sxy = 0;
    xs.forEach((x, i) => { sxx += (x - mx) ** 2; sxy += (x - mx) * (ys[i]! - my); });
    if (sxx > 0) b = sxy / sxx;
  }
  const r = xs.map((x, i) => ys[i]! - b * x).sort((p, q) => p - q);
  const a = r[xs.length < 10 ? 0 : Math.floor(xs.length * 0.1)]!;
  return (m: typeof turns[number]) => a + b * m.tRaw!;
})();

const outDir = resolve('test/fixtures/solves');
mkdirSync(outDir, { recursive: true });
const session = meta.session ?? basename(dir);
let written = 0;
solves.forEach((s, i) => {
  const n = i + 1;
  if (only && n !== only) return;
  const fromHost = s.t0 - LEAD * 1000, toHost = s.t1 + TAIL * 1000;
  const fromT = wall(fromHost), toT = wall(toHost);
  const stem = `${session}-${String(n).padStart(2, '0')}`;

  // the evidence inside the window
  const quads = log.quads.filter((q) => q.t >= fromT && q.t <= toT);
  const frames = new Set(quads.map((q) => q.frame));
  const covered = quads.length && log.quads[0]!.t <= fromT + 2000;
  if (!covered) { console.log(`${stem}: the evidence log does not cover the solve (${quads.length} quads in the window; the log starts ${((log.quads[0]?.t ?? Infinity) - fromT) / 1000 | 0} s after it): skipped`); return; }
  const slice: EvidenceLog = {
    ...log,
    quads,
    pairings: log.pairings.filter((p) => frames.has(p.frame)),
    events: log.events.filter((e) => e.t >= fromT && e.t <= toT),
  };

  // the cube: its state at the window's ends, and the turns inside it
  const before = cap.events.filter((e) => e.t <= fromHost);
  const start = statusAfter(before).belief;
  if (!start) { console.log(`${stem}: the cube had not reported before the window: skipped`); return; }
  const inside = turns.filter((m) => m.t > fromHost && m.t <= toHost);
  const end = statusAfter(cap.events.filter((e) => e.t <= toHost)).belief!;
  const truth = inside.map((m) => m.move as Move);
  const truthTimes = inside.map((m) => ({ t: wall(m.t), tSend: wall(sendTime(m)), tRaw: m.tRaw }));

  // the commitments from the evidence: the solver's palette, named by hue, lettered by the scheme
  const sol = solve(slice, { quick: true });
  const centres = sol.palette.centres;
  const names = sol.naming.names;
  const colourLetter: (FaceId | null)[] = centres.map((c, k) => (c && names[k] ? letterOfName(names[k] as ColorName) : null));
  const letters = colourLetter.filter((l): l is FaceId => !!l);
  if (letters.length !== 6 || new Set(letters).size !== 6) { console.log(`${stem}: the palette did not name six colours (${colourLetter.join(',')}): skipped`); return; }
  const commitments: Commitments = { start, embedding: sol.embedding as Commitments['embedding'], palette: { centres, sigma: sol.palette.sigma }, colourLetter };

  // an audit of the evidence: a quad most of whose cells read as skin is a hand, not a face
  const skin = (rgb: readonly number[]) => rgb[0]! - rgb[1]! > 25 && rgb[1]! - rgb[2]! > 0 && rgb[0]! < 215 && rgb[1]! < 150;
  const kinds = quads.map((q) => { const k = q.readings.filter((r) => skin(r.rgb)).length; return k >= 6 ? 'hand' : k <= 1 ? 'face' : 'mixed'; });
  const audit = { quads: quads.length, face: kinds.filter((k) => k === 'face').length, mixed: kinds.filter((k) => k === 'mixed').length, hand: kinds.filter((k) => k === 'hand').length, frames: frames.size, framesTwoFaces: 0 };
  { const byFrame = new Map<number, number>(); quads.forEach((q, i) => { if (kinds[i] === 'face') byFrame.set(q.frame, (byFrame.get(q.frame) ?? 0) + 1); }); audit.framesTwoFaces = [...byFrame.values()].filter((n) => n >= 2).length; }

  const fixture = {
    version: evidence.version ?? 2,
    source: { live: 'evidence.json', log: null, model: evidence.model ?? null, recording: `recordings/${session}` },
    truthSource: 'cube',
    note: note || `${session} solve ${n}: ${(s.time / 1000).toFixed(1)} s, ${inside.length} turns by the cube; the palette fitted from the evidence, no lock`,
    hard,
    start, end,
    truth: truth.join(' '),
    truthTimes,
    truthNote: "the smart cube's turns; t = BLE arrival, tSend = the cube's counter through the session's clock fit (both wall-clock ms like the evidence)",
    fromT, toT,
    solve: { id: s.id, scramble: s.scramble, time: s.time, t0: wall(s.t0), t1: wall(s.t1) },
    palette: { reason: sol.reason, lockable: sol.lockable, names },
    audit,
    commitments,
    evidenceLog: slice,
  };
  const file = join(outDir, `${stem}.json`);
  writeFileSync(file, JSON.stringify(fixture));
  written++;
  console.log(`${stem}: evidence audit - ${audit.face} face quads, ${audit.mixed} mixed, ${audit.hand} hand; ${audit.framesTwoFaces} of ${audit.frames} frames show two clean faces`);
  console.log(`${file}: ${quads.length} quads over ${((toT - fromT) / 1000).toFixed(0)} s (${frames.size} frames), ${truth.length} turns; palette ${names.join('/')} (${sol.reason}); start ${start.slice(0, 9)}… end ${end === 'UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBB' ? 'solved' : end.slice(0, 9) + '…'}`);
});
if (!written && !existsSync(join(dir, 'solves.jsonl'))) console.log('no solves.jsonl in the session');
