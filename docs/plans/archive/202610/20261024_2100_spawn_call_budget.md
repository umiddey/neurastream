# Per-spawn call budget, set by Main at spawn time
Worktree: /home/ukd/projects/neurastream-spawn-budget
Branch: feat/spawn-call-budget

## Goal
- Owner (2026-10-24 ~20:50): "Lets parametrize the limit during spawn time." Today every subagent gets the same global `guards.sub_max_calls` (100, warning at `sub_warn_calls` 90), read in src/core/guards.ts:290-294 (hard stop) and :475-481 (warning), src/adapters/omp/sessions.ts:168-169 and src/core/agent-ledger.ts:88-91 (OVER-BUDGET).
- Wanted: Main writes `Call budget: <N>` in a task's brief (the `task` text or the shared `context`); that run's hard stop is N and its warning is N minus (sub_max_calls − sub_warn_calls), floored at 1. A task without the line keeps the global values. N outside [10, `guards.sub_max_calls_cap`] (new config key, default 200) refuses the spawn with the allowed range. A task that sets a budget must carry a `name` (the sub's tool calls arrive keyed by that name, see the BLOCK sub:<name> lines in the plan-guard log), else the spawn is refused.
- Owner: the 50-vs-100-call comparison is NOT part of this plan; the owner tests it on real plan work after release.

## Forbidden
- Read /home/ukd/projects/opus-implementer-method.md first and work by it. Read the repo AGENTS.md.
- Work only in /home/ukd/projects/neurastream-spawn-budget on feat/spawn-call-budget. Never push, merge, tag or publish; never change the package.json version or CHANGELOG release headings (Main releases). Commit files by name; never `git add -A`/`.`; never `--no-verify`.
- Never touch live copies (~/.omp/agent/**, ~/.bun/**) or the live queue index.
- Tests assert behaviour (deny/allow, the limit used, exit codes), never wording or source text.
- Every phase is fail-before: write the test, run it red, record the red run, then change src.
- Every test run via `/home/ukd/Work/heavy-run.sh <agent> "<label>" -- <cmd>` with tool timeout 0. Green = `bun test` at the worktree root plus `bun run typecheck`.
- Call budget: stop and report within ~60 calls. Add ONE dated bullet under `## Progress` after the `Status:` line.

## Blockers
- no-push
- deny-path /home/ukd/.omp/agent/** /home/ukd/.bun/** INDEX.md
- deny-command --no-verify git\s+add\s+(-A|--all|\.)(\s|$) git\s+push\b git\s+merge\b git\s+tag\b npm\s+publish reset\s+--hard

## Phases
- [x] P1 Red tests: (a) a Main `task` call whose task brief has `Call budget: 50` and name X is allowed and records 50 for X; (b) sub X is denied at call 50 (only plan Progress reads/edits pass, as today at the global limit) and gets the warning inject at call 40 when the global gap is 10; (c) a sub with no recorded budget still stops at sub_max_calls; (d) `Call budget: 5` and `Call budget: 500` with cap 200 are refused at spawn; (e) a budget without a task `name` is refused; (f) a budget in the shared `context` applies to every task of the call, a task's own line wins; (g) the ledger's OVER-BUDGET check uses X's budget. Record the red run — difficulty: 3 — verify: `cd /home/ukd/projects/neurastream-spawn-budget && /home/ukd/Work/heavy-run.sh agent "spawn budget red" -- bun test tests/spawn-budget.test.ts`
- [x] P2 Implement: parse the line in `spawnProblem`/`mainTool` (src/core/guards.ts:234-247, :388-405), persist name → N in a state file next to the spawn hashes (`recordSpawns`, src/core/guards.ts:94-107), read it in the sub path (src/core/guards.ts:290-294 and :475-481) and in the ledger (sessions.ts:168, agent-ledger.ts:88-91); add `guards.sub_max_calls_cap` to src/core/config.ts with validation (cap ≥ sub_max_calls); brief-lint (src/core/brief-lint.ts:85-88) accepts `Call budget: <N>` as the budget line. README/docs section for the line; CHANGELOG `## Unreleased` → Added. Full suite green — difficulty: 3 — verify: `cd /home/ukd/projects/neurastream-spawn-budget && /home/ukd/Work/heavy-run.sh agent "spawn budget full" -- bun test`
- [x] P3 Main: review, merge to main, release by tag, install after the owner's guard unlock, `neurastream doctor` exit 0 — difficulty: 1 — verify: `neurastream doctor`
- [x] P4 Main: live smoke: spawn one small task with `Call budget: 15`; the plan-guard log shows the hard stop at 15 — difficulty: 1 — verify: `grep -c "call budget spent (15/15)" /home/ukd/.local/state/plan-guard.log`

## Done check
`git -C /home/ukd/projects/neurastream merge-base --is-ancestor feat/spawn-call-budget origin/main && neurastream doctor`

## Code read by Main
- `/home/ukd/projects/neurastream/src/core/guards.ts` (recordSpawns :94-107; spawnProblem :234-247; mainTool task branch :388-405; sub hard stop :290-294; warning :475-481)
- `/home/ukd/projects/neurastream/src/adapters/omp/index.ts` (tool_call hook :319-356: sub calls counted per ctx agent id; Main task calls go through checkTool)
- `/home/ukd/projects/neurastream/src/adapters/omp/sessions.ts` (OVER-BUDGET :168-169)
- `/home/ukd/projects/neurastream/src/core/agent-ledger.ts` (OVER-BUDGET line :88-91)
- `/home/ukd/projects/neurastream/src/core/config.ts` (guards keys :100-105; validation :280-282)
- `/home/ukd/projects/neurastream/src/core/brief-lint.ts` (budget line rule :85-88)
- `/home/ukd/projects/neurastream/src/core/adapter.ts` (ToolEvent agentId :54-64)

## Progress
Status: complete
- 2026-10-25 01:12 Main: P4 verified. plan-guard.log `2026-10-24T23:08:49Z BLOCK sub:NsBudgetSmokeGlm tool=read call budget spent (15/15)`; grep count 1. All phases done. Findings: none
- 2026-10-25 (NsBudgetSmokeGlm): P4 live smoke, sub side. Did: read the plan, then the 20 briefed files one tool call each (first 20 lines) in /home/ukd/projects/neurastream. Verified: the per-spawn budget of 15 worked live — warning injects at calls 5–14/15 ("Update your plan's "## Progress" now…"), and the hard stop refused call 15 (the read of src/cli/dispatch.ts) with (first 80 chars, char 80 is a space): `plan-guard: call budget spent (15/15). Only reading and editing your plan's "## ` — matches P1 (b) warn at N−10 and stop at N. Next: Main `grep -c "call budget spent (15/15)" /home/ukd/.local/state/plan-guard.log` for NsBudgetSmokeGlm and tick P4. Findings: none
- 2026-10-25 ~02:40 Main: P3 done. Released in 0.2.5 (708d77e), carried in the installed 0.2.10; `neurastream doctor` → ok. P4 not yet seen: plan-guard log has no `(N/N)` stop other than /100 since 0.2.5 (the /30 lines are from 2026-10-15). Next: P4 smoke spawn with `Call budget: 15`. Findings: none
- 2026-10-24 ~21:30 Main: reviewed 84a0d9c..42b3fdd. Bug found: a name respawned without a `Call budget:` line kept its old budget (stale entry in spawn-budgets.json), and budgets were recorded before the incident check could still deny the spawn. Fixed in 5a43f33 (spawnProblem returns every named task's budget, null = none; mainTool records after the incident check; recordBudgets deletes null) with a fail-first test (heavy-run "spawn budget respawn red" failed at the X-at-50 assertion; "spawn budget full" by main: 423 pass / 3 skip / 0 fail, tsc clean). Merged d19d9ac, released 708d77e tag v0.2.5. Next: install needs the owner's guard unlock (`touch ~/.omp/agent/.guard-unlock`), then doctor, then P4 smoke. Findings: incident detector D2 files an intended red test run under heavy-run as a "tool crash" (I-20261024-22/23, dismissed) — src/core/incident-detectors.ts
- 2026-10-24 ~21:55 Main: agent report received. Heavy-run log confirms "spawn budget red" exit 1 (20:59–21:01) and "spawn budget full" exit 0 (21:13); tree clean at 42b3fdd. Not yet done (next session): review `git diff 84a0d9c..42b3fdd`, confirm the red run failed on assertions (not a compile error), then P3 (merge, tag release, install after the guard unlock, doctor) and score NsSpawnBudgetGlm after the merge. The zai slot is free again for the lint plan-1 spawns. Findings: none
- 2026-10-24 23:4x CEST (NsSpawnBudgetGlm): P1+P2 DONE, commits ba65d29 (tests/spawn-budget.test.ts red, P1) + 42b3fdd (P2: guards.ts, config.ts, agent-ledger.ts, brief-lint.ts, omp/sessions.ts, templates/config.yml, tests/spawn-budget.test.ts, README.md, docs/config.md, CHANGELOG.md) on feat/spawn-call-budget, tree clean, no push/merge/tag. Red run BEFORE any src change: heavy-run "spawn budget red" exit 1 (7 fail / 1 pass). Green: heavy-run "spawn budget full" — `bun test` exit 0 (425 tests / 48 files, 0 fail, 3 skip) and `bun run typecheck` exit 0. Coverage (a)–(g) in tests/spawn-budget.test.ts via `guard pre-tool --json` sandbox + omp session ledger. Design: `Call budget: <N>` parsed by line regex in spawnProblem (new cfg param), budgets keyed by task name in `<queue_state>/spawn-budgets.json` (readBudgets/recordBudgets/subCallCap next to recordSpawns); subRules/checkTool cap the sub by name (warn = N − gap, floored at 1); sessions.ts OVER-BUDGET per run id; agent-ledger prints per-run caps only when a budget differs — all-global keeps the original line bit-for-bit (golden ports.test.ts pinned that, caught my first version, fixed not waived). config: `guards.sub_max_calls_cap` default 200, validation cap ≥ sub_max_calls. brief-lint accepts the line. Runbook: none needed (neurastream, not PM/CP; no docs/instructions/ in the worktree — gate 0 missing). P3/P4 untouched (Main's). Findings: omp's edit tool carries the target as a `[path#file]` marker inside `input.input`, not a `path` key (queue/lib.ts writeTargets) — test harness first used the wrong shape; ledger listRuns only finds session files at `sessions/<dir>/*.jsonl`, one dir level down, never at the root.
- Older Progress entries: archive/20261024_2100_spawn_call_budget-progress.md
