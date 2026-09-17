// The one module that imports the Firebase SDK. Loaded with a dynamic
// import from sync.ts, so Vite splits it out and nobody who has not
// switched sync on downloads it. The web config is an identifier, not a
// secret: the per-user rules (firebase/firestore.rules) are what protect
// the data. No analytics.

import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signInWithRedirect, getRedirectResult, signOut, type User } from 'firebase/auth';
import { collection, doc, getFirestore, onSnapshot, query, serverTimestamp, setDoc, Timestamp, where, writeBatch, type DocumentData } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: 'AIzaSyAyCxJIScit6X-KpWmPKHKw4yv1DB0rRbE',
  authDomain: 'cube-coach-29320.firebaseapp.com',
  projectId: 'cube-coach-29320',
  storageBucket: 'cube-coach-29320.firebasestorage.app',
  messagingSenderId: '1038331240574',
  appId: '1:1038331240574:web:63acc9ebc43060fdb6b82f',
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

export type { User, DocumentData };
export { auth, db, collection, doc, onSnapshot, query, serverTimestamp, setDoc, Timestamp, where, writeBatch, onAuthStateChanged, signOut, getRedirectResult };

/** Google sign-in: a popup, or the redirect flow where popups are blocked. */
export async function signInWithGoogle(): Promise<void> {
  const provider = new GoogleAuthProvider();
  try { await signInWithPopup(auth, provider); }
  catch (err) {
    const code = (err as { code?: string }).code ?? '';
    if (code === 'auth/popup-blocked' || code === 'auth/operation-not-supported-in-this-environment') await signInWithRedirect(auth, provider);
    else throw err;
  }
}
