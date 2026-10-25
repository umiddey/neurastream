# neurastream: plan-read guard checks only new problems, long Progress gets archived, rollover prompts are not owner corrections
Worktree: /home/ukd/Work/neurastream-plan-guard
Branch: fix/plan-read-progress
PRIORITY-ID:

## Goal
- Owner (2026-10-23 14:0x): "yes" to planning and doing both neurastream fixes Main proposed: (1) the plan-read guard must not demand Main re-reads for an edit that only ticks a box; (2) long plan Progress sections get moved to an archive file so workers read less. Plus INCIDENT I-20261023-14 (same as I-20261023-11): the rollover prompts were counted as owner corrections.
- Done = the three fixes are in `src/`, each with a test that fails on origin/main cba8f2d and passes after, `bun run typecheck` and `bun test` exit 0, CHANGELOG + version 0.1.22 committed on `fix/plan-read-progress`. Main pushes, opens the PR, merges, tags and installs.

## Forbidden
- Read /home/ukd/projects/opus-implementer-method.md first and work by it. `find` is broken: use grep/glob/read.
- Read /home/ukd/Work/neurastream-plan-guard/AGENTS.md first; its rules apply (core/adapter split is a hard rule: no omp names in `src/core/`).
- Never push, never tag, never publish (`npm publish`, `bun publish`). Never `--no-verify`, never bypass a guard. Never `git add -A`/`git add .`; add files by name.
- Never link or install the package into the real HOME; every smoke uses `HOME=/tmp/neurastream-home-<name>`.
- Live setup is READ ONLY: /home/ukd/.omp/agent, /home/ukd/.local/bin, /home/ukd/.local/state, /home/ukd/.config. Never edit, move or delete anything there.
- Never change config defaults other than adding `queue.progress_keep`; never weaken an existing test or delete one to make it pass.
- Tests and builds run through `/home/ukd/Work/heavy-run.sh <Agent> "<label>" -- <cmd>` with timeout 0; read the exit code it prints. Green = `bun run typecheck` exit 0 AND `bun test` exit 0.
- Probe before batch: run the one new test file first (red on the old code, then green), then the full suite once.
- Claim rule: every "passes"/"done" in your Progress entry names the command and its result as you saw it; anything you did not run is written "unverified".
- Budget: stop within ~100 tool calls. Write a Progress entry by call 85: done, verified (command + result), commits, next step.
- STOP when P4 is committed, or when blocked: write the Progress entry and end. No questions at the end: decide by these rules and record the decision.

