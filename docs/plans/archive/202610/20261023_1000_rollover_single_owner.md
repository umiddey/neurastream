# neurastream: one rollover per session, no orphan or duplicate sessions
Worktree: /home/ukd/Work/neurastream-rollover-race
Branch: fix/rollover-single-owner

## Goal
- Owner (2026-10-23 09:57): "there is some bug in our session handle, roll over … I think there's a race condition … now it has happened twice. We have two sessions now". INCIDENT I-20261023-5.
- What happened (Main read the session files and `~/.local/state/main-guard.log`, installed 0.1.16 = origin/main 65abc8b for these lines):
  1. 07:46:02Z `tool_result` → `onSizeCheck` (src/adapters/omp/index.ts:372, :483-501) saw `ready` under `neurastream main` → `requestRelaunch` (:467-481) wrote relaunch.json and called `c.shutdown()`. omp only sets `shutdownRequested` and exits at the next idle (pi-coding-agent extension-ui-controller.ts:207-212).
  2. 07:45:28/07:46:05 the `session_stop` hook (:412-419, `checkStop`) blocked Main's stop ("queue has 6 open items … keep working"), so Main never went idle. It worked 7 more minutes and spawned CpP5dD1Haiku at 07:49 (`spawnRefusal`, src/core/rollover.ts:52-55, allows spawns in `ready`).
  3. The owner typed twice (07:46:22, 07:48:13). The `input` hook (:531-539) rewrote both to `/main-rollover`; both handlers (:541-577) ran main-start, then blocked in `await c.waitForIdle()`.
  4. 07:53:21 Main went idle: both handlers called `newSession` 1 ms apart → empty orphan `2026-10-23T07-53-21-415Z_…jsonl` (header only) and `…-416Z_…jsonl` that got the handoff twice (07:53:24.567 and .569).
  5. 07:56:00 the deferred shutdown fired inside the new 416Z session; the launcher (src/adapters/omp/launch.ts `takeRequest` :116) used the stale relaunch.json (old session, old note, old draft) → a third session `07-56-07-832Z` without 416Z's work or the owner's 07:55 message; CpP5dD1Haiku died "Request was aborted".
- When done, these hold:
  - (a) One owner per rollover. Under the launcher (`NEURASTREAM_MAIN_LAUNCHER=1`) the `input` hook never rewrites to `/main-rollover`; the launcher is the only rollover path. Plain `omp` keeps the `/main-rollover` path.
  - (b) Once a relaunch is requested (`relaunched`), `session_stop` allows the stop (no continuation), so the deferred shutdown runs at the next idle.
  - (c) An interactive owner message typed while a relaunch is pending is appended to the relaunch request's `draft` (relaunch.json rewritten atomically), the hook returns `{ handled: true }` and notifies "rollover in progress: your message goes to the new session". The launcher's handoff then carries every such message, in order.
  - (d) `/main-rollover` is single-flight: a second call while one is in flight adds its text to the pending owner message and returns without a second `newSession`; after `waitForIdle` it re-checks the state and returns if a relaunch was requested meanwhile. Exactly one `newSession` and one `sendUserMessage` per session file.
  - (e) `spawnRefusal` also refuses in `ready` (a rollover is imminent; a new subagent would be aborted).

## Forbidden
- Never push, tag, publish, link or install; never bump the version. Commit only on fix/rollover-single-owner, files added by name; never `git add -A`/`git add .`; never `--no-verify`.
- Touching the live setup (`~/.omp/agent`, `~/.local/bin`, `~/.local/state`, `~/.config`, `~/.bun/install/global`) or any repo other than this worktree. Tests run under a sandbox `HOME=/tmp/neurastream-home-*` (AGENTS.md) and fake the host as tests/rollover-omp.test.ts does.
- Changing files outside `src/adapters/omp/index.ts`, `src/adapters/omp/launch.ts` (only if (c) needs a reader change), `src/core/rollover.ts`, `tests/`, `CHANGELOG.md` (one Unreleased line), README.md "Session rollover" section (one sentence on (a)/(c)).
- Never weaken or delete an existing test to pass; where (e) changes an expectation, add a one-line reason comment.
- Every `bun test`/typecheck run goes through `/home/ukd/Work/heavy-run.sh <agent> "<label>" -- <cmd>` with tool timeout 0, in the FOREGROUND. Probe one test file before the full suite.
- `find` is broken: use grep/glob/read. One failed tool call is never a blocker; try two other ways.
- Claim rule: report only what you ran and saw (label + exit code + log path).
- Call budget: stop and report within ~100 tool calls per run (warning at 90, hard stop at 100). Commit each green unit immediately. You may append entries under `## Progress` of this plan only.
- Read /home/ukd/projects/opus-implementer-method.md first and work by it.
- The live plan-guard refuses any shell call whose text contains the word `queue-close` or `queue-cancel`; never type those words in a bash command.
- STOP and report if a fix seems to need a new npm dependency, a config key, or a change in omp itself.

