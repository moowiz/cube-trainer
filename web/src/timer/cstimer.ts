// csTimer's export file, both ways, so a history moves in once and times
// can go back out. The file is JSON: one key per session, "session1",
// "session2", ..., each a list of solves [[penalty, ms], scramble,
// comment, unixSeconds] with penalty 0, 2000 (+2) or -1 (DNF); and a
// "properties" object whose "sessionData" is a JSON string of session
// names keyed by number.

import { newId, type SessionRecord, type SolveRecord } from '../store/types';

type CsSolve = [[number, number], string, string, number, ...unknown[]];

export interface Imported { sessions: SessionRecord[]; solves: SolveRecord[] }

/** Parse a csTimer export. Session ids are made fresh; `now` stamps the edits. */
export function importCsTimer(text: string, now = Date.now()): Imported {
  const data = JSON.parse(text) as Record<string, unknown>;
  let names: Record<string, { name?: string; rank?: number }> = {};
  try {
    const props = data.properties as { sessionData?: string } | undefined;
    if (props?.sessionData) names = JSON.parse(props.sessionData) as typeof names;
  } catch { /* no names: numbered sessions */ }
  const sessions: SessionRecord[] = [];
  const solves: SolveRecord[] = [];
  const keys = Object.keys(data).filter((k) => /^session\d+$/.test(k)).sort((a, b) => Number(a.slice(7)) - Number(b.slice(7)));
  for (const key of keys) {
    const rows = data[key];
    if (!Array.isArray(rows) || rows.length === 0) continue;
    const num = key.slice(7);
    const id = `cs-${newId(now)}-${num}`;
    const first = Math.min(...rows.map((r) => Number((r as CsSolve)[3]) * 1000).filter((t) => Number.isFinite(t) && t > 0), now);
    sessions.push({ id, name: names[num]?.name || `csTimer ${num}`, createdAt: first, editedAt: now });
    for (const r of rows as CsSolve[]) {
      const [[pen, ms], scramble, comment, secs] = r;
      const when = Number.isFinite(secs) && secs > 0 ? secs * 1000 : now;
      solves.push({
        id: newId(when), session: id, when, scramble: String(scramble ?? '').trim(), time: ms,
        penalty: pen === -1 ? -1 : pen === 2000 ? 2 : 0,
        comment: comment ? String(comment) : undefined, source: 'import', editedAt: now,
      });
    }
  }
  return { sessions, solves };
}

/** A csTimer export of these sessions and their solves (deleted ones left out). */
export function exportCsTimer(sessions: readonly SessionRecord[], solves: readonly SolveRecord[]): string {
  const out: Record<string, unknown> = {};
  const names: Record<string, { name: string; rank: number }> = {};
  sessions.filter((s) => !s.deleted).forEach((s, i) => {
    const n = String(i + 1);
    names[n] = { name: s.name, rank: i + 1 };
    out[`session${n}`] = solves.filter((v) => v.session === s.id && !v.deleted).sort((a, b) => a.when - b.when)
      .map((v): CsSolve => [[v.penalty === -1 ? -1 : v.penalty === 2 ? 2000 : 0, v.time], v.scramble, v.comment ?? '', Math.round(v.when / 1000)]);
  });
  out.properties = { sessionData: JSON.stringify(names) };
  return JSON.stringify(out);
}