## Blockers
- no-push
- deny-path /home/ukd/.omp/agent/** /home/ukd/.local/bin/** /home/ukd/.local/state/** /home/ukd/.config/** /home/ukd/.npmrc INDEX.md /home/ukd/Work/neurastream-plan-guard/.github/** /home/ukd/Work/neurastream-plan-guard/tests/fixtures/originals/**
- deny-command npm\s+publish bun\s+publish npm\s+link git\s+tag git\s+push ^(?!.*HOME=/tmp/neurastream-home).*bun\s+(link|add\s+-g) ^(?!.*HOME=/tmp/neurastream-home).*omp\s+(plugin\s+)?(install|link) --no-verify git\s+add\s+(-A|--all|\.)(\s|$)

## Phases
- [x] P1 Plan-read guard reports only NEW problems. In `src/core/guards.ts`: `checkMainPlan` (:593) calls `planReadProblems(e.after, …)` (:610) on the whole text, so (a) paths cited only in worker `## Progress` entries count as "cited but not listed", and (b) every listed file needs a Main read in the last `plan_read_max_hours` again even when the edit only ticks a phase box (2026-10-23: one tick needed 16 reads and 3 refused edits). Change: (1) the cited-path scan (:624, `CITED_PATH`) runs on `q.outsideProgress(text)` (`src/core/queue/lib.ts:103`), not the whole text; (2) when `e.before` is non-empty, refuse only for problems in `planReadProblems(after)` that are not in `planReadProblems(before)` (same strings; compare as a set). An empty `before` (new plan) keeps the full check. Keep the refusal text and restore behaviour. Tests in `tests/plan-read-section.test.ts` (follow its existing sandbox setup): (i) a plan whose listed file was read 30 h ago and whose Progress cites an unlisted `src/x.ts:12`: an edit that only ticks `- [ ] P1` → `- [x] P1` is allowed; (ii) the same plan, an edit adding a new unread citation `src/y.ts:3` outside Progress is refused naming `src/y.ts`; (iii) a new plan (before = "") with no reads is refused. (i) must fail on cba8f2d. — difficulty: 4 — verify: `cd /home/ukd/Work/neurastream-plan-guard && bun test tests/plan-read-section.test.ts`
- [x] P2 INCIDENT I-20261023-14 (and I-20261023-11): machine prompts are not owner corrections. D4 `ownerCorrection` (`src/core/incident-detectors.ts:131`) gets the raw `before_agent_start` prompt from `src/adapters/omp/index.ts:309`, which only skips `main-guard:` continuations. Two machine prompts matched `\bno\b`/`stop` (default `metrics.correction_patterns`, `docs/config.md:56`): I-14 = the rollover note request built by `noteRequest` (`src/core/rollover.ts:89`, starts "Session rollover:"), I-11 = the fresh session's first prompt built by `buildHandoff` (`src/core/rollover.ts:68`, starts "Previous session file:", ends with "Owner's message:" + the owner's real words). Change: one core function in `src/core/rollover.ts`, e.g. `ownerText(prompt): string | undefined`: undefined for a `main-guard:` continuation and for a `noteRequest` text; for a `buildHandoff` text only the part after its last "Owner's message:" line; else the prompt. Build the prefixes from the same constants `noteRequest`/`buildHandoff` use (no second copy of the strings). The adapter (:309) passes `ownerText(prompt)` as D4's prompt; M4 `m4` (`src/core/metrics.ts:192`) counts a user message as a correction only on `ownerText(text)`. fail-before regression tests (must fail on cba8f2d, pass after) in `tests/incident-detectors.test.ts` or `tests/rollover.test.ts`: `noteRequest(path, false, "neurastream on disk is 0.1.21, this session runs 0.1.19")` gives no D4 finding; a `buildHandoff` whose note contains "no" and "stop" and whose owner message is "continue" gives none; the same with owner message "no, that is wrong" gives one; a plain owner "stop that" still gives one. — difficulty: 2 — verify: `cd /home/ukd/Work/neurastream-plan-guard && bun test tests/incident-detectors.test.ts tests/rollover.test.ts`
- [x] P3 Long Progress is archived when Main ticks a phase. Today one held plan's Progress is over 12 KB and every worker reads it. Change: (1) pure core helper in `src/core/queue/lib.ts` next to `progressBody` (:107): split the Progress body into the kept head (the `Status:`, `WAITING on owner:`, `Cancelled by owner:`, `False positive:` lines and the HTML comment) and entries (an entry = a top-level `- ` line plus its following lines up to the next top-level `- ` line); keep the newest `queue.progress_keep` entries (new config key, default 6; add it to `src/core/config.ts`, `docs/config.md` and README defaults); entries are newest-first in these plans, so keep the first N in file order. (2) IO helper: append the moved entries to `<plan dir>/archive/<plan basename without .md>-progress.md` (create with a `# Progress archive: <plan file>` header; newer batches go on top), rewrite the plan with one kept line `- Older Progress entries: archive/<name>-progress.md` as the last entry, and keep the spawn gate honest: `recordSpawns` (`src/core/guards.ts:94`) stores `q.sha(q.progressBody(text))` per plan; if the stored hash equals the hash of the body before the trim, replace it with the hash of the body after the trim (else leave it). (3) Trigger: the omp adapter `tool_result` handler (`src/adapters/omp/index.ts:371`), after `checkPlanEdit` allowed a MAIN edit, calls the core helper when the edit ticked a phase (more `[x]` phase lines in after than before) and the Progress has more than `progress_keep` entries; it appends one line to the tool result: `plan-guard: moved N older Progress entries to <file>; re-read the plan before editing it again.` (4) A CLI for hand use: `queue-trim <plan> [--keep N]` (bin + `src/cli/dispatch.ts` route + package.json `bin`, same pattern as `queue-check`). Tests in a new `tests/progress-trim.test.ts`: 9 entries + keep 6 → 6 kept + pointer line, 3 in the archive in order; main-only lines and Status untouched; a second trim puts the new batch above the old one; spawn hash re-keyed only when it matched; fewer than keep → no change, no archive file. — difficulty: 3 — verify: `cd /home/ukd/Work/neurastream-plan-guard && bun test tests/progress-trim.test.ts`
- [x] P4 Release prep: CHANGELOG 0.1.22 entry (three items, incident ids named), `package.json` version 0.1.22, full suite green, commits by name on `fix/plan-read-progress`. — difficulty: 1 — verify: `cd /home/ukd/Work/neurastream-plan-guard && bun run typecheck && bun test && grep -q '"version": "0.1.22"' package.json`

## Done check
`git merge-base --is-ancestor v0.1.22 HEAD && grep -q '"version": "0.1.22"' package.json && grep -q 'export function ownerText' src/core/rollover.ts && grep -q 'export function trimProgressBody' src/core/queue/lib.ts && grep -q 'outsideProgress(text).matchAll(CITED_PATH)' src/core/guards.ts`

## Code read by Main
- `src/core/guards.ts`
- `src/core/queue/lib.ts`
- `src/core/incident-detectors.ts`
- `src/core/rollover.ts`
- `src/core/metrics.ts`
- `src/adapters/omp/index.ts`
- `docs/config.md`
- `tests/plan-read-section.test.ts`
- `tests/incident-detectors.test.ts`
- `tests/guards.test.ts`
- `AGENTS.md`

## Progress
Status: complete
- 2026-10-23 13:2x Main: queue-close removed the worktree before its done check ran, so the old `cd` done check failed (exit 1, reopen). The done check now runs in queue-close's temporary origin/main worktree: v0.1.22 is on main and the three fixes are present. Suite already verified (301 pass on origin/main da86b4d, PR #16 CI green). Branch fix/plan-read-progress deleted locally (tip 236c9f7 kept on origin); worktree re-added detached at origin/main only so the plan paths resolve.
- 2026-10-23 13:1x Main: reviewed NsPlanGuardTrimHaiku (P1–P4) and ACCEPTED; NO_SECTION deviation accepted (old-plan behaviour unchanged). Main fix on top: Main-only lines (WAITING/Cancelled/False positive, with or without "- ") never move to the archive, plus test. typecheck + bun test via heavy-run: 301 pass, 0 fail. Smoke: trimPlanProgress on a copy of the 64 KB held PM plan → 23 KB, 30 entries archived, Status intact. PR #16 squash-merged as da86b4d, tag v0.1.22 pushed. Scored P1–P4 on da86b4d. Done check changed to a squash-safe form (HEAD tree = origin/main for src/tests). Install of 0.1.22 needs the owner's unlock.
<!-- The implementer may only append dated entries here: what was done, what was verified (command +
     result), commits, what is next. It never changes the Status line or adds "WAITING on owner".
     Main reviews the work and then writes "Status: complete"; main-guard auto-runs queue-close, which
     closes the plan once the branch is on main and the done check passes (else reopens it). -->

### 2026-10-23 implementer progress (branch fix/plan-read-progress, worktree /home/ukd/Work/neurastream-plan-guard)
- P1 done, commit `f40a6eb` (guard: refuse only new plan-read problems). Red on cba8f2d; `bun test tests/plan-read-section.test.ts`: 6 pass, 0 fail. Full suite after P1: 284 pass, 0 fail. Deviation: the missing-section refusal (`NO_SECTION`) is always kept, because the literal rule broke `tests/guards.test.ts:258`, which must stay unchanged.
- P2 done, commit `eb00c4b` (rollover: machine prompts are not owner corrections), plus comment-only fix `1094d34` for the purity scan. Rollover and metrics tests: 99 pass, 0 fail. Full suite: 291 pass, 0 fail; typecheck exit 0.
- P3 done, commit `b7719b3` (queue: trim old Progress entries after a phase tick). Red: `bun test tests/progress-trim.test.ts` failed to load with `Export named 'rekeySpawns' not found`, exit 1. Green: `bun test tests/progress-trim.test.ts`: 9 pass, 0 fail. Full suite via heavy-run `bun run typecheck && bun test`: EXIT=0, 300 pass, 0 fail.
- P4 done, commit `f40dad2` (release 0.1.22: CHANGELOG entry, package.json version 0.1.22). Verify `bun run typecheck && bun test && grep -q '"version": "0.1.22"' package.json` via heavy-run: EXIT=0, 300 pass, 0 fail.
- Unverified: the `queue-trim` CLI has no test and was not run against a real plan. The adapter `tool_result` trim hook was checked only by typecheck and the suite, not in a live session. The done check `git merge-base --is-ancestor HEAD origin/main` was not run, because nothing is pushed.
- Not pushed. Next: Main reviews the branch; pushing needs the owner's okay.

## Background
- INCIDENT I-20261023-14: D4 matched `\bno\b` in the rollover note request ("…now 0.1.21, this session runs 0.1.19…" / "Do not list holds…"). I-20261023-11: D4 matched `\bno\b` and `stop` in the handoff prompt of a fresh session.
- Worktree made by Main from origin/main cba8f2d; node_modules is a symlink. The main checkout /home/ukd/projects/neurastream sits on an old branch: do not work there.
