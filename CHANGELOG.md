# Changelog

## 0.1.8
### Fixed
- Session rollover froze omp for about 90 s: `main-rollover` ran the six `main-start` children with `spawnSync` on omp's only thread. The command now shows a notice at once and gathers main-start asynchronously; the `main-start` CLI output is unchanged.
- `agent-ledger` parsed every session file under the sessions dir before filtering by age (about 45 s for `--hours 12` on a 12 GB sessions dir). Files older than the window are now skipped unread.
- `agent-ledger --cap` counted every RUNNING or WAITING agent as using a provider slot, so agents whose sessions had died hours earlier could still make a provider FULL. An agent with no write for `ledger.idle_not_live_min` minutes (default 60) is now left out of the count and listed on a `NOT LIVE` line.

## 0.1.7
### Fixed
- `wip-check` no longer crashes on a linked worktree under a work root (git prints its common dir as an absolute path; it was joined onto the repo path), and lists unlanded branches with equal commit times in the same order as the original. `main-start` showed "wip-check gave no summary" because of the crash.
- `scripts/cutover.sh`: the plan picker's sed works on GNU sed; the before/after capture ignores finished agent-ledger rows that age out of the 12 h window during the run and the owner-hold reason the queue summary now shows.

## 0.1.6
### Fixed
- Cutover on a machine whose queue lives under `~/.omp/agent` no longer points the package at an empty `~/.config/neurastream/INDEX.md`: `neurastream init --agent-dir <dir>` keeps the index, notes, blockers, CANCELLED and unlock under `<dir>` and leaves `<dir>/queue/` to the adapter; `scripts/cutover.sh` passes `--agent-dir ~/.omp/agent` when `~/.omp/agent/INDEX.md` exists.
- `scripts/cutover.sh`: the HOME listing skips dirs the owner cannot read (rootless container storage); the before/after capture ignores idle-minute counters and lints the first plan the queue lists instead of any file under `docs/plans`.

## 0.1.5
### Fixed
- Process storm (fork bomb) under omp: auto-close and main-start ran `process.execPath <pkg>/src/cli/main.ts …`. Inside omp, `process.execPath` is the omp binary, so each close started a new omp session that loaded the plugin and auto-closed again, until memory ran out. Both now run the package's own executables (`bin/queue-close`, `src/cli/main.ts`). Regression test fakes `process.execPath` and checks it is never called.
- The idle-stop spin guard reset on the guard's own stop continuation, so a model that only replied text was nudged forever. Continuation turns now keep the streak.
- Main can no longer rewrite a plan file through the shell (`cat > plan`, `sed -i`): that route skipped Main's plan-text checks. Plans change through edit/write.
- One load route: `install` no longer links the extensions dir (plugin only) and removes only a stale symlink there; `doctor` lists the plugin link.
- Guard parity for the installed package (P8).
### Added
- `scripts/omp-sandbox-session-test.sh`: isolated real-omp session test (sandbox HOME, nine checks C1-C9, reaps its omp processes, refuses low memory, watchdog on process count/memory, no live `~/.local/bin` on the model's PATH).

## 0.1.4
### Fixed
- Release 0.1.3 was never published: its CI went red on GitHub runners only. `rollover-omp.test.ts` runs the omp adapter in-process, which writes `QUEUE_*` into the test process env. When bun ran that file first, the guard children in the guard tests inherited the runner's default `QUEUE_AGENT`, which beats the sandbox config, so 4 refusal tests saw "allowed". The guard tests now drop inherited `QUEUE_*`, and the rollover test restores what it wrote. A regression test simulates the leak. 0.1.4 ships everything listed under 0.1.3.

## 0.1.3
### Added
- Main reads the code for its plans: the omp adapter logs every file Main reads (Main read log; `touchedPaths` now applies `cd` left to right). Main's plan text must cite code it read within `plan_read_max_hours`. Plans stamped `20261021_0100` or later need a `Code read by Main` section (queue-check).
- Spawn guard: a brief must name an unticked phase of an open plan; research spawns for a plan are refused (Main researches its own plans).
- Session rollover: when Main's session file grows past `rollover.max_session_mb`, Main writes a handoff note, waits for running jobs and the owner's next message, then continues in a fresh session. Manual `/main-rollover` command. Rollover config and events are documented in the README "Session rollover".
- Owner holds come only from plans: the queue summary, compaction and handoff carry each plan's `WAITING on owner:` line, never holds from carried session notes.

## 0.1.2
### Added
- `agent-score validate <Agent> --plan <plan.md> --phase <P> --evidence <report.md> --section "<heading prefix>" [--weight N] [--rework] [--note T]`: score a validation phase (checks/tests ran, report section written, no commits). Records one `type: "validate"` jsonl line only when every guard holds: the plan's phase line is ticked `- [x]` (weight from its `difficulty: N`; `--weight` overrides), the evidence file has a heading starting with `--section` where the prefix ends at end-of-line, space or `(` (`## CP` matches `## CP (P5, ...)`, not `## CPX`) and its body to the next same-or-higher heading is non-blank, the body cites verbatim at least one `paths.heavy_log` `END   <Agent> | <label> | exit <n>` label run by that agent (the cited labels are recorded), and no earlier `accept`/`validate` covers the same agent+plan+phase. Any failed guard exits 1 with the reason and records nothing.
- Ranking board: column `Accepted (diag)` is now `Accepted (diag/val)`, cells `N (d/v)`; `validate` adds points and first-pass counts like `accept` (unless `--rework`).
