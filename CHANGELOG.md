# Changelog
## Unreleased
### Added
- Guard false-positive detector D8 `block-then-bypass` (plan 20261027_1430 P5): a guard refusal (`main-guard:` / `plan-guard:`) followed within `incidents.bypass_window_sec` (default 600) by an allowed call of the same tool whose args share at least `incidents.bypass_similarity` (default 0.6, token Jaccard) opens a `possible guard false positive: <reason>` incident with both call excerpts as evidence. Main's session events feed it through the gated detector path, so the session is parsed at most once per `incidents.scan_interval_sec`. `neurastream watch` does not run D8 yet (its gather passes no main-session events).
- Every scheduled job beats: `withHeartbeat` wraps wip-snapshot, wip-backup and `metrics report`, the pages server and the owner page server write `pages-serve` / `ui` heartbeats — `{name, at, ok, detail}` JSON under `<queue_state>/heartbeats/<name>.json`, detail cut to 200 chars; a crash beats ok:false with the first error line, then re-throws so exit codes are unchanged. Hidden `neurastream heartbeat <name> [--fail "<text>"]` beats once by hand (live check, your own cron jobs).
- `neurastream watch` (hidden): one watcher pass — failed and stale heartbeats, failed user units filtered by `watch.units` globs, and the gated incident detectors fold into `source: watch` incidents under `watch.expect` staleness budgets (wip-snapshot 2h, wip-backup 26h, metrics-report 8 days); a watch incident whose problem recovers is closed again via `incident dismiss`. Each NEW incident posts one ⚠ message ("⚠ <job>: <state> at <time> — <first error line> (incident <id>)") through the configured notify providers — at most `watch.max_posts_per_run` (default 3) per run, then one "+N more, see `neurastream incident list --open`" line; nothing when no provider is configured, every post scrubbed by the secret redactor.
- CI in the loop (plan 20261027_1430 P6b): `neurastream watch` checks every repo of an active plan through the forge CLI (glab or gh). A red default branch opens `ci-red-main` and notifies once; an open MR whose newest finished pipelines have failed for more than `watch.ci_red_hours` (default 2) opens `ci-red-mr`, unless a running agent names its plan. Every MR merged since the last run gets its M3 `ci` record (the ledger is the cursor; the first run backfills the newest 20 merged MRs), so `metrics ci` is no longer forgotten. A commit that goes red then green writes a `ci-flaky` metric, shown as `Flaky jobs` in the weekly report. Recording logic moved from the CLI to core (`recordCiMr`); CI checks need `metrics.ci_pipelines_cmd` for M3 and an origin default branch for `ci-red-main`.
- `neurastream watch on|off` installs or removes the watcher timer: a systemd user timer `neurastream-watch.{service,timer}` on Linux or a LaunchAgent plist on macOS, running every `watch.interval_min` (default 15). The service manager is probed first; a failed probe writes nothing. `neurastream doctor` prints `watch: on|off, last run N min ago`; the preflight prints `watch: last run N min ago`, or `watch: NOT RUNNING since <time>` with a `watch:not-running` incident once the last run is older than 3 intervals. Interactive `neurastream init` offers to turn the watcher on.

