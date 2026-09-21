// Fingertricks for a move sequence: the scramble, a listed solution, or the
// moves typed. `annotate` is pure (tested): it walks the tokens, matches the
// common triggers first (sexy move, sledgehammer, an R U R' insert...) so
// they read as one unit, then names each remaining move's finger and, from
// the neighbouring moves, whether a regrip is needed. `openFingertricks`
// renders that into the tricks sheet in index.html.
//
// Every description says what the layer DOES ("the front of the right layer
// rises") before which finger does it, so a cuber with another style can
// still check it against the cube. Right-handed, standard grip: right thumb
// on the front, fingers on the back; the left hand mirrored.

import { tokens } from '../cube/alg';
import { closeSheet, openSheet } from '../shell';

export interface TrickRow {
  /** the tokens this row covers, in order */
  moves: string[];
  /** a trigger's name, when the row is one */
  name?: string;
  /** the short label a named trigger gets on an alg line ("sexy", "sledge"); unset for a trigger named by its moves */
  label?: string;
  /** the finger and the motion */
  how: string;
  /** a grip / regrip note from the context, when there is one */
  tip?: string;
}

// ---- single moves: what happens, then the usual finger ----
const MOVE: Record<string, string> = {
  U: 'Top layer, front edge goes left. Left index flick: rest it on the front-left of the top layer and push away from you. Or the right index, hooked over the back-right corner, pulling toward you.',
  "U'": 'Top layer, front edge goes right. Right index flick: rest it on the front-right of the top layer and push away from you.',
  U2: 'Top layer half turn. Double flick: right index then middle finger in one motion, or two index flicks. Either direction, whichever finger is free.',
  R: 'Right layer, its front rises. Right wrist: thumb on the front, fingers on the back, roll the wrist up.',
  "R'": 'Right layer, its front goes down. Right wrist rolls down.',
  R2: 'Right layer half turn. Two wrist turns, or a wrist turn plus a ring-finger push from the back to save the regrip.',
  L: 'Left layer, its front goes down. Left wrist rolls down.',
  "L'": 'Left layer, its front rises. Left wrist rolls up.',
  L2: 'Left layer half turn. Two left wrist turns, or wrist plus a left ring-finger push.',
  F: 'Front layer, its right side goes down. Right thumb on the right edge of the front layer pushing down; or the left index on the top edge pushing right.',
  "F'": 'Front layer, its top goes left. Right index over the top edge of the front layer pulling left; or the right thumb on the bottom edge pushing right.',
  F2: 'Front layer half turn. Thumb push then index pull, or move the left hand onto the front and turn it like a wrist move.',
  D: 'Bottom layer, its front goes right. Left ring finger under the back-left of the bottom layer pulling toward you; or the right ring finger pushing the front-right of the bottom layer back.',
  "D'": 'Bottom layer, its front goes left. Right ring finger under the back-right of the bottom layer pulling toward you.',
  D2: 'Bottom layer half turn. Two ring-finger pulls (right then left), or ring then little finger on one hand.',
  B: 'Back layer, its top goes left (seen from the front). Right index over the top-back edge pushing left, or regrip and turn it with the left hand from above.',
  "B'": 'Back layer, its top goes right. Left index over the top-back edge pushing right, or regrip.',
  B2: 'Back layer half turn. Two index pushes from the top, or regrip: in a scramble it is fine to take it from above with both hands.',
  M: 'Middle slice, same way as L: its front goes down, its back rises. Right ring or middle finger on the back of the slice pushing up. Awkward - M\' is the easy one.',
  "M'": 'Middle slice, same way as R: its front rises, its back goes down. Right ring finger on the back of the slice flicking down.',
  M2: 'Middle slice half turn. Ring finger then middle finger flicking the back of the slice down, one motion.',
  E: 'Middle layer, same way as D. Rare: regrip, or do it as a rotation plus a face turn.',
  "E'": 'Middle layer, same way as D\'. Rare: regrip.',
  E2: 'Middle layer half turn. Rare: regrip.',
  S: 'Middle slice between front and back, same way as F. Rare: regrip.',
  "S'": 'Middle slice, same way as F\'. Rare: regrip.',
  S2: 'Middle slice half turn. Rare: regrip.',
  x: 'Whole cube rolls up like R, both hands. A regrip.',
  "x'": 'Whole cube rolls down like R\'. A regrip.',
  x2: 'Whole cube upside down. A regrip.',
  y: 'Whole cube turns like U: the front goes left. Both hands, a regrip.',
  "y'": 'Whole cube turns like U\': the front goes right. A regrip.',
  y2: 'Whole cube turned to face the back. A regrip.',
  z: 'Whole cube turns like F. A regrip.',
  "z'": 'Whole cube turns like F\'. A regrip.',
  z2: 'Whole cube rolled onto its top. A regrip.',
};
// wide moves: the face turn taking the middle slice with it - same finger, thumb over two layers
const WIDE: Record<string, string> = { r: 'R', l: 'L', u: 'U', d: 'D', f: 'F', b: 'B' };