## Blockers
- no-push
- deny-path /home/ukd/.omp/agent/** /home/ukd/.local/bin/** /home/ukd/.local/state/** /home/ukd/.config/** /home/ukd/.bun/install/global/** /home/ukd/.npmrc INDEX.md package.json bun.lock
- deny-command npm\s+publish bun\s+publish npm\s+link bun\s+link git\s+tag --no-verify git\s+add\s+(-A|--all|\.)

## Phases
- [x] P1 (a)+(b)+(c): launcher mode never rewrites input to `/main-rollover`; `session_stop` allows once `relaunched`; pending-relaunch input appended to relaunch.json `draft`, `{handled:true}` + notify. Tests in tests/rollover-omp.test.ts: relaunch requested → session_stop allows; two owner inputs after the request → relaunch.json draft holds both in order, no `/main-rollover` text returned; launcher `nextMessage` handoff contains both. fail-before: write the tests first, run them on the origin/main code and record the red run (label + exit code) in Progress, then fix. — difficulty: 4 — verify: `bun test tests/rollover-omp.test.ts tests/launch.test.ts`
- [x] P2 (d)+(e): single-flight `/main-rollover` (plain omp): two concurrent calls with a fake host whose `waitForIdle` resolves later → exactly 1 `newSession`, 1 `sendUserMessage`, handoff holds both owner texts; relaunch requested during the wait → 0 `newSession`. `spawnRefusal("ready", [])` refuses. fail-before: tests first, red run on the old code recorded in Progress, then fix. — difficulty: 4 — verify: `bun test tests/rollover-omp.test.ts tests/rollover.test.ts`
- [x] P3 Whole suite + typecheck green; CHANGELOG Unreleased line; README one sentence. — difficulty: 1 — verify: `bun run typecheck && bun test`
<!-- difficulty: set by Main at plan time, before any result (agent-score reads it): 1 mechanical · 2 rules · 3 new spec · 4 root-cause · 5 product fix · 8 engine. Owner may override. -->

## Done check
`cd /home/ukd/Work/neurastream-rollover-race && bun run typecheck && bun test tests/rollover-omp.test.ts tests/rollover.test.ts tests/launch.test.ts && bun test && grep -qi 'rollover' CHANGELOG.md`

## Code read by Main
- `src/adapters/omp/index.ts`
- `src/adapters/omp/launch.ts`
- `src/core/rollover.ts`

## Progress
Status: complete
- 2026-10-23 10:4x Main: first close refused (done check: :572 session_stop test read the live ledger while a real subagent ran). Fixed in PR #12 b0eb690 (99e8bf1); targeted tests 64/0 under the real HOME. npm shows 0.1.18 (no code change in #12, test only).
- 2026-10-23 queue-close: done check failed (exit 1); reopened.
- 2026-10-23 10:3x Main: reviewed the diff (eec1a56, 1ed4119, b27d35c, 1b7fb3e); own done-check run (heavy-run "ns rollover race done check") typecheck 0, 268 pass/0 fail. PR #10 squash 9ce7a30, release PR #11 cfff5c2 = 0.1.18, tag v0.1.18 pushed. Scored P1/P2/P3. Live install needs the owner's guard unlock (bun add -g refused as a guard file).
<!-- The implementer may only append dated entries here: what was done, what was verified (command +
     result), commits, what is next. It never changes the Status line or adds "WAITING on owner".
     Main reviews the work and then writes "Status: complete"; main-guard auto-runs queue-close, which
     closes the plan once the branch is on main and the done check passes (else reopens it).
     Owner calls it off: Main writes "Status: cancelled" + "Cancelled by owner: <date> "<words>"";
     queue-close archives it and adds it to docs/plans/CANCELLED.md. A new plan resembling a cancelled
     one is refused until Main checks and writes "False positive: <cancelled file> — <why>". -->
- 2026-10-23 P1 single owner path while a relaunch is pending. Red-before: `HOME=/tmp/neurastream-home-p1 heavy-run.sh NsRolloverRaceHaiku "P1 red-before" -- bun test tests/rollover-omp.test.ts tests/launch.test.ts` exit 1, 31 pass / 3 fail, log `/tmp/ns-p1-red.log`. Green: label "P1 green-after", same command, exit 0, 34 pass / 0 fail, log `/tmp/ns-p1-green2.log`. Commit `eec1a56`.
- 2026-10-23 P2 single-flight `/main-rollover`; ready refuses new spawns. Red-before: label "P2 red-before", `bun test tests/rollover-omp.test.ts tests/rollover.test.ts`, exit 1, 48 pass / 5 fail, log `/tmp/ns-p2-red.log`. Green: label "P2 green-after", same command, exit 0, 53 pass / 0 fail, log `/tmp/ns-p2-green.log`. Commit `1ed4119`.
- 2026-10-23 P3 docs (CHANGELOG Unreleased line, README sentences). Label "P3 full verify": `bun run typecheck && bun test`, exit 0, 268 pass / 0 fail, log `/tmp/ns-p3-full.log`. Acceptance Done check, label "P3 done check": exit 0, 268 pass / 0 fail, log `/tmp/ns-done-check.log`. Commit `b27d35c`.
- Deviations: (1) under the launcher, the input hook also takes owner messages in the ready state (otherwise they ran as a normal prompt in the old session); (2) `/main-rollover` is refused under the launcher; (3) when a rollover is aborted by a state change, the pending owner text is sent to the current session as an ordinary message, not dropped; (4) "relaunch requested during the wait" is tested with a job starting during the wait, because only the launcher sets relaunch and plain omp cannot reach it; (5) `resetState` clears `NEURASTREAM_MAIN_LAUNCHER`, and the plain-omp test pins it off, because the shell exports it; (6) the spawn-drain test is renamed to state that ready refuses.
- Open for Main: `launch.ts` labels the relaunch draft "Owner's unsent draft". Messages typed during a pending rollover are now sent, not only unsent. I did not change the label, to avoid touching the reader; decide whether to relabel.
- 2026-10-23 follow-up (Main review): `src/adapters/omp/launch.ts` label is now `Owner's messages during the rollover (and any unsent draft): `; `tests/launch.test.ts` lines 139 and 151 updated (151 also asserted the old label). Label "label relabel launch test": `bun test tests/launch.test.ts`, exit 0, 11 pass / 0 fail, log `/tmp/ns-label-launch.log`. Label "label relabel full verify": `bun run typecheck && bun test`, exit 0, 268 pass / 0 fail, log `/tmp/ns-label-full.log`. Commit `1b7fb3e`.
- 2026-10-23 follow-up (Main, after PR #10 merged): `tests/rollover-omp.test.ts` "no relaunch: session_stop still blocks on the open plan" failed under the real HOME, because session_stop read the live `guards.ledger_command` and a real subagent let the stop through. Both session_stop tests (the launcher one at :554 and the no-relaunch one at :572) now use `stopCfg`, whose ledger prints a fixed `MAIN x RUNNING` row. Branch `fix/rollover-stop-test-isolation` from origin/main `cfff5c2`. Verify: `bun test tests/rollover-omp.test.ts tests/rollover.test.ts tests/launch.test.ts` under the sandbox HOME (label "stop isolation sandbox HOME") exit 0, 64 pass / 0 fail, log `/tmp/ns-iso-sandbox.log`; same under the real HOME (label "stop isolation real HOME") exit 0, 64 pass / 0 fail, log `/tmp/ns-iso-real.log`; `bun run typecheck && bun test` (label "stop isolation full verify") exit 0, 268 pass / 0 fail, log `/tmp/ns-iso-full.log`. Commit `99e8bf1`. Not pushed.


## Background
- Evidence files: `~/.omp/agent/sessions/-projects/2026-10-22T18-11-47-386Z_01a164cf-…jsonl` (07:45-07:53Z: `session-stop-continuation` entry id 1a8d7bb3 after the relaunch request), `2026-10-23T07-53-21-415Z_…jsonl` (523 B), `2026-10-23T07-53-21-416Z_…jsonl` (two handoffs, `session_exit` 07:56:00), `~/.local/state/main-guard.log` lines `rollover:` 07:46:02, 07:46:22, 07:48:13, 07:56:07.
