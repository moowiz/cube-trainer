---
name: maintain
description: One maintenance pass over the repo - the mechanical gates, the drift since the last pass, then the top open item of docs/maintenance-plan.md, each step its own commit. Use for "/maintain", "do a maintenance pass", "clean up the repo", "what has drifted".
---

# A maintenance pass

This file lives at `.claude/skills/maintain/SKILL.md` (move it there from
`docs/maintain-skill.md` if you are reading it in `docs/`). One pass is
bounded: the gates, the drift report, then at most one plan item. Stop
after that and report; the user decides whether to go on.

Read `CLAUDE.md` first. The rules that bite in a maintenance pass: say
colours, not face letters; one cube model under `src/cube/`; fixtures beat
mocks; commit with `tools/wsl/push.sh` never plain `git push`; other
sessions may share the checkout, so stage by path and check `HEAD` before
each commit; `.bashrc`, `.gitconfig`, `.mcp.json`, `web/.claude/` at the
repo root are sandbox masks, never add them.

## 1. The gates (must be green before and after)

```
cd web && npm run lint && npm run typecheck && npm test
cd web && npm run maintain        # knip, jscpd, npm audit (shipped deps), build, main-chunk ceiling
cd model && .venv/bin/ruff check . ../tools
```

`npm run maintain` is what CI runs (`.github/workflows/ci.yml`, the `web`
job). If it is red on `main`, that is the pass: fix it, commit, stop.

- **knip red**: an export nothing imports. Un-export it if it is used in
  its own file, delete it if not. Never add it to `knip.json`'s ignores
  unless it is a genuine entry point (a worker, a Vite page, a script).
- **jscpd red** (more than 1% of lines in exact clones): `npx jscpd src`
  lists them. Fold the clone into the shared helper (`ui/dom.ts`,
  `cube/alg.ts`, `colour/robust.ts`, `workers/rpc.ts` are the homes that
  exist) or, if the two copies are about to diverge, say so in a comment.
  `docs/maintenance-plan.md` 3.12 lists what looks duplicated but is not.
- **audit red**: a high advisory in a dependency that ships. Bump it, then
  run the headless checks (section 3) if it touches the page.
- **check:size red**: `dist/assets/main-*.js` over the ceiling in
  `web/scripts/check-size.mjs`. Find the static import that grew (a
  `vite build` warning names the chunk); lazy-load it the way
  `algs/sheet.ts` is. Do not raise the ceiling without saying why in the
  commit.

## 2. The drift report (measure, do not fix yet)

Run, and write the numbers down next to the last pass's in
`docs/maintenance-plan.md`'s status section:

```
cd web && npm outdated                                      # majors are decisions, minors are chores
cd web && npx vitest run --reporter=json --outputFile=$TMPDIR/vt.json >/dev/null; \
  node -e "const r=require(process.env.TMPDIR+'/vt.json');r.testResults.map(f=>[f.name.split('/test/')[1],f.endTime-f.startTime]).sort((a,b)=>b[1]-a[1]).slice(0,5).forEach(x=>console.log(x[1]|0,'ms',x[0]))"
cd web && npm run build 2>&1 | grep -E 'kB|warning'         # chunk sizes
git count-objects -vH | grep size-pack                      # the model file in history (plan 2.4)
git ls-files -z | xargs -0 du -k | sort -n | tail -8        # tracked fixtures over 2 MB
find web/src -name '*.ts' | xargs wc -l | sort -n | tail -5 # files over 1000 lines (plan 3.10)
grep -rn 'console\.\(log\|warn\)' web/src --include='*.ts' | grep -v debug/ | grep -v catch
grep -rnE 'TODO|FIXME' web/src model --include='*.ts' --include='*.py'
git branch -a --merged main | grep -v main                  # branches to delete
```

Look at, not just count: the slowest test file (is it the critical path?
split it by fixture or move the heavy cases behind `npm run bench`), any
new file over 1000 lines, any fixture no test reads
(`grep -rl <basename> web/test` empty).

## 3. One plan item

Open `docs/maintenance-plan.md`, its status section at the top, and pick
the highest-ranked item in section 7 that is not done and does not wait on
a decision (items marked "the user's call" or "needs the labeler decision"
are not yours to pick). Do it as the plan describes, then:

- the gates (section 1) green;
- if it touched `src/app/` or `src/ui/`: `npm run build` then
  `npm run check:smart`, and `check:record` / `check:ll` / `check:practice`
  for the sheet it touched. `check:detect` needs the models and WebGPU and
  stays manual. In the WSL sandbox the browser is `PUPPETEER_SHELL=1`
  (see the memory note on headless Chrome);
- one commit for the item, message in the repo's voice (a sentence saying
  what changed and why, no "chore:" prefix), staged by path;
- the plan's status section updated: the item's number, the commit, one
  line on anything that turned out different from the plan.

## 4. Report

What the gates said, the drift numbers that changed, the item done and its
commit, and what the next pass should pick. If a bump or a check could not
be verified (a download the sandbox blocks, a device that is not here),
say so and leave the change out rather than pushing it unverified.
