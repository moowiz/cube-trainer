// Keep the screen awake while the app is in the foreground (a setting, on
// by default): a timer or a drill has both hands on a cube, and a phone
// that dims mid-solve is worse than a little battery. The lock is dropped
// by the browser whenever the page is hidden and taken again when it
// shows; browsers without the API just do nothing.

import { persistControls } from '../ui/settings';

let wanted = true;
let lock: WakeLockSentinel | null = null;

async function acquire(): Promise<void> {
  if (!wanted || lock || document.hidden || !('wakeLock' in navigator)) return;
  try {
    lock = await navigator.wakeLock.request('screen');
    lock.addEventListener('release', () => { lock = null; });
  } catch { lock = null; }
}

function setKeepAwake(on: boolean): void {
  wanted = on;
  if (on) void acquire();
  else { void lock?.release().catch(() => undefined); lock = null; }
}

/** Wire the settings checkbox (#keepawake) and follow the page's visibility. */
export function initWake(): void {
  const box = document.getElementById('keepawake') as HTMLInputElement | null;
  if (box) {
    persistControls({ keepawake: box });
    box.addEventListener('change', () => setKeepAwake(box.checked));
    wanted = box.checked;
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void acquire(); });
  void acquire();
}