// ---- triggers, longest first ----
const TRIGGERS: { moves: string; name: string; label?: string; how: string }[] = [
  { moves: "R U R' U'", name: 'Sexy move', label: 'sexy', how: 'One unit, no regrip: wrist up, U with the left index (or the right index pulling), wrist down, U\' with the right index flick.' },
  { moves: "U R U' R'", name: 'Inverse sexy', label: 'inverse sexy', how: 'One unit: U left index, wrist up, U\' right index flick, wrist down.' },
  { moves: "R' U' R U", name: 'Reverse sexy', label: 'reverse sexy', how: 'One unit: wrist down, U\' right index flick, wrist up, U left index.' },
  { moves: "U' R' U R", name: 'Inverse reverse sexy', label: 'inv. reverse sexy', how: 'One unit: U\' right index, wrist down, U left index, wrist up.' },
  { moves: "L' U' L U", name: 'Left sexy', label: 'left sexy', how: 'The mirror: left wrist up, U\' with the right index, left wrist down, U with the left index.' },
  { moves: "R' F R F'", name: 'Sledgehammer', label: 'sledge', how: 'Right wrist down, F with the left index pushing the top edge right, wrist up, F\' with the right index pulling the top edge left. No regrip if the thumb stays on the front.' },
  { moves: "r' F r F'", name: 'Wide sledgehammer', label: 'wide sledge', how: 'Sledgehammer with the thumb over two layers: right wrist down taking the middle slice along, F left index, wrist up, F\' right index.' },
  { moves: "F R' F' R", name: 'Hedgeslammer', label: 'hedge', how: 'Sledgehammer backwards: F left index, wrist down, F\' right index, wrist up.' },
  { moves: "R U2 R'", name: 'R U2 R\'', how: 'Wrist up, double flick, wrist down - keep the right hand on the layer throughout.' },
  { moves: "R U R'", name: 'R U R\'', how: 'Wrist up, U with the left index, wrist down. The right hand never leaves the layer.' },
  { moves: "R U' R'", name: 'R U\' R\'', how: 'Wrist up, U\' with the right index flick, wrist down.' },
  { moves: "R' U R", name: 'R\' U R', how: 'Wrist down, U with the left index, wrist up.' },
  { moves: "R' U' R", name: 'R\' U\' R', how: 'Wrist down, U\' with the right index, wrist up.' },
  { moves: "L' U L", name: 'L\' U L', how: 'Left wrist up, U with the left index, left wrist down.' },
  { moves: "L' U' L", name: 'L\' U\' L', how: 'Left wrist up, U\' with the right index, left wrist down.' },
  { moves: "L U' L'", name: 'L U\' L\'', how: 'Left wrist down, U\' with the right index, left wrist up.' },
  { moves: "L U L'", name: 'L U L\'', how: 'Left wrist down, U with the left index, left wrist up.' },
  { moves: 'M2 U M2', name: 'M2 U M2', how: 'Double ring flick, U with the left index (the right hand stays behind the cube), double ring flick.' },
  { moves: "M2 U' M2", name: 'M2 U\' M2', how: 'Double ring flick, U\' with the right index from above, double ring flick.' },
];
const TRIGGER_TOKENS = TRIGGERS.map((t) => ({ ...t, toks: tokens(t.moves) }));

