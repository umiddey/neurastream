# neurastream: a pending rollover wins over the stop guard
Worktree: /home/ukd/Work/neurastream-stop-yield
Branch: fix/rollover-stop-yield

## Goal
- Owner (2026-10-23 ~12:10): "We have to solve this conflict on a product level now, don't we?" INCIDENT I-20261023-9 (and I-20261023-8). INCIDENT I-20261023-10: the owner had to stop a worker and restart by hand because of this conflict.
- What happened (this session, running plugin 0.1.16):
  1. Main wrote the handoff note. The rollover then waited for Main's own jobs.
  2. The last job (a CI watcher) ended, so the rollover state was `ready`.
  3. The `session_stop` hook (`checkStop`, src/core/guards.ts:689) blocked Main's stop: "the queue has 20 open items and no subagent is running … spawn an agent".
  4. Main obeyed and spawned PmSecP5TestsHaiku, which put the rollover back to `wait-jobs`.
  5. The two rules feed each other: the rollover waits for no jobs, and the stop guard demands a new job.
- What origin/main dba8d84 (0.1.19) already fixes and what it does not:
  - Fixed: `spawnRefusal` refuses spawns in `need-note`/`wait-jobs`/`ready` (src/core/rollover.ts:52-55).
  - Fixed: `session_stop` allows the stop once `relaunched` is true (src/adapters/omp/index.ts:416). But `relaunched` is set only by `requestRelaunch` (:470-478), which runs from `onSizeCheck` at `agent_end`/`tool_result` (:500-519) and only under the launcher.
  - Not fixed: a stop attempted while the state is `wait-jobs` or `ready` and `relaunched` is still false still goes to `checkStop` (index.ts:417). `checkStop` blocks on open queue items, open incidents or a pending cancel, and its text tells Main to spawn an agent. That spawn is now refused, so Main has nothing it can do and loops until the `idleStops` release valve lets it out.
  - Not fixed: under plain `omp` (no launcher), `relaunched` never becomes true, so the stop guard keeps blocking an idle Main that is waiting for the owner's message to roll over.
- When done, these hold:
  - (a) `session_stop` reads the rollover snapshot (`rolloverSnapshot`, index.ts:437) before `checkStop`, and `checkStop` does not run in any of these states (so no queue, incident or cancel block and no "spawn an agent" text; the new session raises those again through main-start):
    - `ready` under the launcher: call `requestRelaunch` if not already `relaunched`, and allow the stop.
    - `ready` under plain omp: allow the stop; the owner's next message starts the new session.
    - `wait-jobs`: allow the stop; Main's running jobs wake it.
  - (b) In `need-note` (note not written yet), `session_stop` blocks with the note request reason (`noteRequest`) only, never the queue text.
  - (c) `below` (no rollover) behaves exactly as today.
  - (d) One guard-log line per decision: `ALLOW stop: rollover <state>` / `BLOCK stop: rollover need-note`.

## Forbidden
- Never push, tag, publish, link or install; never bump the version. Commit only on fix/rollover-stop-yield, files added by name; never `git add -A`/`git add .`; never `--no-verify`.
- Touching the live setup (`~/.omp/agent`, `~/.local/bin`, `~/.local/state`, `~/.config`, `~/.bun/install/global`) or any repo other than this worktree. Tests run under a sandbox `HOME=/tmp/neurastream-home-*` (repo AGENTS.md) and fake the host as tests/rollover-omp.test.ts does.
- Changing files outside `src/adapters/omp/index.ts`, `src/core/rollover.ts` (only if a pure helper is needed), `tests/rollover-omp.test.ts`, `tests/rollover.test.ts`, `CHANGELOG.md` (one Unreleased line), README.md "Session rollover" section (one sentence).
- Never weaken or delete an existing test to pass. The existing test "no relaunch: session_stop still blocks on the open plan" (tests/rollover-omp.test.ts:578, state `below`) stays as is.
- Every `bun test`/typecheck run goes through `/home/ukd/Work/heavy-run.sh <agent> "<label>" -- <cmd>` with tool timeout 0, in the FOREGROUND. Probe one test file before the full suite.
- `find` is broken: use grep/glob/read. One failed tool call is never a blocker; try two other ways.
- Claim rule: report only what you ran and saw (label + exit code + log path).
- Call budget: stop and report within ~100 tool calls per run (warning at 90, hard stop at 100). Commit each green unit immediately. You may append entries under `## Progress` of this plan only.
- Read /home/ukd/projects/opus-implementer-method.md first and work by it. Read the repo AGENTS.md.
- The live plan-guard refuses any shell call whose text contains the word `queue-close` or `queue-cancel`, or names a path under `docs/plans/`. Never type those in a bash command; use the read/edit tools for the plan file.