## 0.2.62
### Changed
- Review spawns skip the priority gate (plan 20261028_1600 P8): `priorityGate` drops the plans a Main-authored brief reviews (`Plan review: <plan>` line, agent in `review.agents`, main-launched) before the rank check, so reviews of plans #3+ start while higher plans are idle; implementer spawns and sub-launched calls keep the gate (I-20261031-353).
- The review spawn's shell is an allow list (plan 20261028_1600 P7): `eval` is denied outright, and bash runs only single-line commands whose every `|`/`&&`/`||`/`;`/`&` segment starts with an entry of the new `review.shell_allow` config key (default `git show/log/diff/blame/rev-parse/ls-files/status/merge-base`, `grep`, `cat`, `head`, `tail`, `wc`, `ls`, `jq`, `glab mr list/view/diff`, `gh pr list/view/diff`, `date`), with no redirects, no substitution and no writing/executing options — the old MUTATING ban list missed `fs.renameSync`-style writes (I-20261031-348, I-20261031-350). MUTATING gains the `*Sync` file-write names for its other callers, and plan-approval drops a tautological `since !== ""` check.
- Plan review switches (plan 20261028_1600 P6): `review.plan` (default `true`; `false` skips the reviewer PASS gate — an empty `review.agents` list no longer does) and `review.code` (default `false`; `true` refuses Main ticking a plan phase until a review spawn's `CODE REVIEW: PASS` entry covers that phase).

## 0.2.61
### Fixed
- 0.2.60 froze chat input: a branch with no new commits counted as landed, so the stop stayed locked forever. A plan now counts as landed only when every phase is ticked, and the landed lock lets Main stop after `guards.idle_stops` empty stop attempts (plan 20261031_2320).
## 0.2.60
### Changed
- Plan index is append-only and read-only on disk (0444): one writer `writeIndex`; agents add or reorder plans with `neurastream queue add` / `queue move`; doctor re-locks the file.
- Tests never touch the real queue: a bun test preload sandboxes every `QUEUE_*` path.
- Landed open plans auto-close themselves (`queue-close --auto`); a landed plan whose close failed locks spawns and stop until a brief names it.
- queue-close marks incidents fixed only when cited outside `## Progress`.

## 0.2.59
### Changed
- Plan pages are forced onto the architecture-drilldown template: `pages publish --plan` refuses anything but the template with its DATA block edited, and refuses to publish an incomplete diagram; the page's approve tap now lands in the owner inbox as one approval row, and doctor fails when neurastream-pages.service predates the installed package (plan 20261031_0917).
## 0.2.58
### Changed
- Guard diet (plan 20261031_1207): agent `Findings:` lines stay notes instead of becoming spawn-blocking incidents; only realtime incidents gate spawns and stop.
- Owner-cancel detection reads only owner prose (shared `isOwnerProse`); INCIDENT lines never flag a cancel.
- One numbered spawn verdict lists every problem at once; brief-lint and the ledger cap are advice only.
- Review spawns may run read-only shell; secret paths judged under both config home and OS home; stop is released at `main_max_calls`; `approval.since: ""` turns approval fully off.
- Injected queue summary and stop refusal show the top 10 plans plus "… N more".
- Read tools and non-writing shell skip blocker scripts; a denial names the hit paths and the script's output.
## 0.2.57
### Changed
- Plan approval records a hash of the plan text in `<queue_state>/plan-approvals.json` instead of writing an `Approved:` line into the plan; the plan file is never edited, and `Approval: self` is gone (P1, plan 20261029_1455). main-guard refuses a spawn until the record matches the plan's current text.
- The owner can approve a plan from chat with `approve <YYYYMMDD_HHMM>` (P2, plan 20261029_1455): it matches the one open indexed plan whose file stamp is that prefix, records the approval like the page's Approve button, and is logged to `plan_guard_log`. No match, several matches, or an approval that cannot be saved is answered with a notice and nothing is approved. A failed approval write from the page now answers 500 instead of "approved".
- Plan approval is a hard gate for new plans (P3, plan 20261029_1455): a plan whose file stamp is at or after `approval.since` (new config key, default `""` = off) needs a page in Base before any spawn, and its approval record like any gated plan. A spawn on such a plan with no page is refused with the `neurastream pages publish` command.
## 0.2.56
### Added
- Owner page: the Base tab lists published pages under their repo (one card per repo, newest first, expired pages gone); `pages publish` records each page's repo.
- Owner page: the Add note button works on a phone long-press.
- `ui.allow_this_machine` admits this machine as the owner on the owner page.

### Changed
- CI fails on any oxlint warning (`bun run lint`).
- Write-check: a linter with `only_with_config` is skipped when no repo lint config file is found walking up to the git top; the shipped ruff argv drops `--select`/`--ignore` and oxlint drops `-D` group flags so a repo's own config governs (P10, I-20261031-93).
- Write-check: an edit whose before text holds git conflict markers (`<<<<<<<` / `>>>>>>>`) is allowed with a note instead of being linted (P11, I-20261029-450).
- Write-check config validates `only_with_config` as a list of non-empty file names.
- A higher plan with an open MR on its branch no longer blocks spawns on lower plans.
### Fixed
- A plan copied into separate clones (no shared `.git`) now appears once in `FINISHED.md`: `finishedKey` keys on the heading title plus the plan file basename, so per-clone repo names no longer multiply an entry (`bun run typecheck`, `bun test tests/queue-finished.test.ts`).
- Plans under `docs/plans/<subdir>/` count as live plans (Main plan-file match, brief-lint, plan roots).
- The test suite leaves no temp files behind: every temp dir is removed in teardown, and a new omp adapter clears the previous one's armed grace timer.
## 0.2.55
### Changed
- `guards.plan_offer` (templates/config.yml, docs/config.md) now also refuses a Main stop reply that promises instead of offering — "I will", "I'll" — with the refusal "don't promise it — do it now, or write the plan and index it"; checkStop's reason and log moved to the exported `STOP_PLAN_OFFER_REFUSAL` const (I-20261030-25, I-20261030-32).
- The omp adapter resets Main's per-turn call cap on a real deferred hand-back (a `willContinue` agent_end with a pending async job), so the count no longer stays spent until the owner's next message (I-20261030-24).
- A deferred hand-back whose reply promises instead of planning steers Main with the plan offer refusal via `pi.sendUserMessage` (I-20261030-32).
## 0.2.54
### Fixed
- Tapping the owner page's Results tab still froze the whole page: the server built months of numbers itself (over a minute, GBs), again on every refresh. A separate low-priority process (`src/cli/results-build.ts`) now builds them at most hourly into `results-cache.json` in the state dir; the tab only reads that file and shows "Working out the numbers…" until the first build lands.
- Main's per-turn call cap (`guards.main_max_calls`) never reset while the owner was away: a blocked stop is a continuation, not a hand-back. The count now also starts over 15 min after its first call, and the refusal says when.
## 0.2.53
### Fixed
- The owner page froze for every tab: each 20 s refresh built the Results tab's months-long run window (62 s and 10 GB on a 13 GB sessions dir). `buildPageData` now takes the tab and builds Results only on the Results tab; the other tabs read at most the last day (0.7 s).
## 0.2.51
### Added
- Feature results (plan 20261025_2148): `neurastream metrics features [--days N] [--json]` prices finished features — a feature is a plan plus every later plan whose Goal names its file stem, finished when every plan in the chain closes or archives; each hour of Main cost splits evenly over the plan files that hour's messages name (none → overhead), a sub run's cost goes to the plan its first message names. `neurastream metrics releases [--days N] [--json]` prints the same ledger metrics for the N days before vs after each release (a `v*` tag of this repo or another repo's `metrics ci` merge) plus the configured product numbers (`metrics.product_cmds`); `RunMessage` carries the session line's `ts`, and the owner page's Results tab draws the releases as an inline-SVG chart (y = metric, x = time or feature/release order; product numbers stay neutral).
### Fixed
- The owner page's pill tabs keep their gaps and padding at 390 px: the row scrolls horizontally instead of squeezing six labels together.
## 0.2.50
### Added
- `neurastream doctor` and `queue-check` check `review.agents` against `## Allowed` of the subagents file (plan 20261028_1600, P4d): when Allowed names agents but no review agent, that is a problem (every review spawn would be refused); an empty Allowed (a fresh install) is not; an entry that is not allowed is a warning.
- Review spawn lock (plan 20261028_1600, P4f): a named review spawn (`Plan review: <plan>` brief, `review.agents` agent) may only read, use todo and edit its own plan; shell, spawn, cancel and MCP tools are denied, and so are reads of credential dirs (`~/.config`, `~/.ssh`, `~/.gnupg`, `~/.aws`) and env files. A review spawn needs a task name; a PLAN REVIEW line counts only from the named review spawn of that plan. The plan-review brief template no longer asks reviewers to list MRs.
- Config reload (P4e): the omp adapter re-reads config.yml when its mtime changes, so a rule key such as `review.agents` takes effect without a restart; a broken edit keeps the last good config and logs one line. A `paths.*` change still needs a restart.
### Fixed
- Plan review verdicts (P4g/P4h): a reviewer's verdict is read only from the form `- [<date> <time> <name>: ]PLAN REVIEW: PASS|FAIL …`; any other `PLAN REVIEW` line in a subagent's Progress edit is restored with a reason, and a verdict word inside a line no longer sets the verdict. Ticking a phase box no longer expires a PASS, and the queue summary shows `N/M done` per plan. One-time: a PASS recorded before this change on a plan whose phase boxes were already ticked expires once and needs one fresh review.
- A verdict is never lost or forged (P4k): it is judged against the plan text the review spawn saw at its start (a plan changed during the review records FAIL "plan changed during review"), a second verdict by the same spawn records FAIL, Main can never write a PLAN REVIEW line, and a review spawn that ends with no verdict is recorded from its plan file at agent_end or reported to Main as "<name> wrote no verdict".
- A subagent's own spawn passes the same gates as Main's (P4i): its `task` call and a shell `bypass_spawn` launch (e.g. `opencode run`) meet the plan, PASS, Allowed and incident gates, Main's shell launches now also need a PASS, and only Main's spawns may use the review exemption.
- Plan edits by relative path are refused (P4j): an edit, write or ast_edit whose target names a plan must use an absolute path, so a plan-guard check can never miss the file.
## 0.2.49
### Added
- Main's per-turn call cap (plan 20261028_1545_main_call_budget, P1–P2): every Main tool call counts toward `guards.main_max_calls` (15; 0 = off) since the owner's last message or Main's last hand-back, with the wrap-up warning at `guards.main_warn_calls` (12); at the cap only `guards.main_call_exempt_tools` (`task`, `todo`, `ask`, `wait`) still pass, so Main ends its turn or spawns an implementer instead of grinding. The count lives in the existing edit-window state file (one new field, no second state format); tier `full` ignores the cap. The omp adapter resets the count at Main's terminal hand-back (`agent_end` without `willContinue`); a real owner prompt already did through `checkInject`.
## 0.2.48
### Added
- Plan review gate (plan 20261028_1600): a plan's `## Reuse` section (one checked line per new thing) is a queue problem when missing; a spawn on a plan needs a current reviewer PASS — recorded by plan-guard only from a read-only reviewer subagent's `PLAN REVIEW:` Progress edit (`review.agents`, `templates/plan-review-brief.md`), expired when the plan text changes — and is refused while the plan holds done-but-not-merged work (open MRs of its repo, branches with commits off main) that the brief does not name with an `MR !N:` / `Branch <name>:` line. brief-lint gained the matching brief rules: an MR named in prose without the line, a plan named only under a worktree path instead of its main checkout, and `src/tests` paths the plan's blocker `ALLOWED` regex rejects. Plans stamped before `review.since` are exempt until audited.
- Deferred write-check rules (`write_check.defer_rules`, INCIDENT I-20261028-166): a new finding of a deferred rule (template: oxlint `no-unused-vars`, ruff `F401`, `F841`) no longer refuses the edit — it is allowed with a logged note, and the omp adapter injects one steer at the turn's end naming the deferred findings still present, so a declare-then-use refactor works with plain edits.
### Fixed
- A write-check refusal names the findings the edit added, each with its own sample line (INCIDENT I-20261028-150, I-20261028-151): findings are compared as a `(rule, message)` multiset instead of per rule, so a rule's old lint debt is no longer listed as the refusal's reason (the single sample was the old warning) and new findings of a busy rule no longer hide behind one merged count. The template linter patterns capture a `message` group; a pattern without one keeps the older per-rule counting.
- A refused write-check edit no longer undoes an earlier allowed edit to the same file from the same parallel batch (INCIDENT I-20261028-135): once an edit is allowed, every other pending call's "before" on that file becomes the allowed result, so a refusal restores the file to it and not to the pre-batch text.
- `queue-finished --backfill` writes the repo dir, never the month folder, into FINISHED.md headers even when the archived plan's checkout has no `.git` up-tree, and also reads a linked worktree's archive for plan files the main checkout lacks, so those entries exist too.
- `queue-finished --backfill` lists each archived plan once per repo, not once per worktree copy (INCIDENT I-20261028-126, I-20261028-127); `queue-finished --dedupe` removes existing duplicates from FINISHED.md.
- `neurastream doctor` names the fix for a missing file: `missing: <path> — run: neurastream adapter install omp` (INCIDENT I-20261028-129).
## 0.2.47
### Fixed
- The bare `queue-finished` command is installed again (INCIDENT I-20261028-119): it was the only queue script without a `bin/` wrapper and package.json `bin` row, so the rules table's `queue-finished` failed with "command not found" while `neurastream queue-finished` worked.
## 0.2.46
### Fixed
- A plan's deny-path no longer judges paths beyond the ones that made its blockers run when the caller is staffed on a different plan (INCIDENT I-20261028-111): `runBlockers` marks such a call `foreign` (staffing.json, keyed by the task name in `agentId`) and `denyPath` keeps only targets in `paths`, so a subagent of another plan may run a command that merely names paths outside this plan. An agent staffed on the plan itself, Main and unstaffed agents are unchanged.
- Write-check false refusals from the shipped template (INCIDENT I-20261028-112, I-20261028-113): the suppress regex now requires a comment marker (`#`, `//` or `/*`) before the word, so a fixture or string that merely contains `noqa` is no longer refused; the template ruff run adds `--ignore E501,S101` because ruff's `--select` overrides a repo's own ignore list and long lines and test asserts are style, not new defects.
## 0.2.45
### Added
- Write-time checks (plan 20261028_1228, P1–P3): with `write_check.enabled` on, an edit that adds a lint finding or a suppression comment to a linted file is undone and the call returns an error naming each new rule; `applies_to: sub` (default) checks subagents only, `all` checks Main too. Only findings the edit adds count, so old lint debt never blocks a file; a missing, crashed or timed-out linter allows the edit and logs a note. The template ships ruff (Python, incl. security rules `S`) and oxlint (TS/JS) entries, off by default.
## 0.2.44
### Added
- The owner's own Main-only lines: `MAIN.md` in `paths.agent_dir` (`~/.omp/agent/MAIN.md` with the omp layout) is appended, trimmed, after the managed rules block in Main's prompt; a missing or blank file leaves the block unchanged (plan 20261027_1215_main_only P6).
## 0.2.43
### Added
- Finding incidents get a reason and two owner buttons on the Agents page (plan 20261028_1135, P1–P3): `neurastream incident propose <id> --why "<file:line and reason>"` records Main's reason and keeps the incident open (the why must cite `file:line`); the page shows that reason with **False alarm** (closes it, the reason becomes the dismissal, recorded with the owner's login) and **It's a bug — plan it** (keeps it open, one message to Main's inbox). `POST /incident` sits behind the same origin and tailnet-owner checks as the other POST routes.
## 0.2.42
### Changed
- Plain `omp` no longer runs neurastream: no hook, no command, no guard. Start Main with `neurastream main`, which sets `NEURASTREAM_MAIN_LAUNCHER=1` for its omp; child harnesses inherit it.
- Main's rules ride its system prompt each turn instead of the owner's `~/.omp/agent/AGENTS.md`. Install strips an old block there (bytes outside the markers stay); doctor reports a leftover as `stale:`.
### Fixed
- The relaunch note no longer says "no own jobs run": the bare "no" read as an owner correction; `noteRequest` lost its dead `auto` parameter (plan 20261027_1215 P4b).
## 0.2.41
### Added
- Main's own plan Findings become incidents (plan 20261028_0900 P1, INCIDENT I-20261028-64): the Findings items of a Main plan edit open incidents (kind `main-finding`) exactly like a subagent's (`agent-finding`), so a bug Main writes down blocks the stop; the plan the entry is written in does not count as planning it — planning is `neurastream incident plan`.
- A stop reply that offers to plan refuses the stop (plan 20261028_0900 P2, INCIDENT I-20261028-65): `guards.plan_offer` (new config regex, default `want me to (write|make) a plan|should i plan|shall i plan|if you want, i(''ll)? plan|plan it or`, case-insensitive) is matched against the reply Main stops with and a hit answers "don't offer it — write the plan and index it"; the two-idle-stops release does not lift the block.
### Fixed
- A finding incident is dismissed only with the owner's words (plan 20261028_0900 P3): `incident dismiss` on an `agent-finding`/`main-finding` needs `--owner "<quote>"` — a substring of an owner message the inject hook saw in the last 24 h (`<queue_state>/owner-messages.jsonl`, last 50) — so the agent that found the bug cannot also wave it away; other kinds keep `--why` alone.
## 0.2.40
### Fixed
- `queue-cancel --not-a-cancel` is refused (exit 1, "nothing is flagged") unless main-guard flagged the owner's message for cancel words, so Main can no longer run it on every turn out of habit (owner, 2026-10-28: "I want you to be forced to stop it").
## 0.2.39
### Fixed
- The subagent no-push guard's eval path resolves git's subcommand like the bash path does (INCIDENT I-20261027-266): `git stash push` and `git log --grep push` are allowed; `git push`, `git -C x push`, `git -c k=v push` stay blocked.
### Added
- Project rules reach every agent (plan 20261027_1530). A subagent's first turn now carries `Repo rules (<path>):` plus the `AGENTS.md` of the repo its plan is worked in, then the owner's burden rule read from `templates/AGENTS.md` (no copy of that text in code — the template stays its one home; its managed block carries the owner's rule that code is a burden and must justify its keep); Main gets a repo's `AGENTS.md` the first time the session works in that repo (a task spawn on its plan, a read, a write, a shell `cd`) and again only when the file changes. The finder and the per-session hash cache are `src/core/repo-rules.ts`, the cache file is `<paths.queue_state>/repo-rules.json`; the hook wiring is the omp adapter's (`docs/adapter.md`). A plan's `Worktree:` `AGENTS.md` wins when it differs from its repo's, a repo without the file injects nothing, and text past the new config key `rules.max_bytes` (default 24000) is cut with one line naming the file to read. README "Project rules" says what is injected and when.
## 0.2.38
### Fixed
- `wip-snapshot` names its `refs/wip/<key>/` refs from the resolved home path, so a home behind a symlink (macOS `/tmp` → `/private/tmp`) no longer leaks `_private` into the key; this was the red macOS CI on main since 0.2.37.
- `blockers/knowledge-scope.sh` counts only `readdirSync` calls, so the named import of it is no longer a false "directory scan outside the configured roots".
### Added
- Knowledge tab on the owner page (plan 20261026_0930_knowledge_base): `/?tab=knowledge` lists every git repo directly under `knowledge.roots` that has a `docs/knowledge/*.html`, `/?tab=knowledge&repo=<repo>` lists its topics, and `GET /knowledge/<repo>/<topic>` serves the page through the pages server behind the same login — breadcrumb `knowledge-base / <repo> / <topic>`, read-only, nothing registered. Repo naming, `<title>` parsing and the `knowledge.json` cache (`knowledge.max_age_s`) live in `src/core/knowledge.ts`; the config key and the shipped template gained the block (`docs/config.md`, README).
- Shipped skills are updated by question, never by overwrite (P7): `neurastream adapter install omp` records a sha256 per shipped file in `~/.agents/skills/.neurastream-install.json`, and on update prints the CHANGELOG lines that name the skill (today `architecture-drilldown`) plus a short diff, then asks `update this skill? [y/N]`. A no, a file the owner edited (said before the question) or a run without a terminal leaves the skill byte-identical, and a release that still changes it asks again — no second local skill file.
- A plan's diagram is checked against the plan (plan 20261026_0930 P10, INCIDENT I-20261027-73): `neurastream diagram check <html> <plan.md>` reads the page's diagram data and exits 1 listing every phase, and every file or command path in its phase lines, that no box names — plus every box that drills down into fewer than two kids. `pages publish --plan` runs the same check, stores what it found in the page's meta, keeps Approve disabled and has the server answer 409 while it fails.
- Plan approval from the plan's own page (plan 20261026_0930 P9, owner 2026-10-27: "approve and go are interchangeable"): `pages publish <html> <name> --plan <plan.md>` records the plan beside the page and the page carries an Approve bar; a click records `Approved: <YYYY-MM-DD> (<page>)` in the plan. Approve stays disabled, and the server answers 409, while any note on that page has no answer; a page published without `--plan` (a built thing) has notes only. main-guard refuses a spawn on a plan that has such a page and no `Approved:` line, unless the plan says `Approval: self — owner: "<his words>"`; a plan with no page predates the convention and is not gated.
- Notes get answers (plan 20261026_0930 P8, owner 2026-10-27): every note submitted from a published page keeps a stable id (n1, n2, … per page, never reused), `neurastream notes check <page>` exits 1 listing each id with no answer in `<queue_state>/page-notes/<page>.answers.json`, and `pages publish` refuses that page while any id is open. The publish that goes through shows each answer beside the note it answers, archives the closed notes and drops the answer file. The tab that lists repo topics is now labelled **Base**; its URL stays `/?tab=knowledge`.
## 0.2.37
### Fixed
- A `False positive: <ban-id> — why` line clears its ban again: the name was captured as `ban` only, so a matching plan stayed refused by queue-check.
### Added
- Finished-plans list (plan 20261027_1714): `queue-close` writes a short entry (date, repo, title, summary, last result, archived plan path) at the top of FINISHED.md beside the index; `queue-finished --backfill` adds every archived complete plan once, and `queue-finished <words>` searches the list.
- Provider state from live data (plan 20261025_1700 P1, I-20261025-164): out-until times are recorded, never remembered. `quota-reset --provider <name>` stores the reset time it parses from the 429 text (zone from `quota.reset_tz`), the omp adapter records a task result quoting a `reset at …` line for the pinned provider, and a rate limit without a parseable time records now plus its wait — all as `{provider, until, at, source}` lines in `<paths.queue_state>/provider-out.jsonl`, newest record per provider wins.
- The providers line (P2): `agent-ledger --cap` and `main-start` print the live state, e.g. `providers: zai free · openrouter out until 18:40`, and the notes request tells Main never to state provider state from memory — read the line.
- The owner's pick order is enforced (P3): config `ledger.prefer` names agents in order (first = preferred, empty = off). The spawn gates refuse a lower pick while a higher one's provider is free unless the brief carries `Pick note: <why>`, and refuse a brief that claims a provider the recorded state shows free is rate-limited; `agent-score gate` ranks inside the order and never recommends a later paid agent while an earlier one is free (`gate: glm is first in prefer and free → use it`). With `ledger.prefer` empty nothing changes.
## 0.2.36
### Fixed
- The phone page's JavaScript works again. Since the drag-autoscroll change the whole inline page script was one stray brace away from a SyntaxError, so nothing the script wires up ran: tapping "change answer" on an answered card did nothing, drag reorder and the ↑/↓ buttons were dead, tab pills and every POST fell back to full page loads, and the auto refresh never started.
- `neurastream pages publish` parses `--force`/`--keep` and the optional name in any position: `publish [--force] [--keep] <file> [<name>]`. `publish --force <file>` used to read `--force` as the file name and died with ENOENT copyfile '--force'.
## 0.2.35
### Fixed
- `wip-snapshot` and `wip-backup` work again when a linked git worktree sits directly in a work root. Such a worktree reports an absolute git common dir, and gluing it onto the worktree path gave a folder that does not exist (`/Work/x-wt/home/…/.git`), so the whole run died with ENOENT. Live, every hourly snapshot and every nightly backup failed from 2026-10-21.
## 0.2.34
### Fixed
- The phone page sends a text-only message again. A form sent without a chosen file still carries one empty, nameless file part; it was refused as "attachments must be PNG, JPEG, GIF or WEBP". Empty nameless parts are now skipped.
## 0.2.33
### Added
- Owner page queue cards show a two-line summary from the plan header `Summary:` (one or two plain sentences under Branch; if that line is missing, the first Goal bullet) and a status chip: waits you, waits on a plan, not started, phase K of N, or all N done. `queue-check` does not require the header, so old plans still pass (I-20261025-200).
- Needs-me cards say why they need the owner. The hold line is `WAITING on owner: <what to do> — blocked: <what stays stuck until then> — why you: <why Main cannot do it>`, and the card shows Do, Stuck until then (including plans the answer unblocks), and Why you. Yes/No appear only when the ask is a question; a task ask gets Done.
### Fixed
- A sub-run that died before its first reply no longer shows "?" as its model. When the transcript has no provider and model, the model is the spawning agent's `model:` frontmatter; still unknown is `unknown`, never "?". A sub-run with no assistant message whose transcript is older than `ledger.idle_show_min` is `DIED: never replied` (I-20261025-200).
- `agent-score accept`, `diagnose`, `validate` and `penalty` refuse a name that matches no run in the score window (`refused: no run named "<name>" — use the task name, not the worker type`) and store that run's model on the event, so the board no longer depends on the transcript still being in the window (I-20261025-200).

## 0.2.32
### Added
- Host-neutral core: `src/core` and `src/cli` name no harness. The CLI reaches the harness only through the new registry `src/adapters/index.ts` (`HarnessAdapter`, `getAdapter(cfg)` on the new config key `harness`, default `omp`; an unknown name throws `unknown harness "<x>"; known: omp`). The harness-neutral shapes the registry shares (`TraceRun`, `DumpRef`, `RelatedTrace`, `TaskResult`, `LaunchOptions`) live in `src/core/adapter.ts`; `tests/host-neutral.test.ts` holds the line (no harness names in `src/core`, one adapter door in `src/cli`). `docs/adapter.md` gained "Adding a feature" and "Adding a harness".
## 0.2.31
### Added
- MR sweep (I-20261026-12): `main-start` prints a reconciliation of open forge MRs (glab/gh) against open plans of every repo in the index; `queue-check` exits 1 when a reachable forge lists an open MR no open plan mentions (`!N`/`#N` token or source branch, and `MR !N: ignored <reason>` in a plan marks it tracked). A missing CLI, auth failure, unknown host or absent origin skips that repo and never fails the sweep — no hard dependency on any forge CLI.
## 0.2.30
### Changed
- Plan read check (I-20261025-208): a logged read counts in any checkout — a plan may cite a file Main read at the same repo-relative path in the other root (plan worktree ↔ main checkout); a cited file Main did read but that is missing from `## Code read by Main` is added to the list when the edit is allowed (`plan-guard: added <n> file(s) …`) instead of refused; reading a plan warns `plan-guard: before you edit this plan, re-read: …` when a listed entry would fail, so Main re-reads before drafting instead of losing a written edit at save time. The refusal for a file Main never read is unchanged.
- Queue dependency order (I-20261025-208): `queue-check` fails while an open plan sits above the open plan its `Waits on:` line names, the queue summary flags such a plan with `waits on #N`, and the phone page refuses a drag that would create that order (`blocked: #N <plan> waits on #M …`) with the index file and the reorder inbox untouched.
- Owner page: a drag held near the screen edge autoscrolls the page (pure `edgeScrollStep`: 72 px bands, growing toward the edge, capped at 24 px/frame), so the end of a queue taller than the screen is reachable while dragging.

## 0.2.29
### Changed
- Autonomy tiers: the strict tier's chat approve word is config `autonomy.go_phrase` (default `go push`), matched as the whole trimmed message, case-insensitive with inner spaces collapsed; a bare `go` no longer approves anything and falls through as a normal message (I-20261025-201). The strict refusal, the injected tier line and the owner notice name the phrase from config.

## 0.2.28
### Added
- Secrets never reach the chat (I-20261025-197): a content-based redactor (`src/core/secret-redact.ts`) runs on every tool result for Main and every subagent, on every notify post and in the new `neurastream redact` command; a token, key, password or any exact value from `~/.npmrc`, `.env…` files, `secrets.known_value_files` or credential-named env vars shows as `[REDACTED:<type>]`, whatever the file is named. Config `secrets.redact|known_value_files|extra_patterns|proxy`; `secrets.proxy: secretgate` adds secretgate as a second net on outbound traffic; `neurastream doctor` reports the redactor and proxy state.

## 0.2.27
### Added
- Owner page: the Now tab has a one-way "Tell Main" box for a text note and up to four images; Main receives the message with its images, and the "Sent today" list and image files expire after 12 hours.

### Changed
- Owner page: drag drops and the ↑ top/↑/↓ buttons send the reorder over fetch — the card stays where it was dropped, the ranks renumber in place, a 409 re-fetches the list — and the 20 s refresh swaps only the page body instead of a full reload; every POST redirect returns to the tab the owner was on, and the CSP gained `connect-src 'self'` (nothing else).
- Owner page: nothing reloads any more after the first load — answers, unlock/lock, tier buttons and the message Send POST over fetch and swap the page body in place (the server answers `{ok, sent, receipt}` JSON, a no-JS form post still gets its 303), the tab pills and other same-origin links fetch and pushState with the Back button working, and an unreachable server shows a tappable "Couldn't reach the page" line instead of a blank reload.

### Fixed
- Owner page: dragging a queue card to slot 2 now lands it at slot 2 — the drag placeholder always slid to the last card's slot before (I-20261025-187); the reorder receipt says "Moved to #N of open plans" so the page's rank is not confused with INDEX.md's line numbers.
## 0.2.26
### Fixed
- Provider retry-after values remain unchanged across rate-limit resume attempts; only the default wait doubles.

## 0.2.25
### Added
- Autonomy tiers (I-20261025-177): one owner setting, `autonomy.tier` (`strict` / `opinionated` / `full`, default `opinionated`), that the guards follow. The owner moves it with the whole chat message `tier <name>` (when `guards.chat_unlock` is on) or the phone page's tier buttons; it lives in `<queue_state>/autonomy-tier`, a protected path. `strict` caps Main's project-file changes at `autonomy.strict_edit_limit` (default 2) per `guards.main_window_min` minutes and refuses `git push` / `glab mr merge` / `gh pr merge` (through `sh -c`/`sudo` too) until the owner types `go` — one landing, valid `autonomy.go_minutes` minutes (default 10). `opinionated` keeps today's limits. `full` drops the edit cap and accepts `Priority skip: <plan> — Main: "<reason>"` (≥ 4 words) at the priority gate. Main's prompt names the tier (`autonomy: <tier> — …`), and no tier loosens the owner-only moves (guard files, phone page start, notify secrets, unlock, the tier setting itself).

## 0.2.24
### Added
- Published pages expire after `pages.keep_days` (default 15). `neurastream pages publish --keep` keeps a page; `pages list` shows `expires YYYY-MM-DD` or `kept`; expired files are removed on publish, list, and serve, and serve repeats that sweep every hour.

## 0.2.23
### Changed
- The owner page has the approved mockup look: a sticky top bar with pill tabs (Now / Queue / Agents / Spend, server-rendered, unknown falls back to Now) and the lock pill that posts the existing unlock/lock forms; a Today tile card on Now (needs-you count, 24 h list-price spend with sparkline and Main/agents split, agent runs with running/died counts and sparkline, open plans) from the new `nowStats`; the queue as plain-language rows (first 8 on Now with "Show all N ›", the full drag list on Queue); agent scores, incidents, merges/CI and machine health on Agents; per-model spend over 24 h on Spend. A plan whose answer is already in the owner inbox shows "You answered ‘yes' · 14:19 — Main is on it" with a change-answer link instead of the Yes/No buttons.
- Answers reach Main even when the question moved on: a plan whose WAITING was cleared (or that is complete) answers with "Already handled — Main cleared this question before your answer; your answer was still passed on." and lands in the owner inbox marked "(already cleared)"; only a plan unknown to the index is still refused. A second press of the same answer within 10 s is dropped in memory, so a double tap no longer sends Main a duplicate.

## 0.2.22
### Added
- `neurastream pages on|off|serve|publish|list` serves published static files from a systemd user unit on the tailnet, with owner-login authentication, safe direct-file serving, and doctor checks.

## 0.2.21
### Added
- Skill pack: `templates/skills/architecture-drilldown` (`SKILL.md`, `template.html`) is copied to `~/.agents/skills/` by `adapter install omp` when missing, kept when present, removed by `uninstall` only when byte-identical, and checked by `doctor`.

## 0.2.20
### Fixed
- Notify posts are serialized, retry Discord 429s once after the requested delay (capped at 10 seconds), batch fresh needs-you plans into one message, and post replies even when a session stop is blocked.

## 0.2.19
### Added
- Main's context annotates absolute provider reset times with the caller's local time; `quota.reset_pattern` selects timestamps and explicit zones in the message take precedence over `quota.reset_tz`.
- `neurastream traces bloat [<runId>|--since 24h] [--json]` (plan 20261024_0303): per-run model-call prompt sizes (usage input + cacheRead + cacheWrite, one row per call) with `prompt-bloat` findings — the first call over `traces.bloat.first_call_max` (default 150000), or any call over `ratio_of_limit` (default 0.8) × its model's `context_limits` entry (an open map; a model without an entry is not limit-checked). A failed request dump belongs to one run only: its window must cover the dump, its model must match, then the closest event at or before the dump wins; ties and dumps with no eligible run are listed once as unmatched (also in `--json`). Its report shows what filled the prompt — system / messages / tool groups by `traces.bloat.tool_group`, plus the five largest tools — and, when the run itself has no usage finding (its rejected call never wrote usage), the dump's error-response prompt size ("prompt is too long: 1172629 tokens > 1000000 maximum") becomes the flag with the dump as the named source; a dump stating no count flags nothing, and no size is guessed from bytes.
- `neurastream metrics report` ends with a weekly `Prompt bloat over N runs: K flagged, largest first call X tokens (<run>)` line over every run touched in the window (largest first call = the run's usage, else the matched dump's stated prompt), next to the provider-honesty line.
- `agent-ledger` gains a `tok/call` column: the run's prompt tokens ÷ its calls.
- `traces.bloat.aggregate_apis` defaults to `["cursor-agent"]`; aggregate turn-level usage is excluded from per-call bloat findings and the metrics largest-first-call value.
- `neurastream traces briefs [--since <N m|h|d>] [--json] [--report]` lists each spawn brief of Main's runs with its features (length, `file:line`, verify, phase, plan, budget, acceptance lines), its agent's waste and whether it was accepted; `--report` compares briefs with and without each feature. Brief text never prints. `traces.briefs` in the config sets the patterns and length buckets.

### Changed
- The `traces.bloat.tool_group` default is now `^_?mcp__([A-Za-z0-9]+)_`: this harness writes some MCP tool names with a leading underscore (`_mcp__zoho_mcp_…`), which the old `^mcp__…` default lumped into `builtin` instead of naming the group.

### Fixed
- The priority-watch golden test no longer flakes on a minute rollover between runs or the 5 s default timeout under load.

## 0.2.18
### Fixed
- A slash command typed while Main waited out a rate limit no longer cancels the wake-up before a turn starts.

## 0.2.17
### Changed
- A `Priority skip:` line no longer works with any reason: the only accepted form is `Priority skip: <plan> — owner: "<words>"`, and the quoted words (at least four, case- and spacing-normalised) must appear in an owner message recorded in the last 24 h — every Main prompt that is not a guard continuation or a harness notice is now appended to `<queue_state>/owner-messages.jsonl` (newest 50 kept). A higher plan that carries a `Waits on: <plan>` line for a plan still open in the index is not idle, so it does not block a lower spawn and needs no skip line; `Waits on:` lines are Main-only (plan-guard restores subagent edits that add or remove one). The skip log line keeps the owner quote.

### Added
- `neurastream traces efficiency <runId|--since 7d> [--json]` reports per-run tool-call waste and matched-rule counts; agent-score adds the `Calls/acc` and `Waste` board columns, and `score.waste_weight` (default 0) weights the wasted-call fraction in ranking.
## 0.2.16
### Fixed
- Session timestamps were read 1 h early in summer time.

## 0.2.15
### Added
- Provider-honesty rules (plan 20261024_0302): `model-swap` (announced model vs the model/provider assistant messages show, fallback resolutions included), `odd-response-id` (a present responseId vs `traces.provider.id_patterns`; a missing id is not checked), `unoffered-tool` (calls nothing in the allow-list, the request's own tool list or a result other than an unknown-tool refusal backs — a guard-refused call of a real tool is not flagged), `phantom-output` (billed output tokens for a message that wrote nothing; aborted or errored streams are not judged) and `cost-mismatch` (`model_usage` cost beyond ±20% of `traces.provider.prices`, $ per million tokens, either direction). `neurastream metrics report` ends with a weekly `Provider honesty over N runs: …` line. The `traces.provider` maps are open: an empty object in the template accepts your keys, and an assistant message with no content now parses as an empty-text event so phantom output is visible.

## 0.2.14
### Added
- `neurastream traces actions <runId|--since 24h> [--json]`: flag suspicious tool actions in a run's trace — reads of secret paths, network commands to hosts not on the allow list (exfil-shaped ones are high), writes outside the work roots or into deny paths, and `curl … | sh`. Every list lives in the new `traces:` config section. High findings become `suspicious-action` incidents; evidence is masked and capped.
- Owned-product read rule: a subagent run reading files of another owned product (`traces.owned_repos`; installed copies under `node_modules` and global installs included) while its final report says `Findings: none` becomes an `unreported-finding` incident (source `traces`) and records an `agent-score penalty` event for that agent on the plan.
- Live traces wiring: right after an allowed subagent Progress edit, the adapter parses the sub's own session file and folds its high suspicious tool actions as `suspicious-action` incidents, and — when the new Progress bullet claims `Findings: none` — the cross-product reads hidden behind that claim as `unreported-finding` incidents with the agent-score penalty; the verified bullet replaces the final-text check. Detector failures are logged, never thrown, so a broken detector cannot break the edit.
- Cross-run claim backing (`neurastream traces claims`, INCIDENT I-20261025-23): a Main run's claim that cites a subagent result — a test count, a fail count, an exit code — is no longer unbacked when only the subagent's own session shows it. The CLI also checks the toolResult text of the subagent runs under Main's session dir and reports the match as backed `subagent:<name>`; claims no related run shows stay unbacked.

### Fixed
- A subagent's Progress entry that quoted `Findings: none` mid-text (e.g. in its resume steps) and ended with its real `Findings:` items had the quoted text read as its findings: the resume steps after the quote were split on `;` into bogus agent-finding incidents (24 on 2026-10-25). The guard now reads the value after the entry's last `Findings:`.
- `neurastream adapter install omp` broke a config.yml whose `guards:` section had no `protected:` key: it inserted the adapter paths as bare `- "…"` items before `ledger_command`, so the YAML no longer parsed. The overlay now always writes them under their own key — an empty `protected: []` becomes a block list, an existing block list gains them under its header, a missing key is added at the top of `guards:` — and refuses a flow list with items instead of adding a second key.
- A Main turn that ended on a provider rate limit was re-asked straight into the limit: at 02:07Z the stop guard re-prompted three times within 4 s (every retry hit `429 … retry-after-ms=731000` again), then allowed the stop and posted nothing, and nothing resumed Main — 3h20m idle before the owner noticed. The stop guard now recognizes a rate-limited turn end (`guards.rate_limit.patterns` on the error text), allows the stop without touching the idle-stop counters or the normal stop rules, posts `⏳ Main is rate limited by its provider until HH:MM (local); it resumes on its own.` once per episode, and arms exactly one resume timer (a longer retry-after or a second limited turn doubles the wait, clamped to `max_wait_s`, plus `slack_s`) that hands Main a new turn with "continue the queue where you stopped" when the wait is over; the owner's own message cancels it, and a rate-limited deferred hand-back arms the timer instead of logging "no reply text".

## 0.2.13
### Changed
- The owner page is rebuilt for one-handed phone use (design: `docs/owner-ui-design.md`): a sticky status strip with the amber needs-you count and working/CI/disk signals that turn red only when something is wrong; each open `WAITING on owner:` plan is a card with its `#` title, the ask in plain words, the goal folded into a Background block and named actions ("Yes, go ahead", "No", "Reply…") whose answer lands as a one-time receipt ("Sent to Main · 08:12"); running/waiting agents as rows; queue (one flat ranked list, see Added), merges/CI, incidents, agent scores (a real table) and machine health as closed details blocks with count chips; and a sticky bottom bar for the guard unlock that explains itself, with the exact config line, when `guards.chat_unlock` is off. The meta refresh is gone: an inline script reloads every 20 s only while no field has focus or text and keeps `<details>` open state in `sessionStorage`; every GET sends a per-response `Content-Security-Policy` with the inline script's nonce. Unlock/lock refused because `chat_unlock` is off now redirect to the page (receipt + bar explanation) instead of a bare 409. Page data (typed rows per source) is separate from rendering, so `bun scripts/ui-preview.ts <out.html>` renders a fixture preview without a server.

### Added
- `INDEX.md` order is priority: the queue summary is one flat ranked list in index order (`N. <file> [flags] <goal>`, rank 1 = the top line; per-repo cancelled counts move to one footer line), and the spawn guard refuses a spawn on a plan while a higher plan is idle (open, not waiting, not awaiting merge, has an unticked phase) and unstaffed, unless the brief carries `Priority skip: <plan> — <why>` with a non-empty why. Staffing comes from `staffing.json` (each plan's newest spawn's task names) matched against omp's running job labels; without job info (CLI `neurastream guard spawn`) the gate logs `PRIORITY unknown jobs` and lets the spawn through. `Priority skip:` lines no longer make the skipped plan a spawn target. The managed AGENTS.md block states the rule.
- Queue reorder by drag and drop on the owner page: the queue is one flat list in `INDEX.md` order (rank number + repo chip per card); each card has a pointer-events drag handle (touch and mouse, no HTML5 drag API) plus "↑ top"/"↑"/"↓" buttons, and a drop POSTs `/reorder` with the full new order, the order the page was rendered with and the moved plan. The server reuses the /answer auth; it refuses an order that is not exactly the index's plans (400) or a page stale against the current `INDEX.md` (409), rewrites `INDEX.md` atomically (temp file + rename, every comment and blank line stays attached above the plan that follows it), appends one `reorder` record to the owner inbox (Main gets "Owner moved … from #1 to #2 … INDEX.md has the new order") and confirms on the page with "Moved to #2 · Main sees it next turn".
- `neurastream traces claims <runId|--since 24h> [--json]`: check what a run's final report claims (test counts, exit codes, commit SHAs, heavy-run labels, changed paths) against what the same run's tool output actually shows; anything nothing backs becomes a `claim-unbacked` finding. A SHA only counts when the git command whose output printed it is the call the run itself made (results pair with their own tool calls), paths must end in a real file extension (dotted API symbols and session-UUID fragments are not files), and files agents wrote through the shell (redirect, heredoc, `tee`/`touch`/`cp`/`mv`) back changed-path claims like edit/write calls do.

### Fixed
- Queue reorder worked only while the index listed open plans alone: `POST /reorder` compared the posted `order` (exact set → 400) and `before` (→ 409) against every `INDEX.md` line, so a `Status: complete` plan kept in the index while awaiting merge made every drag answer 400 and the page ranks differed from the file ranks. It now checks against the open plans the page renders (the same list as the queue cards), rewrites only the open slots — each open plan moves with its attached comment/blank lines, non-open lines keep their slots, a path listed twice keeps both lines — and the inbox `from`/`to` are 1-based ranks in the open list.

## 0.2.12
### Added
- "Needs you" pings: when a Main turn ends with an open plan whose `WAITING on owner:` line has not been pinged before, neurastream posts `🔔 Needs you — <plan title>: <question>` (plus the `neurastream ui` phone-page link when `ui.enabled: true` and the machine's MagicDNS name is known) to the configured Discord/Slack webhooks; and when the guard refuses a Main tool call because it touches a protected guard file, it posts `🔓 Main needs an unlock to continue (<file>). Tap "unlock N" on the phone page.` at most once per 30 minutes. Deterministic, no model call, Main session only, fire-and-forget; each waiting question posts once until its line changes or disappears (keys remembered in `<queue_state>/notify-waiting.json`), and every decision logs one `notify: needs-you posted|skipped (<why>)` guard-log line.
### Fixed
- Chat notify missed most real hand-backs: omp fires `session_stop` BEFORE `agent_end` and skips it entirely while an async job (subagent, background bash) is pending, and the adapter read the reply from the session file, so it posted the previous turn's reply or nothing. The adapter now takes the reply from the event itself — the stop's `last_assistant_message` (falling back to the last assistant entry of `messages`) and the `agent_end` `messages` — and posts at an allowed `session_stop` and at a `willContinue: true` `agent_end` whose last assistant message ends with a `stop` reason, text and no tool call (the deferred hand-back). Still once per distinct text, never for a subagent, never on a blocked stop; every notify decision now logs one guard-log line `notify: posted|skipped (<why>)`.

## 0.2.11
### Fixed
- Tapping unlock or lock on the owner page did not tell Main; the owner had to say it in chat. The page now writes an `unlock`/`lock` record to the owner inbox, and Main gets it as a user message ("Owner unlocked the guards from the phone page for 5 min (until 01:12)…"). The inbox also understands a `reorder` record for the coming drag-and-drop queue.

## 0.2.10
### Fixed
- The owner page answered 403 to the owner's own phone: the real `tailscale whois --json` reader parsed only the first stdout line (`{`) and looked for the login under `User` instead of `UserProfile`, so every peer's login was empty. It now parses the whole output and reads `UserProfile.LoginName`.

### Added
- `neurastream ui on --login <tailscale login> [--port N]` and `neurastream ui off`: one command instead of the hand-rolled cp + systemctl recipe. `on` writes `ui.enabled: true` and `ui.owner_login` (and `ui.port` with `--port`) into the user config — line-based, every other line of the file kept byte-for-byte, nothing written if the edited file would not load — copies `templates/systemd/neurastream-ui.service` to `~/.config/systemd/user/neurastream-ui.service`, runs `systemctl --user daemon-reload`, `enable` and `restart`, and prints the phone link `http://<MagicDNS name>:<port>`; the login is checked against the tailnet's logins (new `logins()` Tailscale call, `tailscale status --json`) and a tailscale failure only prints a warning, never refuses. `off` runs `systemctl --user disable --now neurastream-ui` and sets `ui.enabled: false`, keeping `owner_login`. Both stay refused to agents like every `neurastream ui` command.

## 0.2.9
### Fixed
- `neurastream ui` (and the `neurastream-ui` user unit) exited with code 0 about 90 ms after starting, so the owner page was never reachable: the CLI exits with the command's return code, and `runUi` returned right after starting the server. Serving now never returns; the process runs until systemd or a signal stops it.

## 0.2.8
### Added
- Owner phone page (`neurastream ui`, off until `ui.enabled: true`): one server-rendered page over Tailscale — plans waiting on the owner with answer buttons, guard unlock/lock, running agents, the queue, recent merges/CI, open incidents, agent scores, machine health — bound to the tailnet address only. A request is served only to a tailnet peer whose `tailscale whois` login equals `ui.owner_login`, and only with a Host header naming this machine (tailnet address or MagicDNS name from the new `dnsName()` Tailscale call, `tailscale status --self --json`) with the served port — checked on every request before whois, with the POST Origin matched against it, so DNS rebinding gets a 403. Answers append to `<queue_state>/owner-inbox.jsonl`; unlock/lock reuse the chat-unlock core function and log `UNLOCK ui source=ui:<login> minutes=N`. The omp adapter delivers each record once to Main (turn end and a 15 s idle poll, cursor in `<queue_state>/owner-inbox.cursor`; subagent sessions never deliver). Guards refuse agent writes to the inbox and cursor and refuse agent commands that start the page (`neurastream ui`, `systemctl --user start/restart/enable` of `neurastream-ui`). `neurastream doctor` checks `ui.enabled` against the login and a silent tailscale; README "Owner page" has the details.

### Fixed
- Subagents at their call cap can read their own plan file (with or without selectors) and edit its `## Progress` section (INCIDENT I-20261024-27); other file reads and edits remain refused.
- Main's edit window counts only actual project-file modifications from successful tool results and ignores quoted redirect syntax inside shell commands (INCIDENT I-20261024-28).
- `agent-score accept|diagnose|penalty|validate` requires a positional agent name and rejects a missing agent or unknown flags with exit 2 and the usage line (INCIDENT I-20261024-29).

## 0.2.7
### Added
- Chat unlock (`guards.chat_unlock`, default off): the owner's whole chat message `unlock` / `unlock N` / `lock` (trimmed, case-insensitive; N clamped to 1..`guards.unlock_minutes`, `unlock 0` and partial matches like "please unlock 30" do nothing) moves the guard unlock file the same way a terminal `touch` does — `unlock N` backdates the mtime so the existing window closes after exactly N minutes. Only two paths reach it: the omp input event with source `interactive` in the main session, and a collab guest prompt from a peer with write access (the `collab-prompt` custom message, seen on the `context` event; replays of the same message act once, stale ones not at all). Model output, tool results, machine prompts (`before_agent_start`), non-interactive sources and subagent contexts never unlock. Every applied unlock/lock is logged to `paths.plan_guard_log` as `UNLOCK chat source=<interactive|collab:NAME> minutes=N` / `LOCK chat …`, the protected-file refusal names `unlock 30` in chat when the flag is on, and the managed AGENTS.md block documents it.
- Chat notify (Discord and/or Slack): when a session stop hands the turn back to the owner, the adapter posts Main's final reply to the configured channels — deterministic, no model call, once per distinct text, never for a subagent session, never on a blocked stop, never delaying the stop decision (5 s timeout per chunk, one attempt, one guard-log line on failure). The webhook URLs live in secret files only the owner can touch; `notify.discord_webhook_file` / `notify.slack_webhook_file` (default "", off) hold their paths and `notify.prefix` labels the post. The guard refuses every agent's read of a secret file, its directory, or a glob over it — unlock or not — and the neurastream config file and the secret files need the owner's unlock to change. `neurastream doctor` reports a secret file readable by group/others, a raw webhook URL in the config file, or a secret file next to config.yml, and warns about a configured file that is missing. `neurastream notify test` posts one line to every configured channel and exits 1 when one fails.

### Fixed
- tests/guards-scope.test.ts no longer writes into the real guard log (INCIDENT I-20261024-26): the child `neurastream guard` CLI got the temp HOME, but the copy of process.env then put the real HOME back.

## 0.2.6
### Fixed
- `deny-path` catches file writes done through interpreter code (INCIDENT I-20261024-24): a refused subagent could still write or remove denied files with `python3 -c` / a `python3` heredoc / `ruby -e` running `Path(…).write_text()`, `open(…, "w")`, `os.remove/rename/replace/unlink`, `shutil.*`, `.writelines()`, `File.write`, `rmSync` or `appendFile`. These code-write forms are one shared list (the code parts of queue/lib.ts `MUTATING` plus `File.write`) used for both shell command targets and `eval` code, and heredoc bodies are kept as their interpreter segment's code — a heredoc to `cat` is still prose. Reading a denied file (`open('x')`, `Path('x').read_text()`) and writes outside the deny globs stay allowed.

## 0.2.5
### Added
- Per-spawn call budget: a `Call budget: <N>` line in a `task` brief (the task's own text, or the shared `context`; the task's own line wins) gives that run a hard stop at N calls — warning at N − (`guards.sub_max_calls` − `guards.sub_warn_calls`), floored at 1 — instead of the global warn 90 / stop 100, and the ledger's OVER-BUDGET flag uses the same N. The spawn is refused when N is outside 10..`guards.sub_max_calls_cap` (new config key, default 200, must be ≥ `guards.sub_max_calls`) or the task has no `name` (the budget is keyed by it, stored as `<queue_state>/spawn-budgets.json`). A task without the line keeps the global values. brief-lint accepts the line as the brief's call-budget rule.

## 0.2.4
### Fixed
- brief-lint no longer fails a plan on paths from finished work. When the file has a `## Phases` heading, the path check scans only the live parts — the header lines, Goal, Forbidden, Blockers, unticked phase lines and Done check. Paths in ticked phase lines and in the history sections (`## Code read by Main`, `## Progress`, `## Background`) cite worktrees removed after their phases landed and are skipped; a plain brief without `## Phases` is still checked whole.

## 0.2.3
### Fixed
- Plan blockers no longer leak across worktrees of one repo (the 0.2.0 one-index regression). With every plan file living in the main checkout, `planCovers` fell back to "same repo", so the union of all open plans' blockers ran on every worktree of that repo: a subagent working in its own plan's worktree was refused by the `deny-path` rule of a different open plan. A path whose git worktree top is another open plan's `Worktree:` is now covered only by that plan (plus plans whose `## Applies to` lists it); paths in the main checkout and in worktrees no open plan names stay covered as before.

## 0.2.2
### Fixed
- The spawn guard did not see lettered sub-phases (`- [ ] P4a …`): a plan whose only open phases were `P4a`–`P4e` was refused with "no unticked phase left". Phase ids now include one trailing letter.

## 0.2.1
### Fixed
- `neurastream queue migrate` resolved repo-relative lines of an old repo `INDEX.md` (`docs/plans/x.md`) against the current directory instead of that repo, so the main index got wrong plan paths. They now resolve against the repo.

## 0.2.0
### Added
- Plan-guard requires a `Findings:` line in every `## Progress` entry a subagent adds to a plan: `Findings: none`, or one item per finding (bug, workaround, improvement — any repo) with `file:line` evidence, items separated by `;`. An edit that adds an entry without the line is refused and the file restored. Each finding item of an allowed edit becomes an incident (source `findings`, kind `agent-finding`, evidence = plan path + agent); the same item text again dedupes into the open incident, and `Findings: none` records nothing. Main's own entries are unaffected. (The penalty for a false `Findings: none` needs the trace scan and is not part of this.)
### Changed
- The queue is one file (incident I-20261024-7): the main index (`paths.queue_index`) lists plan files, one absolute path per line; the per-repo `INDEX.md` files are gone. A plan file must live in a main checkout, never in a linked worktree, and two open plans may not name one worktree — `queue-check` reports both. Release as 0.2.0 (queue format change): run `neurastream queue migrate` once, it folds the old repo `INDEX.md` lines into the main index, deletes them and is idempotent; plans still inside a worktree are reported, not moved. `neurastream doctor` flags a main index that still lists repo directories.
### Fixed
- queue-close removes the plan's worktree after a successful close only when it is clean and its branch landed, with a plain `git worktree remove` — never `--force`, no `rm -rf`, no docker fallback. A dirty, unmerged or unremovable worktree and the repo's main checkout are kept and the reason printed. Branches leave only via `git branch -d`: when git cannot see the merge (a stale upstream hides the landing), the branch stays. The uncommitted-work stash and the queue-archive branch copy are gone — what is kept is kept in place. The done check for a missing worktree runs in a throwaway shared clone instead of a registered worktree; a scratch the check dirtied is kept, never force-removed.

## 0.1.28
### Fixed
- The relaunch is requested only at a run's real end (incident I-20261024-4). A tool result mid-run no longer writes `relaunch.json` and shuts the session down while Main keeps working; while a relaunch is pending, every later terminal run end calls `shutdown()` again, because omp 18.11.1 re-runs its deferred exit check only then.
- A relaunch omp does not exit falls back to an in-process rollover. If omp still has not exited `rollover.exit_grace_s` seconds (default 20, new config key) after the request, the adapter rolls over in the running process — fresh session, handoff, the owner's typed messages included — instead of leaving a dead UI that swallows every message. A real shutdown cancels the fallback.
- The launcher says what it is doing (`neurastream: starting a new session from the handoff (collecting state, about a minute)…`) and removes `relaunch.json` only after the handoff message is built, so a kill during main-start no longer costs the owner's messages. A fresh `neurastream main` with no message of its own continues an interrupted rollover whose request is at most an hour old.

## 0.1.27
### Fixed
- An upgrade while the launcher runs no longer crashes it (incident I-20261023-6). A relaunch request left after an upgrade goes to a fresh launcher from the installed package, so the handoff is built with the new code. Version helpers live in `src/adapters/omp/package-root.ts`.
- A main-start failure during a rollover no longer stops the launcher. The handoff carries a `main-start failed during the rollover (…)` line, and the note still reaches the next run.
- An incident planned before its fix ships becomes FIXED when the plan that cites it closes. A plan that names an incident several times records it once.

## 0.1.26
### Fixed
- quota-reset prints the local zone abbreviation from `date` (CEST, CET, CST) like the original glm-reset, where Intl's US-only short names printed GMT+2 on non-US hosts; CI re-runs the golden and quota-reset tests under Europe/Berlin on both OSes.
- `neurastream incident plan` finds the repo of a plan at any depth (it walks up to the folder holding INDEX.md), so plans under `docs/plans/immediate/` are accepted instead of refused as "not listed in …/docs/INDEX.md".

## 0.1.25
### Fixed
- Runs on macOS. main-start no longer crashes reading `/proc/loadavg` (incident I-20261023-3). machine-guard reads load, memory, swap, disk and processes with macOS tools. tmp-snapshot runs without `ionice` or GNU `date`. queue-close finds worktrees behind symlinked paths (`/tmp` → `/private/tmp`).
- heavy-run holds its lock for the whole command. Before, it took the lock and dropped it at once, so two heavy-runs overlapped. Locking now uses `flock(2)` through `bun:ffi`, so the external `flock` program is no longer needed. machine-guard's heavy-lock line and lock check use the package's own `heavy-run --status`.
- The subagent guard refuses only shell commands that run queue-close or queue-cancel (including `sh -c`, `$( )` and backticks), not commands that merely name such a file.
### Added
- `neurastream agents list|allow|deny` edits the spawn allow-list (`## Allowed` in notes/subagents.md). allow and deny count as writes to that protected file.
- `neurastream init --allow a,b`, or a one-time prompt on a terminal, sets the allow-list.
- `quota-reset "<time>" [--tz <zone>]` replaces glm-reset (config section `quota:`; works on macOS).
### Changed
- A config with `glm:` still loads (as `quota:`), and `pm:` is ignored. Each prints a notice in `doctor` and main-start.
- brief-lint applies the method-read rule only when `brief.method_marker` is set. The "`find` is broken" and coverage Probe rules are gone; add your own through `brief.repo_rules`. Default `heavy_marker` and `heavy_path`: `heavy-run`.
- CI runs the suite on macOS as well as Linux.
### Removed
- pm-fail-facts and the `pm:` config section; the unused herdr reporter.

## 0.1.24
### Security
- The public package no longer ships personal machine data. Neutral defaults in `templates/config.yml`, one neutral pin example instead of 18 personal pin files, help texts and queue template without personal remotes/paths, `docs/config.md` rewritten, `docs/inventory.md` deleted. npm identity (license, repo URLs) kept.
- `src` is config-driven: the repo-specific init special case and brief-lint rules moved to `brief.repo_rules` in config (default empty).
- New guard test `tests/no-personal-markers.test.ts` fails the suite if a marker reaches the shipped set.
### Added
- `neurastream uninstall [--purge]`: inverse of install + init. Removes bins pointing into the package, the omp plugin copy, template-identical pins; strips the managed AGENTS.md block keeping personal lines. `--purge` also removes config + agent_dir state (listed first, requires `--yes`, refuses outside `$HOME`).


## 0.1.23
### Added
- `templates/AGENTS.md` ships the neurastream orchestrator rules as a managed block. `adapter install omp` writes it into the live `~/.omp/agent/AGENTS.md` between markers, keeps every line outside them, and `doctor` reports `stale:` or `missing:` for the block.
### Changed
- The edit limit Main sees in each prompt comes from `guards.main_edit_limit` and `guards.main_window_min`, not from the rules text.
### Fixed
- `doctor` reports an absent bin as `missing:`, not `foreign:`.

## 0.1.22
### Added
- Progress trim: when Main ticks a plan phase, Progress entries beyond `queue.progress_keep` (default 6) move to `<plan dir>/archive/<name>-progress.md`; `queue-trim <plan> [--keep N]` does the same by hand.
### Fixed
- The plan-read guard refuses only new plan-read problems, and the cite scan skips the Progress section (incident I-20261023-14).
- Machine prompts (guard and rollover text sent as user messages) are not owner corrections, so they no longer count as owner messages or corrections in metrics (incident I-20261023-11).

## 0.1.21
### Fixed
- The edit-window guard no longer counts heredoc bodies (`python3 - <<'EOF'` prose) or punctuation-only redirect targets (`>,`) as project-file writes, so plan text no longer shows up as changes to files such as `<cwd>/,`.

## 0.1.20
### Fixed
- A pending rollover wins over the stop guard: `session_stop` reads the rollover state before `checkStop`. In `ready` and `wait-jobs` the stop is allowed (no queue, incident or cancel block and no "spawn an agent" text), and in `need-note` it is blocked by the note request only.

## 0.1.19
### Fixed
- The rollover request after a neurastream update says "a new neurastream version is installed (…)" instead of claiming the session grew past `rollover.max_session_mb`.

## 0.1.18
### Fixed
- Session rollover has one owner while a relaunch is pending: under neurastream main the owner's messages join the pending handoff (no second session, no stale relaunch) and `/main-rollover` is refused there; a second `/main-rollover` adds its text to the rollover in progress; `ready` refuses new subagent spawns like the other pending states.

## 0.1.17
### Fixed
- queue-close judges the real upstream default branch (local-path origin chains are followed and the default is fetched), keeps a plan worktree that is on another branch, falls back to docker chown and `worktree prune` when git cannot remove a worktree, and runs the done check in a temp worktree of that base when the plan worktree is missing or kept.

## 0.1.16
### Added
- Incidents: bugs this system finds in itself are written to `<paths.queue_state>/incidents.jsonl` and the guards push Main until each open incident has a plan or a recorded dismissal. Sources: real-time detectors (D1 ledger contradiction, D2 tool crash, D3 guard-block loop, D4 owner correction) at Main's prompt and after each Main bash result — D2/D4 on every event, D1/D3 at most once per `incidents.scan_interval_sec` (default 120) — a once-a-day M1-M5 regression check (`incidents.daily_worse_pct`, `incidents.daily_floor`), the weekly report's worst metric, and `neurastream incident add`. While incidents are open, every Main prompt lists them, spawns and bypass launches are refused unless the brief names a plan citing `INCIDENT <id>`, and the stop is gated. `neurastream incident plan/dismiss` records the resolution; a plan citing `INCIDENT <id>` must have a fail-before phase (its regression test has to fail on the old code), and closing such a plan records `fixed` for each id. `neurastream metrics report` gained M6: incidents opened / planned / dismissed / fixed and the median hours from open to fixed. Detectors read Main `wait` toolResults as finished results too.

## 0.1.15
### Fixed
- agent-ledger: a helper whose session ends on a final answer (last assistant message `stop`/`end_turn` with text, no `yield`) shows `done` instead of staying `RUNNING`, so it no longer trips `agent-ledger --cap` with a phantom `OVER-BUDGET`; `MAIN` sessions keep today's rule.

## 0.1.14
### Fixed
- Main rolls over even when the running plugin is older than the installed package: at every turn end the adapter re-reads the `package.json` it was loaded from, a different or unreadable version counts as over the rollover threshold, and the note request names both versions.
- A handoff note that is no longer fresh (it expired while own jobs ran) is asked for again — exactly once per expired note — instead of leaving the rollover stuck.
### Added
- While a rollover is pending (no fresh note, or own jobs still running), Main's `task` spawns are refused until the running jobs finish and the session rolls over.
### Changed
- `neurastream metrics report` groups every `open: <plan list>` guard-block reason into one `open: <list>` key instead of one key per list.

## 0.1.13
### Security
- GitHub Actions in `ci.yml` and `publish.yml` are pinned to full commit SHAs (tags kept as trailing comments) and a new `bunfig.toml` sets a 7-day `minimumReleaseAge` install cooldown: a moved tag or a fresh malicious release can no longer reach the `id-token: write` publish job or a local install.
### Added
- Self-metrics: `neurastream metrics report [--days N]` compares this window with the previous one (M1 cost per merge, M2 idle calls, M3 CI tries, M4 owner corrections, M5 guard blocks), writes `<notes>/metrics.md`, and marks the worst change. `metrics ci`, `metrics false-alarm` and `metrics rule` record CI tries (via `metrics.ci_pipelines_cmd`), guard false alarms and the owner's rule decisions. main-start shows the report as due when it is missing or older than `metrics.report_days`.


## 0.1.12
### Fixed
- Fixed: blockers judged words, not actions. `no-push` refused any command containing "push" (commit messages included), `deny-path` treated every word of a shell command as a path (`git diff uv.lock` was refused), and `deny-command` matched heredoc bodies and quoted text. Blockers now judge the command that runs and the files it writes; `git push`, `rm uv.lock` and `echo y > uv.lock` stay refused.

## 0.1.11
### Fixed
- A `neurastream main` relaunch ran on the default model and wrote its session outside `--session-dir`: it got only the handoff, not the first run's flags. A relaunch now keeps the first run's flags and drops only the first message and the session-picking or one-shot flags (`-r`, `-c`, `--restore`, `--goal`, `-p`, …).

## 0.1.10
### Changed
- Rollover threshold default `rollover.max_session_mb` is 5 MB (was 10). Existing config files keep their own value.
### Added
- `neurastream main` runs omp under a launcher: a session over the rollover threshold rolls over automatically once its handoff note is written and no own jobs are running. The launcher starts a fresh omp with the handoff as its first message; nobody has to type. Plain `omp` keeps the owner-message path. Handoffs over 100000 bytes are written to a file the first message points at.
### Fixed
- The rollover note sat in the protected queue state dir, so Main could not write it without the owner's unlock. Main may now `write` a `.md` directly in `<state>/rollover/`; subagents, shell writes and every other state file stay protected.
- The note request reached Main only on turns started by a prompt; turns started by a finished job never saw it. The request is now sent at turn end and starts a turn itself.

## 0.1.9
### Changed
- README rewritten for a public audience (what it is, what each part enforces, requirements, install, develop); package metadata adds keywords, homepage, bugs and `engines.bun`. No code changes.

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
