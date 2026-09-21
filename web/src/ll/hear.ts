// The quiz's ear: what the browser's speech recogniser wrote, read as a
// PLL case's name or a surrender. Pure, so it is testable without a
// browser; the listening itself is in trainer.ts.

// what a spoken word means: a letter (as said, as the alphabet or NATO says it), or a command
const HEARD: Record<string, string> = {
  a: 'A', ay: 'A', eh: 'A', alpha: 'A', b: 'B', bee: 'B', be: 'B', bravo: 'B', c: 'C', see: 'C', sea: 'C', si: 'C', charlie: 'C', d: 'D', dee: 'D', de: 'D', delta: 'D',
  e: 'E', ee: 'E', echo: 'E', f: 'F', ef: 'F', eff: 'F', foxtrot: 'F', g: 'G', gee: 'G', ji: 'G', golf: 'G', h: 'H', aitch: 'H', hotel: 'H', j: 'J', jay: 'J', juliet: 'J',
  n: 'N', en: 'N', november: 'N', r: 'R', ar: 'R', are: 'R', romeo: 'R', t: 'T', tee: 'T', tea: 'T', tango: 'T', u: 'U', you: 'U', uniform: 'U', v: 'V', vee: 'V', victor: 'V',
  y: 'Y', why: 'Y', yankee: 'Y', z: 'Z', zed: 'Z', zee: 'Z', zulu: 'Z',
};
const GIVE_UP = /\b(give up|skip|tell me|pass|dunno|don'?t know|no idea|what is it)\b/;
/**
 * The case id a transcript names ("G a perm", "gee alpha", "T"), 'giveup' for a surrender, or null. The
 * first letter is the family, an a/b/c/d after it the variant; "perm" and the rest are ignored.
 */
export function heardCase(transcript: string, ids: readonly string[]): string | 'giveup' | null {
  const t = transcript.toLowerCase().replace(/[^a-z' ]/g, ' ').trim();
  if (GIVE_UP.test(t)) return 'giveup';
  // a word may be a letter as the recogniser writes it ("g", "gee", "golf"), or two letters run together ("ga")
  const letters: string[] = [];
  for (const w of t.split(/\s+/).filter((w) => w && w !== 'perm' && w !== 'perms' && w !== 'the')) {
    if (HEARD[w]) letters.push(HEARD[w]!);
    else if (/^[a-z]{2}$/.test(w) && HEARD[w[0]!] && 'abcd'.includes(w[1]!)) letters.push(HEARD[w[0]!]!, w[1]!.toUpperCase());
  }
  // the first letter that names a case, with the a/b/c/d after it if that makes one ("a T perm": the article is skipped)
  for (let i = 0; i < letters.length; i++) {
    const two = letters[i + 1] && 'ABCD'.includes(letters[i + 1]!) ? `${letters[i]}${letters[i + 1]!.toLowerCase()}` : null;
    if (two && ids.includes(two)) return two;
    if (ids.includes(letters[i]!)) return letters[i]!;
  }
  return letters.length ? letters.join('') : null; // a name that is no case: still an answer, and a wrong one
}
