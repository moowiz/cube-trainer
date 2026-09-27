// The F2L tab's voice drill (user, 2026-09-27), two parts, each its own setting:
//   - ask: the mic stays open while a cube is being tracked; say a pair and what you would do for it ("front left
//     D conjugate", "back right case 17") and it says yes or no, with the answer. The cards and the alg panel keep a
//     pair's case hidden until it has been named (or given up on, or tapped), so the cube in hand is what you read.
//   - call: when the cube is at F2L and has come to rest, the open pairs whose case is one you picked (or every
//     case) are said out loud, each once per scramble: "front left D conjugate, front right keyhole".
// The words are callout.ts; the listening is ui/ear.ts; the speaking is ui/voice.ts.

import { stageOf } from '../stage';
import { canHear, listen } from '../ui/ear';
import { persisted } from '../ui/settings';
import { say } from '../ui/voice';
import { callText, heardF2L, judge, openCalls, TECH_NOTE, TECH_WORD, type PairCall } from './callout';
import { SLOT_WORD, type SlotName } from './model';
import { pickedTwins } from './pool';

type CallMode = 'off' | 'picked' | 'all';
interface VoiceSettings { ask: boolean; call: CallMode }
const { settings, save } = persisted<VoiceSettings>('zzf2l-voice', { ask: false, call: 'off' }, (s) => {
  s.ask = !!s.ask;
  if (!['off', 'picked', 'all'].includes(s.call)) s.call = 'off';
});

export interface F2LVoiceHost {
  /** the tracked cube (trainer frame) and its solved pairs, or null when nothing is tracked */
  cube(): { f: string; solved: ReadonlySet<SlotName>; turned?: boolean } | null;
  /** the tab is on screen and drilling (not a solve carried through it) */
  active(): boolean;
  /** something changed that the page shows (a pair named, the tally) */
  changed(): void;
}

// DECISION: the cube is at rest this long before its pairs are called: a pair is read between algs, not mid-turn
const REST_MS = 700;

export interface F2LVoice {
  /** the cube turned (or was read afresh): the ear and the caller catch up */
  update(): void;
  /** a new scramble: nothing named, nothing called */
  reset(): void;
  /** the pair's case (its front-right number) is hidden until named */
  hidden(slot: SlotName, n: number): boolean;
  reveal(slot: SlotName, n: number): void;
  /** the line under the pairs: listening, the tally, the last answer */
  line(): string;
}

export function mountF2LVoice(host: F2LVoiceHost): F2LVoice {
  const named = new Set<string>();   // `${slot}:${n}` named, given up on or tapped this scramble
  const called = new Set<string>();  // `${slot}:${n}` said by the caller this scramble
  let right = 0, asked = 0, last = '';
  let stopEar: (() => void) | null = null;
  let noMic = false;
  let rest: ReturnType<typeof setTimeout> | undefined;
  const key = (slot: SlotName, n: number) => `${slot}:${n}`;

  function heard(alts: string[]): void {
    const cube = host.cube();
    if (!cube) return;
    // the first guess that says anything the drill knows: the recogniser's alternatives disagree most on short words
    const h = alts.map(heardF2L).find((x) => x && (x.slot || x.giveUp)) ?? alts.map(heardF2L).find((x) => x);
    if (!h) return; // talk that is not an answer: the mic hears the room too
    const r = judge(h, cube.f, cube.solved);
    if (r.right !== null) { asked++; if (r.right) right++; }
    if (h.slot) {
      const c = openCalls(cube.f, cube.solved).find((x) => x.slot === h.slot);
      if (c && (r.right !== null || h.giveUp || (!h.tech && h.n === null))) named.add(key(c.slot, c.n));
    }
    last = `“${alts[0] ?? ''}”: ${r.say}`;
    say(r.say);
    host.changed();
  }
  function ear(): void {
    const want = settings.ask && host.active() && !!host.cube() && !noMic;
    if (want && !stopEar) {
      if (!canHear()) { noMic = true; host.changed(); return; }
      stopEar = listen({ alts: 5, heard, fatal: () => { stopEar = null; noMic = true; host.changed(); } });
    } else if (!want && stopEar) { const s = stopEar; stopEar = null; s(); }
  }
  function callNow(): void {
    if (settings.call === 'off' || !host.active()) return;
    const cube = host.cube();
    if (!cube || cube.turned) return; // the bottom layer turned: mid-alg
    const r = stageOf(cube.f);
    if (r.eoBad || r.cross < 4) return; // mid-alg, or EOCross still to do: the pairs are no cases yet
    const picked = settings.call === 'picked' ? pickedTwins() : null;
    const fresh = openCalls(cube.f, cube.solved).filter((c: PairCall) => (!picked || picked.has(String(c.n))) && !called.has(key(c.slot, c.n)));
    if (!fresh.length) return;
    for (const c of fresh) called.add(key(c.slot, c.n));
    say(fresh.map(callText).join(', '));
  }

  return {
    update(): void {
      ear();
      clearTimeout(rest);
      if (settings.call !== 'off') rest = setTimeout(callNow, REST_MS);
    },
    reset(): void { named.clear(); called.clear(); clearTimeout(rest); last = ''; },
    hidden: (slot, n) => settings.ask && !named.has(key(slot, n)),
    reveal: (slot, n) => { named.add(key(slot, n)); },
    line(): string {
      if (!settings.ask) return '';
      if (noMic) return 'Voice: no microphone or speech recognition here.';
      const tally = asked ? ` · ${right} of ${asked} right` : '';
      return `Voice: say a pair and what you'd do (“front left D conjugate”)${tally}${last ? ` · ${last}` : ''}`;
    },
  };
}

// ---- the settings rows (index.html's F2L section): Off / On, and Off / Picked / All ----

const listeners = new Set<() => void>();
export const onVoiceSettings = (l: () => void): void => { listeners.add(l); };
/** Wire the F2L settings' voice rows ([data-f2lvoice="ask" | "call"]) and fill the note of words. */
export function wireF2LVoiceRows(): void {
  const rows = [...document.querySelectorAll<HTMLElement>('[data-f2lvoice]')];
  const paint = () => rows.forEach((r) => r.querySelectorAll<HTMLElement>('button[data-v]').forEach((b) => {
    const v = r.dataset.f2lvoice === 'ask' ? (settings.ask ? 'on' : 'off') : settings.call;
    b.classList.toggle('on', b.dataset.v === v);
  }));
  for (const r of rows) r.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('button[data-v]');
    if (!b) return;
    if (r.dataset.f2lvoice === 'ask') settings.ask = b.dataset.v === 'on'; else settings.call = b.dataset.v as CallMode;
    save(); paint();
    for (const l of listeners) l();
  });
  paint();
  const note = document.getElementById('f2l-voice-words');
  if (note) {
    note.innerHTML = `<p>Say the pair (${Object.values(SLOT_WORD).map((w) => `“${w.replace('-', ' ')}”`).join(', ')}), then what you would do for it, or its case number (“case 17”). “Tell me” with a pair says it.</p>
      <table><tbody>${TECH_NOTE.map(([t, d]) => `<tr><th>${TECH_WORD[t]}</th><td>${d}</td></tr>`).join('')}</tbody></table>
      <p>It is read off the alg the finder leads with for that pair (your starred alg when it can be done), so a keyhole is also a D conjugate.</p>`;
  }
}
