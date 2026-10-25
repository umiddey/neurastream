# Ledger: a helper that finished with a final message is done, not RUNNING
Worktree: /home/ukd/Work/neurastream-ledger-final
Branch: fix/ledger-final-text-done

## Goal
- Owner rule (AGENTS.md, 2026-10-19): every script change goes to neurastream with a test. Finding 2026-10-22 23:0x: a helper that ends with a final text answer and no `yield` call (omp delivers it as `status="completed"`) stays `RUNNING` in `agent-ledger`. Past 100 calls it is also flagged `OVER-BUDGET`, and `agent-ledger --cap` exits 1, which blocks every spawn for 60 minutes until the idle rule drops it. After the fix such a helper shows `done`, and only a helper that is really still working blocks the cap.

## Forbidden
- Never push, never open a PR, never tag or publish (Main does). Commit only on `fix/ledger-final-text-done`, files added by name; never `git add -A`/`git add .`; never `--no-verify`.
- Change only `src/adapters/omp/sessions.ts` and one new test file `tests/ledger-final-text.test.ts`, plus one `CHANGELOG.md` line under the unreleased section. Nothing else.
- Never edit the live install (`~/.bun/install/global/**`, `~/.local/bin/**`, `~/.omp/agent/extensions/**`) or any real session file under `~/.omp/agent/sessions/**`.
- Never weaken or delete an existing test.
- `find` is broken: use grep/glob/read. One failed tool call is never a blocker; try two other ways.
- Every test run goes through `/home/ukd/Work/heavy-run.sh <agent> "<label>" -- <command>` with tool timeout 0.
- Green bar: `bun run typecheck` exit 0 AND `bun test` exit 0, both in the worktree.
- Claim rule: report only what you ran and saw (command + exit code).
- Call budget: stop and report within ~100 tool calls (warning at 90). Commit each green unit immediately. By call 85, append ONE dated bullet under `## Progress` (after `Status:`; never touch `Status:`/`WAITING on owner:`). Never ask questions at the end; just STOP.
- Read /home/ukd/projects/opus-implementer-method.md first and work by it. Read the repo `AGENTS.md`.

