# cubejs, vendored

`cubejs@1.3.2` (published 2019-04-27, still the latest), `lib/cube.js` and
`lib/solve.js`, as ESM. Vendored 2026-09-22.

## Why

The package is two files of dependency-free arithmetic — a cubie/facelet model
and Kociemba's two-phase solver — wrapped in a 2019 UMD preamble. That preamble
is the only thing about it that was still costing us:

- it ends `}).call(this)` and falls back to `this.Cube = Cube` when it sees no
  CommonJS `module`. Under rolldown (vite 8) the bundle is strict ESM, `this` is
  `undefined`, and the page dies on `Cannot read properties of undefined`;
- the package declares `npm@^6` as a runtime dependency it never loads, which
  is 450 lockfile entries and every `npm audit` finding we had (an `overrides`
  stub already neutralised that, but the stub is one more thing to explain).

Vendoring costs 51 KB of code we do not edit and removes both.

## What was changed

Nothing but the module wrapper, and each edit is commented in place:

- `cube.js` — the trailing UMD globals block became `exported = Cube` plus an
  `export default`; the outer IIFE takes `undefined` instead of `this`.
- `solve.js` — `Cube = this.Cube || require('./cube')` became the ESM import;
  same `undefined` for the IIFE.

Everything else is upstream byte for byte, and `test/vendor-cubejs.test.ts`
proves it: it runs this copy and the npm package side by side over random
states, algs with rotations and wide moves, and full solves, and requires
identical answers.

## The npm package stays a devDependency

Deliberately. Thirteen test files use `cubejs` as an *independent*
implementation to check our own cube code against — `moves/moves.ts`'s
permutation table, `cube/nxn.ts` at n=3, the piece tables, `validateState`.
If the app and the oracle were the same vendored file, those tests would only
be checking our code against itself.

## Upgrading

There is nothing to upgrade to; 1.3.2 is the last release. If it ever moves,
re-vendor by repeating the two wrapper edits above rather than by hand-patching
this copy, and let the vendor test tell you whether anything else moved.
