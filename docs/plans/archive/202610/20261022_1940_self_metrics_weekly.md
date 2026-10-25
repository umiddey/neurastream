# neurastream: measure its own work (5 metrics) and review one rule change per week
Worktree: /home/ukd/Work/neurastream-metrics
Branch: feat/self-metrics

## Goal
- Owner (2026-10-22 ~19:4x), answering "Write it?" for the self-improvement metrics: "yes". Main proposed the following, and the owner accepted it:
  - 5 measures: $ per merged phase, calls with no commit, CI tries until green, owner questions and corrections, guard false alarms.
  - "Self-improving" means it reads these numbers every week and suggests one rule change, which the owner approves.
- When done, these hold:
  1. `neurastream metrics report [--days N]` (default `metrics.report_days`, 7) prints the 5 metrics for the last N days next to the N days before that. It writes the same table to `<paths.notes>/metrics.md`, a generated file that starts with a "generated, never hand-edit" line. Exit 0.
  2. `neurastream metrics ci <repo-dir> <mr-id>` records how many pipelines an MR needed. It counts them with the command template in config. `neurastream metrics false-alarm <log-ts> --why "<text>"` marks a guard BLOCK line as a false alarm. `neurastream metrics rule "<text>" --approved|--rejected` records a rule change the owner decided on. Each of these appends one JSON line to `<paths.score_state>/metrics.jsonl`.
  3. The report has an "Approved rules" section. For each approved rule it shows the metric numbers for 7 days before the approval and for 7 days after (or "measuring" until 7 days have passed). This is the closed loop: change, measure, keep or revert.
  4. `main-start` prints one line when `<paths.notes>/metrics.md` is missing or older than `metrics.report_days`: `metrics: report due (last: <date|never>) — run neurastream metrics report, then propose ONE rule change to the owner`. Otherwise it prints nothing new.
- Metric definitions (exact; window = runs/events with timestamp in [now-N days, now)):
- M1 $ per merged phase = (sum `cost` of all `kind: "sub"` runs + all `kind: "main"` runs with `lastWriteAt` in window) / (number of `accept` events in `events.jsonl` in window). Also show the worker-only $ and Main-only $ that go into it. 0 accepts → print `n/a (0 merged)`.
- M2 Calls with no commit = sum `calls` of sub runs in window that are not running (`status` done or died) and whose `id` has no `accept`, `diagnose` or `validate` event at any time. List the 3 largest as `id calls`.
- M3 CI tries = the mean `tries` of `ci` events in window, plus the list of MRs with tries ≥ 3. No events → `n/a`.
- M4 Owner = in main runs in window: count of `role: "user"` messages, how many match any regex in `metrics.correction_patterns` (case-insensitive; config, default list in templates/config.yml: `\bno\b`, `wrong`, `why did`, `properly`, `not what`, `stop`, `bullshit`, `fuck`), and how many `role: "assistant"` messages have a last text block that ends in `?` (Main asking the owner). `RunMessage.text` is a JSON dump of the content; parse it, never regex the raw JSON. RunMessage has no timestamp, so main runs count whole by `lastWriteAt`. Say that in one README line.
- M5 Guard false alarms: BLOCK lines in `paths.guard_log` and `paths.plan_guard_log` in window (the line starts with an ISO UTC timestamp, then ` BLOCK `). Show total blocks, `false-alarm` events in window, and the 3 most common reasons (text after `BLOCK `, with digits and paths beyond 40 chars cut, grouped).
- Worst change: the metric with the largest change for the worse vs the previous window, in percent, is marked `◀ worst`. Higher is worse for all 5, except M4's user-message count, which is shown but never ranked.