## Blockers
- no-push
- deny-path /home/ukd/.bun/install/global/** /home/ukd/.local/bin/** /home/ukd/.omp/agent/extensions/** /home/ukd/.omp/agent/sessions/**
- deny-command --no-verify git\s+add\s+(-A|--all|\.)(\s|$) reset\s+--hard npm\s+publish git\s+tag

## Phases
- [x] P1 Fix and test. Create the worktree from `origin/main` (`git -C /home/ukd/projects/neurastream fetch origin && git -C /home/ukd/projects/neurastream worktree add /home/ukd/Work/neurastream-ledger-final -b fix/ledger-final-text-done origin/main`, then `bun install`). In `src/adapters/omp/sessions.ts`, the parser already computes `final` (:117: last assistant message has `stopReason` stop/end_turn and non-empty text; reset on every new assistant message, :109-118) and `done = yielded || final` (:160), but the state at :162 uses only `yielded`. For a helper (id not starting with `MAIN`), a run whose last assistant message is `final` is `done`, the same as a yielded one. Main sessions keep today's rule. A helper whose last assistant message is `toolUse` (still working) stays RUNNING, and OVER-BUDGET still applies to it. A helper with an `errorMessage` and no final text is still `DIED`. New test `tests/ledger-final-text.test.ts` writes small throwaway session JSONL files in a temp dir and parses them through the same entry point the ledger uses (read how `sessions.ts` exports it; follow the setup style of `tests/ledger-not-live.test.ts`): (1) helper, 120 calls, last line assistant `stop` with text, no yield → `done`, no `OVER-BUDGET`; (2) helper, 120 calls, last line assistant `toolUse` → `RUNNING … OVER-BUDGET`; (3) helper, last assistant `stop` with text, then a later `user` message and an assistant `toolUse` (it was steered and resumed) → RUNNING; (4) a `MAIN` session ending in `stop` with text keeps today's state. Each case must fail on the code before the fix for (1); say which ones in Progress. — difficulty: 2 — verify: `cd /home/ukd/Work/neurastream-ledger-final && bun run typecheck && bun test`
- [x] P2 (Main only) Review, PR, merge, release via tag, `bun add -g neurastream@latest`, `neurastream adapter install omp`, `neurastream doctor` exit 0. — difficulty: 1 — verify: `neurastream doctor`

## Done check
`cd /home/ukd/Work/neurastream-ledger-final && git fetch -q origin && gh pr view fix/ledger-final-text-done --json state -q .state | grep -qx MERGED && git checkout -q --detach origin/main && bun test` (PRs are squash-merged, so HEAD is never an ancestor of origin/main; the check proves the PR merged and the tests pass on main)

## Code read by Main
- `src/adapters/omp/sessions.ts`
- `src/core/agent-ledger.ts`
- `src/core/guards.ts`
- `tests/ledger-not-live.test.ts`

## Progress
Status: complete
- 2026-10-23 06:2x Main: done check changed to be squash-merge aware (queue-close refused: HEAD not an ancestor after squash merge; `git diff HEAD 6e5f4f8` is empty).
- 2026-10-23 queue-close: done check failed (exit 1); reopened.
- 2026-10-23 06:1x Main: P2 done. PR #6 squash-merged as 6e5f4f8 (v0.1.15, published); 0.1.16 installed on top; `neurastream doctor` exit 0; `agent-ledger --cap` shows finished agents as done ("running per provider: {}").
- 2026-10-23 00:0x Main: reviewed bea3ff0 (one-line change + 4 tests, fail-before shown). Added version bump 0.1.15, PR #6 CI green, squash-merged as 6e5f4f8, tag v0.1.15, publish workflow 39857429965 success (`npm notice neurastream@0.1.15`; registry lag). Scored NsLedgerFinalGlm P1. Left: install; `bun add -g` refused by plan-guard (protected guard file), needs owner `touch ~/.omp/agent/.guard-unlock`.
- 2026-10-22 23:5x NsLedgerFinalGlm: P1 done. Commit `bea3ff0` on `fix/ledger-final-text-done` (worktree `/home/ukd/Work/neurastream-ledger-final`, clean after commit; nothing pushed). Change: `sessions.ts:162` `if (yielded && !id.startsWith("MAIN"))` → `if (!id.startsWith("MAIN") && (yielded || final))` — helpers with a final last assistant message are `done` (OVER-BUDGET disappears with the RUNNING state), MAIN keeps today's rule, `done`/score fields at :160 untouched; + `tests/ledger-final-text.test.ts` (4 cases via `ompRunSource().listRuns(0)`) + one `CHANGELOG.md` Unreleased line. Pre-fix (heavy-run "ledger-final-text pre-fix", exit 1): case (1) FAILED — `status` Expected `"done"` Received `"running"` (state RUNNING + `OVER-BUDGET(120>100 calls)`); cases (2)(3)(4) passed pre-fix (they pin unchanged behavior). After (heavy-run "ledger-final-text green"): `bun run typecheck` (tsc --noEmit) exit 0 and `bun test` exit 0 — 208 pass, 0 fail, 21 files. Forbidden-names scan at `bea3ff0`: 0 hits in src/tests/docs/templates/config.yml (only pre-existing rule text in `templates/agents/*.md`, identical at parent ad5c64b).
- 2026-10-22 23:1x Main: evidence. `AmiiirP9RunGlm.jsonl` and `PmP6SlaRaceHaiku.jsonl` (session dir `2026-10-22T18-11-47-386Z_01a164cf…`) both end with an assistant message `stopReason: stop` + text, no `yield` toolResult; omp delivered both as `status="completed"`. `agent-ledger` still shows both `RUNNING`, and AmiiirP9RunGlm `OVER-BUDGET(137>100 calls)`, so `agent-ledger --cap` exits 1.
Gate before: 0 missing (neurastream has no Gateforge config; before->after = finished helper shown RUNNING → done).

## Background
- `write proc://<id>/kill` reports "not found" for such a helper: it is idle, not a job, so there is no way to end it by hand.