const OPPOSITE: Record<string, string> = { U: 'D', D: 'U', R: 'L', L: 'R', F: 'B', B: 'F' };
const face = (t: string): string => t[0]!.toUpperCase();
const isTurn = (t: string): boolean => /^[URFDLB]/.test(t);

/** The rows of the sheet for `alg`. Throws on a token the parser cannot read. */
export function annotate(alg: string): TrickRow[] {
  const toks = tokens(alg);
  const rows: TrickRow[] = [];
  let i = 0;
  while (i < toks.length) {
    const trig = TRIGGER_TOKENS.find((t) => t.toks.every((m, k) => toks[i + k] === m));
    if (trig) {
      rows.push({ moves: trig.toks.slice(), name: trig.name, how: trig.how, ...(trig.label && { label: trig.label }) });
      i += trig.toks.length;
      continue;
    }
    const t = toks[i]!;
    const next = toks[i + 1];
    // a pair of opposite faces: both hands at once, the order does not matter
    if (isTurn(t) && next && isTurn(next) && OPPOSITE[face(t)] === face(next) && !t.startsWith(t[0]!.toLowerCase())) {
      rows.push({ moves: [t, next], name: 'Both hands', how: `${describe(t)} ${describe(next)}`, tip: 'Opposite layers: turn both at the same time, one hand each. The order never matters.' });
      i += 2;
      continue;
    }
    rows.push({ moves: [t], how: describe(t), tip: tip(t, toks[i - 1]) });
    i++;
  }
  return rows;
}

// ---- chunks: the longer blocks the PLL algs share, labelled on alg lines over the finger-level triggers ----
// (2026-09-21, user: the same sequences keep coming round). The longest match anywhere wins, then the next
// longest that does not overlap; the triggers fill what they leave. The sheet's rows stay finger by finger:
// a chunk is a reading aid, not a fingering. "Y [X] Y'" is X conjugated by Y: Y, then X, then Y undone - the
// notation says which move comes first (user, 2026-09-21: "under D" did not); "[A, B]" is a commutator.
const CHUNKS: { moves: string; label: string }[] = [
  { moves: "R U R' U' R' F R2 U' R'", label: 'T core' },           // the middle of the T perm: in T, Jb, F and Na
  { moves: "F R U' R' U' R U R' F'", label: "F [R U' R' U' R U R'] F'" },        // Y's first half: R U' R', U', R U R' inside F ... F' (an OLL alg on its own)
  { moves: "F R U R' U' R' F'", label: "F [sexy R'] F'" },             // Rb's second half
  { moves: "F' R2 U' R' U R' F", label: "F' [R2 U' R' U R'] F" },     // V's middle
  { moves: "R' F' U' F R", label: "R' [F' U' F] R" },                 // Nb: the F insert wrapped in R' ... R
  { moves: "R' F R' F' R", label: "R' [F R' F'] R" },                 // Nb: and its partner
  // the commutators, named (user, 2026-09-21: the notation read aloud is no help; none has a name in the wild -
  // speedsolving.com's list of named algorithms has Niklas, Sune, Bruno, Allan and the like, no PLL commutators).
  // A commutator [A, B] is A, B, A undone, B undone; a move merged into the alg's R2 / U2 is inside the chunk.
  { moves: "R U' R' D R U R' D'", label: "E half, U' first" },       // E perm, first half: [R U' R', D]
  { moves: "R U R' D R U' R' D'", label: 'E half, U first' },        // E perm, second half: [R U R', D]
  { moves: "R D R' U' R D' R' U2", label: 'R commutator' },          // Ra: [R D R', U'], its closing U and the U after are the U2
  { moves: "R' D' R U' R' D R U", label: "R commutator, D' version" }, // Rb's D version: [R' D' R, U']
  { moves: "U R' D2 R U' R' D2 R2", label: 'A commutator' },         // Aa: [U, R' D2 R], its closing R and the R after are the R2
  { moves: "R2 D2 R U R' D2 R U'", label: 'A commutator backwards' }, // Ab: R' then [R' D2 R, U], the R' and the R' merged into the R2
  { moves: "F R' B2 R F' R' B2 R2", label: 'A commutator, F B version' },  // Aa's F/B version: [F, R' B2 R]
  { moves: "B' R F2 R' B R F2 R2", label: 'A commutator backwards, F B version' }, // Ab's F/B version: [B', R F2 R']
  { moves: "L U' R U2 L' U R'", label: 'N half' },                   // Na's R/L alg is this twice
  { moves: "R' U L' U2 R U' L", label: 'N half' },                   // Nb's likewise
  { moves: "D R' U R D'", label: "D [R' U R] D'" },                 // Ga's ending
  { moves: "D' R U' R' D", label: "D' [R U' R'] D" },               // Gc's ending
];
const CHUNK_TOKENS = CHUNKS.map((c) => ({ ...c, toks: tokens(c.moves) }));

