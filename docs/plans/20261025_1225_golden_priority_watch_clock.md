# Flaky golden test: priority-watch clock minute
Worktree: /home/ukd/Work/neurastream-golden-clock
Branch: fix/golden-pw-clock

Read /home/ukd/projects/opus-implementer-method.md first.

## Goal
- Self-found bug (Main, 2026-10-25): the release publish for v0.2.18 failed once because "priority-watch matches the original" compared a wall-clock minute ("11:06") that rolled over between the oracle run and the port run. A second flake mode, from NsResetLocalLuna's "reset full final" (12:2x, 722 pass / 1 fail): the same test hits Bun's default 5 s test timeout under full-suite load (it runs two child processes, each with a 15 s spawnSync timeout); it passed alone with `--timeout 15000`. The test must stay deterministic across a minute boundary and under load, and still prove the port prints the same output shape.

## Forbidden
- Changing anything under src/ (the port's output is correct; only the test is flaky).
- Deleting or skipping the test, or loosening the stdout compare beyond the one clock line.
- Never push, merge, tag or publish; commit files by name (never `git add -A`/`.`), never `--no-verify`.

## Blockers
- no-push
- deny-path src/**
- blockers/golden-clock-scope.sh

## Phases
- [x] P1 Normalize the clock line and fit the timeout. In tests/golden/ports-p4.test.ts "priority-watch matches the original" (:611-626): both outputs print `date '+%H:%M'` as the first stdout line (oracle tests/fixtures/originals/bin/priority-watch:8, port src/core/priority-watch.ts:15-16). Add a helper next to stripTs/stripLoadavg (:105-111), e.g. `stripClock(s)` replacing a whole line `^\d{2}:\d{2}$` (multiline, first match only) with `HH:MM`; first assert each stdout's first line matches /^\d{2}:\d{2}$/, then compare `stripClock(port.stdout)` to `stripClock(py.stdout)`. Status and stderr compares unchanged. Give this test an explicit per-test timeout of 35_000 ms (third argument of `test`, covering both 15 s spawnSync timeouts), not a global one. CHANGELOG: `## Unreleased` / `### Fixed` one line (golden test flaked on a minute rollover between the two runs and on the 5 s default timeout under load). — difficulty: 1 — verify: `cd /home/ukd/Work/neurastream-golden-clock && bash /home/ukd/projects/neurastream/docs/plans/blockers/golden-clock-scope.sh </dev/null && /home/ukd/Work/heavy-run.sh agent "golden clock" -- sh -c 'bun test tests/golden/ports-p4.test.ts && bun run typecheck'`

Suite runs go through `/home/ukd/Work/heavy-run.sh agent "<label>" -- <cmd>`. Stop and report within ~40 calls.

## Done check
`git -C /home/ukd/projects/neurastream merge-base --is-ancestor fix/golden-pw-clock origin/main`

## Code read by Main
- `tests/golden/ports-p4.test.ts` (stripTs/stripLoadavg :105-111; priority-watch test :611-626)
- `src/core/priority-watch.ts` (date +%H:%M then the IDLE line, :15-17)
- `tests/fixtures/originals/bin/priority-watch` (oracle: `date '+%H:%M'; echo "$out"`, :8)

## Progress
Status: open
- 2026-10-25 13:12 Main: INCIDENT I-20261025-132 (NsTracesBriefsHaiku saw ports-p4.test.ts:624 fail on "12:51" vs "12:52") is this plan's bug; fixed by b5f17df, closes when merged. Findings: none
- 2026-10-25 13:00 Main (for NsGoldenClockLuna, cannot write outside its worktree): P1 committed b5f17df (tests/golden/ports-p4.test.ts: stripClock :108-110, first-line HH:MM asserts + stripClock compare + per-test 35_000 timeout :627-631; CHANGELOG Unreleased/Fixed). heavy-run "golden clock" END exit 2 12:47:50, exit 0 12:52:52 (P1 verify, 13 pass), exit 0 12:55:10 (full suite 751 pass, 3 skip, 0 fail; tsc clean). Main read the diff: status/stderr compares unchanged, nothing under src/. The agent's report said no END lines appeared; they are in /home/ukd/Work/.heavy-run.log 10155-10163. Merge with traces_04 + reset-time into 0.2.19. Findings: none
- 2026-10-25 12:48 Main: moved to INDEX rank 5 (after reset_time_local, before the PM plans): the 0.2.19 release of traces_04 (owner's first priority) runs the full suite in the publish workflow, and this flake failed the v0.2.18 publish once. Forbidden now carries the standard never-push line (brief-lint). Spawning luna for P1. Findings: none
- 2026-10-25 12:25 Main: plan written for a self-found flaky test (publish run 40187396260 failed at tests/golden/ports-p4.test.ts:624, rerun passed). Worktree from origin/main 8841e83; blocker golden-clock-scope.sh written. Findings: none
