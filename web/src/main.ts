// Entry for the standalone scanner page (scanner.html) — lets the camera
// pipeline be tested independently of the trainer.

import { mountScanner } from './ui/scanner';

const root = document.getElementById('app');
if (!root) throw new Error('scanner.html is missing #app');
const scanner = mountScanner(root);
scanner.start();

// Free the camera when the tab is hidden; the user resumes with one tap.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) scanner.stop();
});