/**
 * The named blocks in `alg` by token position: where each starts, how many moves, its short label.
 * The shared chunks first (a T core, a commutator), then the finger-level triggers (sexy, sledge)
 * where no chunk is.
 */
export function triggers(alg: string): { at: number; n: number; label: string }[] {
  const toks = tokens(alg);
  const found: { at: number; n: number; label: string }[] = [];
  for (const c of CHUNK_TOKENS) for (let i = 0; i + c.toks.length <= toks.length; i++) if (c.toks.every((m, k) => toks[i + k] === m)) found.push({ at: i, n: c.toks.length, label: c.label });
  found.sort((a, b) => b.n - a.n || a.at - b.at);
  const out: { at: number; n: number; label: string }[] = [];
  const taken = new Array<boolean>(toks.length).fill(false);
  const free = (at: number, n: number) => !taken.slice(at, at + n).some(Boolean);
  for (const f of found) if (free(f.at, f.n)) { out.push(f); for (let k = 0; k < f.n; k++) taken[f.at + k] = true; }
  let at = 0;
  for (const r of annotate(alg)) {
    const n = r.moves.length;
    if (r.label && free(at, n)) out.push({ at, n, label: r.label });
    at += n;
  }
  return out.sort((a, b) => a.at - b.at);
}

/** The first sentence: what the layer does, no fingers ("Middle slice between front and back, same way as F"). */
export function moveWhat(t: string): string {
  return describe(t).split('. ')[0]!.replace(/\.$/, '');
}

function describe(t: string): string {
  const w = WIDE[t[0]!];
  if (w) {
    const base = MOVE[w + t.slice(1)]!;
    return `Wide: ${base.split('. ')[0]!.toLowerCase()} and the middle slice with it. Same finger as ${w + t.slice(1)}, thumb or finger over two layers.`;
  }
  const d = MOVE[t];
  if (!d) throw new Error(`no fingertrick for ${t}`);
  return d;
}