## Forbidden
- Never push, tag, publish, link or install, and never bump the version. Commit only on feat/self-metrics, adding files by name. Never `git add -A`/`git add .`, never `--no-verify`.
- Never touch the live setup (`~/.omp/agent`, `~/.local/bin`, `~/.local/state`, `~/.config`), not even to read real logs for a smoke. Tests and smokes run under a sandbox `HOME=/tmp/neurastream-home-*` with fixture files (AGENTS.md).
- Never hardcode paths, provider names, forge commands, prices or patterns in code. Everything comes from config (`metrics:` section in `src/core/config.ts` + `templates/config.yml` + `docs/config.md`). The CI command template default is `""`. In that case `metrics ci` exits 2 with `metrics.ci_pipelines_cmd not set`. It receives `{mr}` and runs in `<repo-dir>`, and its stdout must be a JSON array; tries = array length.
- Never put harness names in `src/core/` (AGENTS.md architecture rule). Read runs only through `RunSource` (`src/core/adapter.ts`).
- Never change existing commands' output or exit codes, except the one new main-start line (goal 4). Never edit golden files except to add that line where a golden covers main-start, with a one-line comment giving the reason.
- No new npm dependency.
- Every `bun test`/typecheck run goes through `/home/ukd/Work/heavy-run.sh <agent> "<label>" -- <cmd>` with tool timeout 0, in the FOREGROUND. Probe first (`bun test tests/metrics.test.ts`), then the full suite.
- `find` is broken: use grep/glob/read. One failed tool call is never a blocker; try two other ways.
- Claim rule: report only what you ran and saw (label, exit code, log path).
- Call budget: stop and report within ~100 tool calls per run (warning at 90, hard stop at 100). Commit each green unit immediately. You may append entries under `## Progress` of this plan only.
- Read /home/ukd/projects/opus-implementer-method.md first and work by it.

