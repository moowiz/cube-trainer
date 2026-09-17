// One place for the browser-download dance every export button does.

/** Save `blob` as a download named `name` (object URL, an <a download> click, the URL revoked after 10 s). */
export function downloadBlob(name: string, blob: Blob): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

/** Save text as a download; `type` is its MIME type. */
export function downloadText(name: string, text: string, type = 'application/json'): void {
  downloadBlob(name, new Blob([text], { type }));
}
