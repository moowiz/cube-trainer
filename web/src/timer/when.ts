// When a solve happened, for the Solve tab's list and its session picker:
// short stamps that read at a glance next to a time, the full one for a
// hover. Every record already carries `when` (wall clock at the first turn)
// and `editedAt`; nothing new is stored. Local time throughout.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const two = (n: number): string => String(n).padStart(2, '0');

/** "14:32" */
export function clockOf(when: number): string {
  const d = new Date(when);
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** "19 Sep", or "19 Sep 2025" when the year is not `now`'s */
export function dayOf(when: number, now = Date.now()): string {
  const d = new Date(when);
  const year = d.getFullYear() === new Date(now).getFullYear() ? '' : ` ${d.getFullYear()}`;
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${year}`;
}

export function sameDay(a: number, b: number): boolean {
  const p = new Date(a), q = new Date(b);
  return p.getFullYear() === q.getFullYear() && p.getMonth() === q.getMonth() && p.getDate() === q.getDate();
}

/** The list's stamp: the clock for a solve today, the day otherwise. */
export function stampOf(when: number, now = Date.now()): string {
  return sameDay(when, now) ? clockOf(when) : dayOf(when, now);
}

/** The hover: "Sat 19 Sep 2026, 14:32:05" */
export function fullOf(when: number): string {
  const d = new Date(when);
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];
  return `${wd} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${clockOf(when)}:${two(d.getSeconds())}`;
}

/** A session's span for the picker: "19 Sep", "17–19 Sep", "28 Aug – 3 Sep", "20 Sep 14:32–16:05" when it is today's. */
export function spanOf(first: number, last: number, now = Date.now()): string {
  if (sameDay(first, last)) return sameDay(first, now) ? `${dayOf(first, now)} ${clockOf(first)}–${clockOf(last)}` : dayOf(first, now);
  const a = new Date(first), b = new Date(last);
  if (a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth()) return `${a.getDate()}–${dayOf(last, now)}`;
  return `${dayOf(first, now)} – ${dayOf(last, now)}`;
}

/** The name an automatic session gets: "2026-09-20 14:32" - sortable, unambiguous, and says what it is. */
export function autoSessionName(when: number): string {
  const d = new Date(when);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${clockOf(when)}`;
}

/** "2 h 15 min" / "3 days", for the toast that announces an automatic session. */
export function gapOf(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60), m = min % 60;
  if (h < 24) return m ? `${h} h ${m} min` : `${h} h`;
  const days = Math.round(h / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}