/** A regrip note from what came before. */
function tip(t: string, prev: string | undefined): string | undefined {
  if (!prev) return undefined;
  if (/^[xyz]/.test(t)) return 'Rotations cost as much as two moves: look for a version of the next moves that avoids it.';
  if (face(t) === face(prev)) return 'Same layer twice: write it as one move.';
  if (/^[FB]/.test(t) && /^[RLUD]/.test(prev)) return `After ${prev} the thumb has to move onto the ${face(t) === 'F' ? 'front' : 'back'} layer: a regrip. Plan it while the previous turn finishes.`;
  if (/^[RL]/.test(t) && /^[FB]/.test(prev)) return 'Back to a wrist grip after a front/back turn: another regrip.';
  if (/^[UD]/.test(t) && /^[RL]/.test(prev)) return 'Finger flick while the wrist hand keeps its grip: no regrip.';
  if (/^[RL]/.test(t) && /^[UD]/.test(prev)) return 'The wrist hand is already in place: no regrip.';
  return undefined;
}

// ---- the sheet ----
const STYLE = `
  .ft-alg { font-size: 18px; font-weight: 600; letter-spacing: .04em; margin: 0 0 4px; word-break: break-word; }
  .ft-hold { color: var(--ink-2); font-size: 13px; margin: 0 0 14px; }
  .ft-row { display: grid; grid-template-columns: 110px 1fr; gap: 4px 14px; padding: 10px 0; border-top: 1px solid var(--line); }
  .ft-mv { font-size: 17px; font-weight: 600; letter-spacing: .04em; }
  .ft-n { color: var(--ink-2); font-size: 12px; font-weight: 400; display: block; }
  .ft-name { font-weight: 600; }
  .ft-how { font-size: 14px; }
  .ft-tip { font-size: 13px; color: var(--ink-2); margin-top: 3px; }
  .ft-grip { font-size: 13px; color: var(--ink-2); margin: 0 0 8px; }
  @media (max-width: 480px) { .ft-row { grid-template-columns: 1fr; } }
`;

export interface TricksOptions {
  /** what the sequence is: "The scramble", "Your moves", a case name */
  title: string;
  /** how the cube is held for it */
  hold: string;
}

/** Open the fingertricks sheet on `alg`. Returns false (and toasts nothing) when the alg cannot be read. */
export function openFingertricks(alg: string, opts: TricksOptions): boolean {
  if (!document.getElementById('ft-style')) {
    const s = document.createElement('style'); s.id = 'ft-style'; s.textContent = STYLE; document.head.appendChild(s);
  }
  let rows: TrickRow[];
  try { rows = annotate(alg); } catch { return false; }
  const panel = document.getElementById('tricks-panel');
  const sub = document.querySelector<HTMLElement>('#tricks-sheet .zz-sheet-head .sub');
  if (!panel || !sub) throw new Error('index.html is missing the tricks sheet');
  sub.textContent = opts.title;
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  let n = 0;
  panel.innerHTML = `
    <p class="ft-alg">${esc(rows.map((r) => r.moves.join(' ')).join('  '))}</p>
    <p class="ft-hold">Held ${esc(opts.hold)}. ${rows.length} step${rows.length === 1 ? '' : 's'}, ${tokens(alg).length} moves.</p>
    <p class="ft-grip">Right-handed, standard grip: right thumb on the front, fingers on the back, the left hand mirrored. Each step says what the layer does first, then the usual finger - check it against the cube if your style differs.</p>
    ${rows.map((r) => {
      const from = n + 1; n += r.moves.length;
      const num = r.moves.length === 1 ? `${from}` : `${from}–${n}`;
      const name = r.name && r.name !== r.moves.join(' ') ? r.name : ''; // a trigger named by its moves is already on the left
      return `<div class="ft-row"><div class="ft-mv">${esc(r.moves.join(' '))}<span class="ft-n">move${r.moves.length === 1 ? '' : 's'} ${num}</span></div>
        <div>${name ? `<div class="ft-name">${esc(name)}</div>` : ''}<div class="ft-how">${esc(r.how)}</div>${r.tip ? `<div class="ft-tip">${esc(r.tip)}</div>` : ''}</div></div>`;
    }).join('')}`;
  openSheet('tricks-sheet');
  return true;
}

export function closeFingertricks(): void { closeSheet('tricks-sheet'); }
