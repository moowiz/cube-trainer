// The ear every voice drill listens with: the browser's speech recognition, which on Android Chrome is Google's
// servers - the one thing in the app that leaves the phone; each drill's setting is the opt-in (user, 2026-09-21).
// Chrome on a phone ends a session after a short silence, so the session is restarted until the drill stops it.

interface Recognizer {
  lang: string; continuous: boolean; maxAlternatives: number; interimResults: boolean;
  start(): void; abort(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
}
const recognizerCtor = (): (new () => Recognizer) | null => {
  const w = window as unknown as { SpeechRecognition?: new () => Recognizer; webkitSpeechRecognition?: new () => Recognizer };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
};
/** This browser can listen at all. */
export const canHear = (): boolean => recognizerCtor() !== null;

export interface EarOpts {
  /** the recogniser's guesses per phrase (the best first) */
  alts?: number;
  /** a phrase heard: its guesses */
  heard(alts: string[]): void;
  /** no microphone (refused, none, or no recognition here): the ear has stopped */
  fatal?(): void;
}
/** Listen until the returned stop is called (or the microphone is refused). */
export function listen(opts: EarOpts): () => void {
  const Ctor = recognizerCtor();
  let on = true, cur: Recognizer | null = null;
  const stop = () => { on = false; const r = cur; cur = null; r?.abort(); };
  const fail = () => { if (!on) return; stop(); opts.fatal?.(); };
  if (!Ctor) { queueMicrotask(fail); return stop; }
  const go = () => {
    if (!on) return;
    const r = new Ctor(); cur = r;
    r.lang = 'en-US'; r.continuous = true; r.maxAlternatives = opts.alts ?? 3; r.interimResults = false;
    r.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length && on && cur === r; i++) opts.heard(Array.from(e.results[i] ?? [], (x) => x.transcript));
    };
    r.onerror = (e) => { if (cur === r && (e.error === 'not-allowed' || e.error === 'audio-capture')) fail(); }; // a no-speech end just restarts
    r.onend = () => { if (cur === r) { cur = null; if (on) setTimeout(go, 100); } };
    try { r.start(); } catch { fail(); }
  };
  go();
  return stop;
}
