// Shared by every test that replays a capture's evidence log.
import { patchWeight } from '../src/colour/evidence';
import type { EvidenceLog, Reading } from '../src/colour/types';

/**
 * A capture stores each reading's weight as computed by the page at the
 * time; the replay re-derives it from the stored patch statistics with the
 * CURRENT patchWeight so a weighting change is measured here before it
 * ships. The quad-level factor (blur, motion, view, size, age) is recovered
 * as the stored weight over the patch factor of that capture's version.
 *
 * v1 captures (no `version`) computed clipFrac as "any channel >= 250",
 * which is 1.0 for every orange sticker on the phone, and weighted those
 * readings zero: a reading whose median colour is not near white was not
 * glare, so its clipFrac is reset first.
 */
export function reweight(log: EvidenceLog, version: number | undefined): EvidenceLog {
  const patchAtCapture = (r: Reading): number => {
    const glare = r.clipFrac > 0.6 ? 0 : 1 - r.clipFrac;
    const seam = Math.max(0.1, 1 - 2 * r.darkFrac);
    const flat = Math.exp(-r.spread / 8);
    const cens = r.censored.reduce((w, c) => (c ? w * (version ? 0.8 : 0.5) : w), 1);
    return glare * seam * flat * cens;
  };
  for (const q of log.quads) {
    const qw = q.readings.filter((r) => r.clipFrac === 0 && patchAtCapture(r) > 0).map((r) => r.w / patchAtCapture(r));
    const quadW = qw.length ? qw.sort((a, b) => a - b)[qw.length >> 1]! : 0.5;
    for (const r of q.readings) {
      if (!version && Math.min(...r.rgb) < 235) r.clipFrac = 0;
      r.w = quadW * patchWeight({ rgb: r.rgb, lab: r.lab, clipFrac: r.clipFrac, darkFrac: r.darkFrac, spread: r.spread, censored: r.censored, n: 144 });
    }
  }
  return log;
}

