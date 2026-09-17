// The recording rig's client (docs/smart-cube-design.md 4.2): streams a
// session's files to the dev server's recording sink (vite.config.ts,
// `/__recording`), one small POST at a time in order, so a long session
// never sits in memory and a crash loses at most the last chunk. On the
// deployed site the sink does not exist: `available()` says so and the
// caller keeps its download behaviour.

const NAME = /^[A-Za-z0-9._-]{1,120}$/;

export class RecordingStream {
  private queue: Promise<void> = Promise.resolve();
  private failures = 0;
  private sent = 0;

  /** @param session the folder name under recordings/; @param base the app's base URL (Vite's BASE_URL) */
  constructor(readonly session: string, private readonly base: string = import.meta.env.BASE_URL) {
    if (!NAME.test(session)) throw new Error(`bad session name: ${session}`);
  }

  /** Is a sink there? True on the dev server, false on the deployed site (or offline). */
  static async available(base: string = import.meta.env.BASE_URL, fetchFn: typeof fetch = fetch): Promise<boolean> {
    try {
      const r = await fetchFn(`${base}__recording/`, { method: 'GET', cache: 'no-store' });
      if (!r.ok) return false;
      const j = (await r.json()) as { ok?: boolean };
      return j.ok === true;
    } catch { return false; }
  }

  /** Append to a file in the session folder (in order with every other call). */
  append(file: string, data: Blob | string): Promise<void> { return this.send(file, data, true); }

  /** Replace a file in the session folder. */
  put(file: string, data: Blob | string): Promise<void> { return this.send(file, data, false); }

  /** Resolves once everything queued so far has been sent (or failed). */
  flush(): Promise<void> { return this.queue; }

  /** How many requests failed (each is retried once before counting). */
  failed(): number { return this.failures; }
  count(): number { return this.sent; }

  private send(file: string, data: Blob | string, append: boolean, fetchFn: typeof fetch = fetch): Promise<void> {
    if (!NAME.test(file)) return Promise.reject(new Error(`bad file name: ${file}`));
    const url = `${this.base}__recording/${this.session}/${file}${append ? '?append=1' : ''}`;
    const attempt = async (): Promise<boolean> => {
      try { return (await fetchFn(url, { method: 'POST', body: data, cache: 'no-store' })).ok; }
      catch { return false; }
    };
    const run = this.queue.then(async () => {
      if (await attempt()) { this.sent++; return; }
      if (await attempt()) { this.sent++; return; }
      this.failures++;
    });
    this.queue = run;
    return run;
  }
}
