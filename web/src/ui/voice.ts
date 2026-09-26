// The voice: speech synthesis for the drills and the Solve tab, and the
// scramble voice they share (user, 2026-09-25: the Solve tab wants what
// the PLL drill has) - a mode per set of moves (nothing, the next move
// read, the moves made echoed, only a wrong turn called), the wrong turn
// called with its undo after a short hold, "back on", "scrambled". Every
// voice is quiet while the smart cube's follow carries a timed solve
// from the Solve tab through the drill tabs (shell.carriedSolve): the
// drill the tabs land on is not being drilled.

import { faceMoves, inverse, mergeMoves, movesStr, tokens } from '../cube/alg';
import { carriedSolve } from '../shell';
import type { TrackStatus } from '../timer/track';
import { shownIndex } from '../timer/track-ui';

/** What the voice does with a set of moves. Every mode but 'off' calls a wrong turn. */
export type Mode = 'off' | 'read' | 'echo' | 'watch';
export const MODE_LABEL: Record<Mode, string> = {
  off: 'nothing',
  read: 'reads me the next move',
  echo: 'says the moves I make',
  watch: 'only when I go wrong',
};
export const MODES = Object.keys(MODE_LABEL) as Mode[];

// what the voice says for a move: the letter, then prime / two; a wide move and a rotation by name
const SPOKEN: Record<string, string> = { x: 'x', y: 'y', z: 'z', M: 'M', E: 'E', S: 'S' };
export function spoken(m: string): string {
  const base = m[0]!, suf = m.slice(1);
  const name = SPOKEN[base] ?? (base === base.toLowerCase() ? `wide ${base.toUpperCase()}` : base);
  return `${name}${suf === "'" ? ' prime' : suf === '2' ? ' two' : ''}`;
}

/**
 * Speak; `keep` queues it after what is being said instead of cutting that off; `then` runs once it
 * has been said (or after `thenBy` ms if the browser never says so). Nothing is said while a timed
 * solve is being carried through the tabs, but `then` still runs.
 */
export function say(text: string, keep = false, then?: () => void, thenBy = 8000): void {
  if (typeof speechSynthesis === 'undefined' || carriedSolve()) { then?.(); return; }
  if (!keep) speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.2; u.lang = 'en-US';
  if (then) {
    let fired = false;
    const once = () => { if (fired) return; fired = true; then(); };
    u.onend = once; u.onerror = once;
    setTimeout(once, thenBy);
  }
  speechSynthesis.speak(u);
}

/** Wrong turns as a list to undo: same-face turns merged (R F F' is just R), so an undo shortens it. */
export function offList(turns: readonly string[]): string[] {
  const fm = faceMoves(turns.join(' '));
  return fm ? movesStr(mergeMoves(fm)).split(' ').filter(Boolean) : turns.slice();
}

// DECISION: a wrong turn is called this long after it, not at once (user, 2026-09-23): the cube reports a
// slice as its two outer layers, a few ms apart, and the state between them is off the route - a turn that
// lands back on it inside this window was never wrong. A hand's two separate turns are far slower than this.
export const OFF_HOLD_MS = 300;

export interface ScrambleVoiceConfig {
  mode(): Mode;
  /** the scramble as shown and read: its tokens, and how many moves each covers when one covers two (an M2) */
  shown(): { toks: string[]; spans?: number[] };
  /** a trainer-frame alg in the letters the scramble is shown in */
  wca(alg: string): string;
  /** the speaker (the real one unless a test listens) */
  say?: (text: string, keep?: boolean) => void;
}

/**
 * The scramble out loud while it is being applied, from the tracker's status after each cube report:
 * the next move (read), the move made (echo), a wrong turn with the turns to undo (every mode but off,
 * after the hold), "back on", and "scrambled" once at the end. `armed` (the cube is at the scramble
 * and the solve is under way) silences it: those turns are the solve. `queue` puts a read behind
 * what is being said (a fresh scramble's first move, after the "scramble" cue).
 */
export class ScrambleVoice {
  private offTurns: string[] = [];   // the turns made since the cube left the scramble path, trainer letters
  private read: string | null = null; // the last thing said, so a re-render does not repeat it
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly cfg: ScrambleVoiceConfig) {}
  private speak(text: string, keep = false): void { (this.cfg.say ?? say)(text, keep); }
  /** The line under the scramble when the cube is off it and the turns since are known: their undo. */
  offText(): string | undefined {
    return this.offTurns.length ? `Off the scramble after ${this.cfg.wca(this.offTurns.join(' '))}: undo with ${this.cfg.wca(inverse(this.offTurns.join(' ')))}` : undefined;
  }
  /** A fresh scramble (or the cube armed on it): nothing pending, nothing read. */
  reset(): void { clearTimeout(this.timer); this.timer = undefined; this.offTurns = []; this.read = null; }
  update(was: TrackStatus | null, track: TrackStatus | null, turn: string | undefined, armed: boolean, queue = false): void {
    const mode = this.cfg.mode();
    if (track?.off && !armed) {
      if (turn) {
        const before = this.offTurns.length;
        this.offTurns = offList([...this.offTurns, turn]);
        // the scramble is read in the letters it is shown in, so is its undo; an undoing turn gets the rest to undo, not "wrong"
        const words = `${this.offTurns.length < before ? 'undo' : 'wrong. undo'} ${tokens(this.cfg.wca(inverse(this.offTurns.join(' ')))).map(spoken).join(', ')}`;
        clearTimeout(this.timer);
        if (mode !== 'off') this.timer = setTimeout(() => this.speak(words), OFF_HOLD_MS);
      }
    } else if (was?.off && !track?.off) { clearTimeout(this.timer); this.offTurns = []; if (mode !== 'off' && track && !track.matched) this.speak('back on'); }
    else { clearTimeout(this.timer); this.offTurns = []; }
    if (mode === 'off' || mode === 'watch' || !track || armed) { this.read = null; return; }
    if (mode === 'echo') { if (turn && !track.off) this.speak(spoken(tokens(this.cfg.wca(turn))[0] ?? turn)); return; }
    if (track.matched) { if (this.read !== 'done') { this.read = 'done'; this.speak('scrambled'); } return; }
    if (track.off || track.half) return; // off it, or mid-double-turn: the rest of that turn is under way
    const { toks, spans } = this.cfg.shown();
    const next = toks[shownIndex(spans, track.applied)];
    if (!next || next === this.read) return;
    this.read = next;
    this.speak(spoken(next), queue);
  }
}