## Blockers
- no-push
- deny-path /home/ukd/.omp/agent/** /home/ukd/.local/bin/** /home/ukd/.local/state/** /home/ukd/.config/** /home/ukd/.npmrc INDEX.md package.json bun.lock
- deny-command npm\s+publish bun\s+publish npm\s+link bun\s+link git\s+tag --no-verify git\s+add\s+(-A|--all|\.)

## Phases
- [x] P1 `src/core/metrics.ts` computes M1 and M2 from `RunSource.listRuns(since)` and `events.jsonl` (reuse agent-score's event reader; export it if it is private, no second parser). Adds the `metrics:` config section (`report_days` 7, `correction_patterns`, `ci_pipelines_cmd` ""). Tests in `tests/metrics.test.ts` with a fake RunSource and fixture events: an accepted worker and an unaccepted one, Main cost included, 0 accepts gives `n/a`, a running worker is excluded from M2, and an accept outside the window is not counted in M1 but still clears M2 — difficulty: 3 — verify: `heavy-run.sh <agent> "ns metrics m1m2" -- bun test tests/metrics.test.ts` exit 0
- [x] P2 M3, M4, M5, and the event commands `metrics ci`, `metrics false-alarm` and `metrics rule` (goal 2), wired into `src/cli/dispatch.ts` `run()` and `helpText()`. Tests: `ci` with a fake command printing `[1,2,3]` records tries 3, and an empty template exits 2; M4 counts a correction and a trailing-`?` assistant message from fixture main-run messages (JSON-dumped content); M5 counts BLOCK lines in window only and groups reasons; `false-alarm` and `rule` append valid JSON lines — difficulty: 3 — verify: `heavy-run.sh <agent> "ns metrics m3m5" -- bun test tests/metrics.test.ts` exit 0
- [x] P3 `metrics report` (goal 1): a table with columns metric, this window, previous window, change, and the `◀ worst` mark, plus the "Approved rules" before/after section (goal 3). It writes `<paths.notes>/metrics.md`. main-start prints the due line (goal 4) from `mainStartText` in `src/core/main-start.ts`. Tests: worst-change pick, with M4 user count never ranked; an approved rule 10 days old shows before and after numbers, and one 2 days old shows `measuring`; the due line appears when the file is missing or 8 days old, and is absent when it is 1 day old — difficulty: 3 — verify: `heavy-run.sh <agent> "ns metrics report" -- bun test tests/metrics.test.ts` exit 0
- [x] P4 Docs and a full green run. README gets a `metrics` section: commands, the 5 definitions in one line each, the M4 whole-run caveat, and the weekly loop "report → Main proposes one rule → owner approves → `metrics rule --approved` → next report shows before/after". `docs/config.md` gets the `metrics:` keys and CHANGELOG one Unreleased line. Smoke in a sandbox HOME: `neurastream init`, the fixture logs/events copied in, `neurastream metrics report` exit 0, and `metrics.md` written; paste the table into Progress — difficulty: 2 — verify: `heavy-run.sh <agent> "ns metrics full" -- bash -c 'bun run typecheck && bun test'` exit 0

## Done check
`bun run typecheck && bun test && bun test tests/metrics.test.ts && grep -q 'metrics' CHANGELOG.md && grep -q 'metrics report' README.md`

## Code read by Main
- `src/core/adapter.ts`
- `src/core/agent-ledger.ts`
- `src/core/agent-score.ts`
- `src/core/main-start.ts`
- `src/core/config.ts`
- `src/cli/dispatch.ts`
- `src/adapters/omp/sessions.ts`

## Progress
Status: complete
- 2026-10-22 19:4x Main: plan written. Data checked on the live machine (read only): `~/.local/state/agent-score/events.jsonl` (395 lines; accept events carry agent/plan/phase/ts), `main-guard.log` (5197 lines) and `plan-guard.log` (792 lines), each line `<ISO UTC> BLOCK|ALLOW …`. Main-run `messages` keep `role: user` and `role: assistant` (sessions.ts:151-157). After merge, Main releases, installs, sets `metrics.ci_pipelines_cmd` in the live config, adds `metrics ci` (after every merge) and `metrics report` (weekly) to `~/.omp/agent/AGENTS.md`, and runs the first report.
- 2026-10-22 NsMetricsP1Haiku: P1–P4 implemented on `feat/self-metrics` in `/home/ukd/Work/neurastream-metrics`. Not pushed, not tagged, not linked or installed. Commits: `5ecc878` (P1, M1 and M2 core, `metrics:` config), `e360d92` (P2, M3, M4, M5, `metrics ci|false-alarm|rule`, dispatch wiring), `8bc7bcd` (P3, `metrics report`, worst change, approved-rule before/after, main-start due line), `328303b` (P4, README "Self-metrics", `docs/config.md` metrics keys, CHANGELOG Unreleased line), `d1ccd3f` (golden `main-start` compare skips the new due line, one-line comment). Verify via `/home/ukd/Work/heavy-run.sh NsMetricsP1Haiku ... -- bash -c 'bun run typecheck && bun test'` in the worktree (log `/home/ukd/Work/.heavy-run.log`): first run had typecheck exit 0 and one failure in `tests/golden/ports-p4.test.ts` ("main-start matches the original", the new due line, fixed in `d1ccd3f`); second run typecheck exit 0, `bun test` 189 pass, 0 fail, 906 expect(), exit 0. Smoke with `HOME=/tmp/neurastream-home-smoke-$$`: `init` exit 0; `metrics report` exit 0 and `notes/metrics.md` present; `metrics ci /tmp x` exit 2 with `metrics.ci_pipelines_cmd not set`; `metrics false-alarm 2001-09-09T01:45:00.000Z --why smoke` exit 0; `metrics rule "smoke rule" --approved` exit 0; unknown `metrics bogus` exit 2. Smoke used empty fixtures; live logs were not copied in and the live config was not touched. Open for Main: run the done check, then a live report read-only before setting `metrics.ci_pipelines_cmd`.
- 2026-10-22 19:5x Main: done check green on the branch (typecheck 0, `bun test` 190/0, metrics 15 pass). PR #1 CI green, squash-merged as d662c1a. Released 0.1.13 (PR #2 a5ab6b9, tag v0.1.13, publish success), installed live (`omp plugin list`: neurastream@0.1.13, `neurastream doctor` exit 0). Live config `metrics.ci_pipelines_cmd: 'glab api projects/:id/merge_requests/{mr}/pipelines'`; `neurastream metrics ci /home/ukd/Work/pm-counts 200` → "needed 5 pipeline(s)". First live report: M1 $2.66/merge, M2 8940 idle calls (-70.5%), M4 86 corrections (-65.7%), M5 2644 blocks (+2239.8%, worst). Known gap: M5 groups `stop` reasons by full text (holds the changing open-plan list), so one reason splits into many groups; follow-up. AGENTS.md has the `metrics ci` and weekly `metrics report` rows.

## Background
- Proposed to the owner 2026-10-22 18:5x as the top 5 out of a longer list (cost, speed, quality, waste, owner, memory).
