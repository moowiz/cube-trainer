// The sign-in page. The app itself runs cross-origin isolated (COOP
// same-origin, for wasm threads - detect/coi.ts), which severs a popup's
// link to its opener, so Firebase's popup sign-in in the app ends in
// auth/popup-closed-by-user. This page is served without those headers
// (the service worker skips it), signs in here, and returns to the app,
// which reads the signed-in user from the shared IndexedDB persistence.

const params = new URLSearchParams(location.search);
const status = document.getElementById('status')!;
const btn = document.getElementById('go') as HTMLButtonElement;
const backLink = document.getElementById('back') as HTMLAnchorElement;

/** Where to return: a same-origin path only, else the app's root. */
function back(): string {
  const r = params.get('return');
  return r && r.startsWith('/') && !r.startsWith('//') ? r : import.meta.env.BASE_URL;
}
backLink.href = back();

const done = (who: string) => { status.textContent = `Signed in as ${who}. Back to the trainer…`; location.replace(back()); };

async function run(): Promise<void> {
  btn.disabled = true;
  status.textContent = 'Opening Google…';
  try {
    const fb = await import('./store/firebase');
    await fb.signInWithGoogle();
    if (fb.auth.currentUser) done(fb.auth.currentUser.email ?? fb.auth.currentUser.displayName ?? 'you');
    else status.textContent = 'Redirecting to Google…';
  } catch (err) {
    status.textContent = `Sign-in failed: ${err instanceof Error ? err.message : err}`;
    btn.disabled = false;
  }
}
btn.onclick = () => { void run(); };

// landing back from the redirect flow (where popups are blocked): finish it; already signed in: say so
void import('./store/firebase').then(async (fb) => {
  const res = await fb.getRedirectResult(fb.auth).catch(() => null);
  if (res?.user) { done(res.user.email ?? 'you'); return; }
  fb.onAuthStateChanged(fb.auth, (u) => { if (u && !btn.disabled) status.textContent = `Already signed in as ${u.email ?? u.displayName ?? 'you'}. Sign in again to switch accounts, or go back.`; });
});
