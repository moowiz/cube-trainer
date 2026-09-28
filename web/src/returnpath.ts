// Where the sign-in page may send you back to (signin.ts). A prefix test
// ("starts with / but not //") let `/\evil.example` through: the URL parser
// reads a backslash as a slash on http(s), so it resolved off-site. Resolve
// it instead and keep it only if it stays on this origin.

/** `r` as a same-origin path (path, query, hash), else `fallback`. */
export function sameOriginPath(r: string | null, origin: string, fallback: string): string {
  if (!r) return fallback;
  let u: URL;
  try { u = new URL(r, origin); } catch { return fallback; }
  return u.origin === origin ? u.pathname + u.search + u.hash : fallback;
}