## Blockers
- no-push
- deny-path /home/ukd/.omp/agent/** /home/ukd/.local/bin/** /home/ukd/.local/state/** /home/ukd/.config/** /home/ukd/.bun/install/global/** /home/ukd/.npmrc INDEX.md package.json bun.lock
- deny-command npm\s+publish bun\s+publish npm\s+link bun\s+link git\s+tag --no-verify git\s+add\s+(-A|--all|\.)

## Phases
- [x] P1 (a)+(c)+(d). Write the tests first in tests/rollover-omp.test.ts, using `openPlanFixture()` (:527) + `stopCfg` as the tests at :560-589 do. Cases: launcher + `ready` with the stop attempted BEFORE any `agent_end` → `session_stop` returns `[]` and `shutdowns` is 1; plain omp + `ready` → `[]`, no shutdown; `wait-jobs` (a running job in the fake ctx) → `[]`; an open incident in the sandbox state + `ready` → `[]`; `below` + open plan → still `block` (existing test). fail-before: run them red on the unchanged code and record the run in Progress (label + exit code), then fix. — difficulty: 4 — verify: `bun test tests/rollover-omp.test.ts`
- [x] P2 (b): `need-note` + open plan → `block` whose reason contains "Write a handoff note to" and not "spawn". fail-before: red first, then fix. — difficulty: 2 — verify: `bun test tests/rollover-omp.test.ts tests/rollover.test.ts`
- [x] P3 Whole suite + typecheck green; CHANGELOG Unreleased line; README one sentence. — difficulty: 1 — verify: `bun run typecheck && bun test`
<!-- difficulty: set by Main at plan time, before any result (agent-score reads it): 1 mechanical · 2 rules · 3 new spec · 4 root-cause · 5 product fix · 8 engine. Owner may override. -->

## Done check
`cd /home/ukd/Work/neurastream-stop-yield && bun run typecheck && bun test tests/rollover-omp.test.ts tests/rollover.test.ts && bun test && grep -qi 'stop' CHANGELOG.md`

## Code read by Main
- `src/adapters/omp/index.ts`
- `src/core/rollover.ts`
- `src/core/guards.ts`
- `tests/rollover-omp.test.ts`

## Progress
Status: complete
- 2026-10-23 12:3x Main: PR #14 squash-merged (94b234d), tag v0.1.20 pushed; scores recorded on 94b234d.
- 2026-10-23 12:0x Main: reviewed 04df22e (session_stop reads the rollover snapshot first; need-note → note request only; ready/wait-jobs → allow, launcher ready → requestRelaunch). Done check run by Main via heavy-run: typecheck 0, 274 pass 0 fail. P1-P3 ticked. Next: release 0.1.20 (Main).
- 2026-10-23 11:3x Main: spawning NsStopYieldHaiku on P1-P3 (worktree at dba8d84).
- P1 red (unchanged adapter, new tests): `heavy-run.sh NsStopYieldHaiku "P1 red: rollover-omp tests on unchanged code" -- env HOME=/tmp/neurastream-home-stop-yield bun test tests/rollover-omp.test.ts`, exit 1: 26 pass, 4 fail (the four new P1 cases). Output was shown in the run; the shared heavy-run log /home/ukd/Work/.heavy-run.log holds START/END lines only.
- P1 green: `heavy-run.sh NsStopYieldHaiku "P1 green: rollover-omp tests after stop-decision fix"`, exit 0: 30 pass, 0 fail. Log: /tmp/neurastream-stop-yield-p1-green.log
- P2 red (fail-before): HEAD adapter swapped in via `git show HEAD:src/adapters/omp/index.ts` for one run, fixed file restored and cmp-verified. `heavy-run.sh NsStopYieldHaiku "P2 red: need-note test against HEAD adapter"`, exit 1: 26 pass, 5 fail (the four P1 cases plus the need-note case). Log: /tmp/neurastream-stop-yield-p2-red.log
- P2 green: `heavy-run.sh NsStopYieldHaiku "P2 green: rollover-omp + rollover tests"`, exit 0: 59 pass, 0 fail across tests/rollover-omp.test.ts and tests/rollover.test.ts. Log: /tmp/neurastream-stop-yield-p2-green.log
- P3: first typecheck attempt exit 2 (TS2532 in the new P2 test, index access); fixed with optional chaining. Rerun `heavy-run.sh NsStopYieldHaiku "P3 green: typecheck + full suite"`, exit 0. Typecheck log /tmp/neurastream-stop-yield-p3-typecheck.log; full suite `bun test` 274 pass, 0 fail, 28 files. Log: /tmp/neurastream-stop-yield-p3-test.log
- Commit 04df22e on fix/rollover-stop-yield (files added by name: CHANGELOG.md, README.md, src/adapters/omp/index.ts, tests/rollover-omp.test.ts). Not pushed.

## Background
- The release after merge is Main's job: bump to 0.1.20, tag v0.1.20 (the publish workflow runs on `v*` tags), `bun add -g neurastream@latest`, `neurastream adapter install omp`, `neurastream doctor` exit 0.
