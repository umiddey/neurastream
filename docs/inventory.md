# Inventory (2026-10-18)

Read-only sources. Nothing under the live setup was edited. Line counts are the files as read. Agent pins matching `.bak*` are skipped. Secrets were not opened (`~/.config/gateforge/**`, `*.env*`, `*keys*.txt`, `mcp.json`, keyrings).

Out of scope (do not port): `ai-terminal`, `claude-*`, codex/gemini/copilot/opencode/pi wrappers, kbd/voice/mic/pamixer scripts, `muse`, `qwen-local`, `omp-local-qwen`, `token-*`, the `git` wrapper, `git-secret-gate`, python entry-point shims. `git-secret-gate` is only a path the backup commands call; the package points at it via config and does not vendor it.

## Decisions (locked for later phases)

1. Thresholds, exit codes, refusal text and ranking math are ported as-is. Anything that looks wrong is listed under "Do not fix" and is not changed.
2. Machine paths and provider names are config keys (`docs/config.md`). `src/core` never contains `/home/ukd`, a repo path, a branch name, a provider name, a model id, a price, or a harness name.
3. Harness-specific pieces (session jsonl layout, extension events, agent pin directory, herdr socket) live only in `src/adapters/omp`. Core asks the adapter for runs and exposes guard decisions. It does not read session files.
4. `~` defaults that expand to today's `/home/ukd/...` paths are the portable form of today's values. Init writes them. A key whose today-value names a harness is an adapter overlay, not a core default.

## Do not fix (match the original)

- `agent-score diagnose` ignores the plan's `difficulty:` unless `--weight` is passed. With no flag it always records weight 4 (source line 266).
- `wip-snapshot` counts secret-file skips in the same counter as files over `MAX_MB`, and the commit message mentions only the size limit.
- `main-guard` `liveSubagents` drops a RUNNING/WAITING line whose idle is at least 60 minutes. The live AGENTS.md summary does not mention this.
- `main-health` invokes `wip-check` from `PATH`, not an absolute bin path.
- The queue bins import the queue library by absolute path. The port imports the package module.

## Bins — Python (`~/.local/bin`, `#!/usr/bin/env python3`)

### agent-score — 312 lines

Ranks workers by accepted points per dollar, then per hour.

| Command | Exit |
|---|---|
| `--help` / `-h` / no args | 0, prints docstring |
| `accept` / `diagnose` / `penalty` / `exempt` / `base` | 0 after one jsonl line, or 1 with a reason |
| `check` | 1 if any commit since base is unscored, else 0 |
| `board` | 0; also overwrites the ranking file |
| `gate` | 0 always (warns, never blocks) |
| unknown | 1 |

| Today | Config key |
|---|---|
| `~/.local/state/agent-score` (`events.jsonl`, `oc-runs.jsonl`) | `paths.score_state` |
| ranking board under the agent notes dir | `paths.ranking_board` |
| session jsonl walk | adapter `listRuns` |
| `/home/ukd/Work/pm-counts` | `score.default_repo` (init writes `~/Work/pm-counts` only if that directory exists; else empty and `--repo` is required) |
| `pm/pr01-counts` | `score.default_branch` |
| penalties false-claim 5, rule-break 2, escaped-defect 8 | `score.penalties` |
| diagnose default weight 4 | `score.diagnose_weight` |
| gate window 7 days | `score.gate_days` |
| board default `--days 7` | `score.board_days` |
| pts/$ hidden when total ≤ 0.01; pts/h hidden when hours ≤ 0.05 | `score.min_dollars`, `score.min_hours` |

Harness-specific: jsonl fields `customType == session_exit`, `toolName == yield`, `stopReason` in `stop|end_turn`, usage `cost.total`, model `provider/model`. A main session is a file whose stem starts with 4 digits. That parser is the omp session reader, not core. Steering cost (splitting main assistant turns that name an agent) is core and uses `Run.messages` from the adapter. OpenCode runs are merged from `oc-runs.jsonl` with cost forced to 0; that log is core state, not a session file.

### agent-ledger — 128 lines

Per-agent tokens, list cost, and how the run ended. Default last 24 hours. `--all` keeps zero-call sessions.

Exit 0 for the table. `--cap` exits 1 when a provider already has 2 running, a planned `--provider` would exceed 2, a live subagent is past 100 calls, or a priority id has no running agent (unless `--priority`). Invalid `--provider` or `--slots` exits 1. It shells out to `queue-check --priority-ids`.

| Today | Config key |
|---|---|
| session root | adapter `listRuns` |
| hours default 24 | `ledger.default_hours` |
| idle shown at ≥ 5 minutes | `ledger.idle_show_min` |
| OVER-BUDGET above 100 calls | `guards.sub_max_calls` |
| max 2 running per provider | `ledger.max_running_per_provider` |
| `--slots` must be 1..2 | `ledger.max_slots` |
| provider allow-list `zai`, `openai-codex`, `anthropic`, `xai-oauth`, `google-antigravity`, `openrouter`, `opencode-zen` | `ledger.providers` (data, not a core literal) |
| priority id shape two capitals + two digits | `queue.priority_id` |

Harness-specific: same jsonl fields, plus `customType == tool_execution_start` with `toolName == wait` becomes `WAITING: <intent>`, and `usage.totalTokens` / `cacheRead` / `cost.total`. A top-level session stem is renamed `MAIN ` plus characters 11–19 of the stem.

### brief-lint — 81 lines

Refuses a brief that misses a deterministic rule. Exit 1 if any FAIL, else 0. No args: prints the docstring and exits 1.

Checks that must stay: method file named, Acceptance/Done/Report heading, never-push line, `find` and `broken`, heavy runs name `heavy-run.sh`, Gateforge vitest lines also name `typecheck`, a coverage batch has a Probe log containing `satisfied` (unless the first line is plan-only / read-only review / CI fix / delete, or a Probe-first heading tells the agent to run it), PM/CP coverage quotes `Gate before: <N> missing` and before-to-after, cited absolute paths exist (warn if the parent dir exists and the basename has a dot), a call-budget line, key files matching `*keys*.txt` have at most 10 non-blank lines, warn if the brief is over 12000 characters (aim under 8000).

| Today | Config key |
|---|---|
| method marker `opus-implementer-method.md` | `brief.method_marker` |
| heavy-run marker | `brief.heavy_marker` |
| key batch max 10 | `brief.max_keys` |
| warn 12000 / aim 8000 | `brief.warn_chars`, `brief.aim_chars` |
| path prefix `/home/ukd/` | `brief.path_prefixes` default `["$HOME/"]` |

### oc-run — 39 lines

`oc-run <Agent> -- [KEY=VAL ...] <command...>`. Streams the child, logs the start, then rewrites that line with end, exit, final, and tail. Exit equals the child exit. Usage or empty command: 1.

| Today | Config key |
|---|---|
| `~/.local/state/agent-score/oc-runs.jsonl` | `paths.score_state` |
| model from `-m`; prefix `opencode/` unless it already starts with `opencode` | `oc.model_prefix` |
| tail kept: 40 lines, stored tail 600 chars | `oc.tail_lines`, `oc.tail_chars` |

The child command is an external launch. Core only appends the log record. No adapter is required to run the child.

### wip-check — 70 lines

Unlanded branches (commits on no remote) and dirty worktrees. Exit 1 when the unlanded count exceeds the limit.

| Today | Config key |
|---|---|
| roots `/home/ukd/Work`, `/home/ukd/projects` | `paths.work_roots` default `["~/Work", "~/projects"]` |
| `WIP_LIMIT` default 6 | `wip.limit` |
| `WIP_DAYS` default 14; `--all` uses 1000000 days | `wip.days` |

Dirty means tracked changes only (`--untracked-files=no`). That is behaviour, not config.

### wip-backup — 112 lines

Pushes unpushed branches and the newest `refs/wip/` snapshot per worktree to a private backup remote. Does not pass `--no-verify`, except the one owner-allowed repo, and only for that backup push. Exit 1 if any push failed.

| Today | Config key |
|---|---|
| same roots | `paths.work_roots` |
| `git@github.com:umiddey/wip-backup-clean.git` | `wip.backup_url` |
| `/home/ukd/Work/WIP-BACKUP.md` | `wip.backup_log` default `~/Work/WIP-BACKUP.md` |
| hook-off origin substring `umiddey/aetherios-property-management` | `wip.backup_hook_off` |
| `WIP_BACKUP_MAX_REPO_MB` default 1000 | `wip.backup_max_repo_mb` |
| `/home/ukd/.local/bin/git-secret-gate` | `wip.secret_gate` (not packaged) |
| relpath base `/home/ukd` | `paths.home` |

### wip-snapshot — 110 lines

Hidden commit at `refs/wip/<worktree-key>/<stamp>` from a temporary index. Exit 1 if any worktree failed. Writes `WIP-STATUS.md` including `wip-check` stdout.

| Today | Config key |
|---|---|
| roots | `paths.work_roots` |
| `WIP_SNAPSHOT_MAX_MB` default 5 | `wip.snapshot_max_mb` |
| secret filename regex (env, pem, keys, `.gateforge/test-gates/`) | `wip.secret_file` |
| `/home/ukd/Work/WIP-STATUS.md` | `wip.status_log` default `~/Work/WIP-STATUS.md` |
| key = path with `/home/ukd/` stripped, slashes to underscores | `paths.home` |

### pm-fail-facts — 77 lines

One report for a Playwright junit. Exit 1 if no args or the junit file is missing.

| Today | Config key |
|---|---|
| default backend log `/home/ukd/Work/gf-testbed/pm-batch-logs/backend-last.log` | `pm.backend_log` default `~/Work/gf-testbed/pm-batch-logs/backend-last.log` |
| `--lines` default 25 | `pm.fail_lines` |
| error pattern `Traceback|ERROR|CRITICAL|Exception| 5\d\d ` | `pm.backend_error` |

Artifact dir `test-results/playwright-output` is behaviour.

### main-health — 47 lines

Context size of the newest top-level session. Exit 0.

| Today | Config key |
|---|---|
| newest top-level session jsonl | adapter `mainSession()` |
| warn above 150000 tokens | `health.warn_ctx` |
| last 50 calls for min/max | `health.tail_calls` |

Last owner message is truncated to 160 characters. It calls `wip-check` on `PATH`.

## Bins — Bun (`#!/usr/bin/env bun`)

### queue-check — 51 lines

Prints the queue summary plus extra problems: repo `INDEX.md` tracked by git, not gitignored, or a repo under the work roots has plans but is not in the main index. Exit 1 if any problem. `--priority-ids` prints open, non-waiting priority ids, one per line, exit 0.

Imports the queue library by absolute path. Roots are `$HOME/Work` and `$HOME/projects` (`paths.work_roots`).

### queue-close — 258 lines

The only way a plan leaves the queue. Exits: 0 closed, 1 refused, 3 already running, 4 awaiting merge.

`ARCHIVE_DAYS = 30` → `queue.archive_days`. State dir `~/.local/state/queue` → `paths.queue_state`. Index under the agent dir → `paths.queue_index` (portable default `~/.config/neurastream/INDEX.md`; omp overlay may point at the live index at cutover, which is Main's job).

### queue-cancel — 96 lines

Records an owner cancel, a `--never` ban, or `--not-a-cancel`. Exit 0 recorded, 1 refused. Clears `paths.queue_state/cancel-pending.json`. `--not-a-cancel` why must be at least 10 characters; `--never` what at least 10 and at least 2 key words; owner words at least 3.

Both bins are Main-only. plan-guard refuses a subagent shell whose text names those bins. The port keeps that refusal.

### queue/lib.ts — 580 lines

Shared queue model. This is core (rules), with paths from config.

| Constant | Today | Key |
|---|---|---|
| `INDEX` | env `QUEUE_INDEX` or the agent index | `paths.queue_index` |
| `BLOCKERS_DIR` | env `QUEUE_BLOCKERS` or the agent blockers dir | `paths.blockers` |
| `STATE_DIR` | env `QUEUE_STATE` or `~/.local/state/queue` | `paths.queue_state` |
| `SUBAGENTS_MD` | env `QUEUE_SUBAGENTS` or notes/subagents.md | `paths.subagents` |
| `GLOBAL_CANCELLED` | env `QUEUE_CANCELLED` or the agent CANCELLED.md | `paths.cancelled` |
| `UNLOCK` | agent `.guard-unlock` | `paths.unlock` |
| `UNLOCK_MINUTES` | 30 | `guards.unlock_minutes` |
| `BACKGROUND_MAX_LINES` | 40 | `queue.background_max_lines` |
| `SUB_WARN_CALLS` / `SUB_MAX_CALLS` | 90 / 100 | `guards.sub_warn_calls` / `guards.sub_max_calls` |
| required sections | goal, forbidden, blockers, phases, done check, progress | behaviour |
| extra known sections | `applies to`, `background` | behaviour |
| status values | open, complete, cancelled | behaviour |
| priority id | `^[A-Z]{2}[0-9]{2}$` on a `PRIORITY-ID:` line | `queue.priority_id` |
| cancel match | at least 3 shared key words, or half the smaller set if shorter | `queue.cancel_min_words` |
| `PROTECTED` | guards, queue, blockers, pins, AGENTS.md, CANCELLED.md, queue state, harness config.yml, subagents.md, unlock, git-no-verify guard, five bins, git-secret-gate config dir | `guards.protected`, filled by init and adapter install |
| env overrides | the `QUEUE_*` names above | still honoured, and they win over the file (tests) |

`TEMPLATE.md` (36 lines) ships as the package template. Header fields: Worktree, Branch, PRIORITY-ID. Difficulty scale in the comment: 1, 2, 3, 4, 5, 8. The parser enforces `verify: \`command\`` only, not the difficulty number.

## Bins — bash

### main-start — 13 lines

One preflight. Argument default hours 12 → `health.default_hours`. Calls machine-guard (last line only), agent-ledger, agent-ledger `--cap` (keeps PRIORITY IDLE and FULL lines), main-health, queue-check, and prints the heavy-run lock (first 2 lines). Does not `set -e`. A missing lock is fine.

### machine-guard — 81 lines

One snapshot, exit 1 if any threshold is crossed. `--watch` samples every 60s, exits 1 after 3 bad samples, exits 2 on a new OOM kill.

| Today | Config key |
|---|---|
| `LOAD_MAX` = nproc + 4 | `machine.load_over_cores` |
| `AVAIL_MIN_MB` 3072 | `machine.avail_min_mb` |
| `DISK_MIN_GB` 15 on `/home` | `machine.disk_min_gb`, `machine.disk_path` default `$HOME` |
| `TMP_MAX_MB` 4096 | `machine.tmp_max_mb` |
| `IDLE_MAX_MIN` 20, CPU delta 300 ticks | `machine.idle_max_min`, `machine.idle_min_ticks` |
| lock, owner, idle-state under `/home/ukd/Work` | `paths.heavy_lock`, `paths.heavy_owner`, `paths.heavy_idle_state` |
| status via `heavy-run.sh --status` | package bin `heavy-run` |
| watch interval 60, streak 3 | `machine.watch_sec`, `machine.watch_streak` |

### glm-reset — 14 lines

Interprets a 429 timestamp as `Asia/Shanghai` and prints local time. Exit 2 on missing args, else 0.

| Today | Config key |
|---|---|
| `TZ=Asia/Shanghai` | `glm.reset_tz` |
| label `GLM` | `glm.label` (the bin name stays `glm-reset`) |

### priority-watch — 11 lines

Loops until agent-ledger `--cap` prints `PRIORITY IDLE` on two checks about 120s apart, then exits 0. Sleep → `priority.sleep_sec`.

### resource-alerts — 37 lines

Always exits 0. Desktop notify, cooldown per metric.

| Today | Config key |
|---|---|
| temp 90°C Tctl, mem PSI some 30, io PSI full 40 | `alerts.temp_c`, `alerts.mem_psi`, `alerts.io_psi` |
| cooldown 600 | `alerts.cooldown_sec` |
| state `$HOME/.cache/resource-alerts` | `paths.alert_state` |

### tmp-snapshot.sh — 67 lines

Rolling `/tmp` mirror plus uncommitted Gateforge worktrees. Lock busy exits 0. rsync exit 23 and 24 are accepted.

| Today | Config key |
|---|---|
| `/home/ukd/Work/tmp-snapshot` | `snapshot.tmp_dest` default `~/Work/tmp-snapshot` |
| `/home/ukd/Work/gateforge` | `snapshot.git_repo` default `~/Work/gateforge` |
| `/home/ukd/Work/gf-backups/latest` | `snapshot.git_backup` default `~/Work/gf-backups/latest` |
| lock `~/.cache/tmp-snapshot.lock` | `paths.snapshot_lock` |
| rsync excludes (playwright cache, pytest, systemd-private, X11 sockets, snap-private-tmp, gf-luna, `*.sock`) | `snapshot.excludes` |

The package bin name is `tmp-snapshot` (no `.sh`).

### heavy-run.sh — 32 lines (`/home/ukd/Work/heavy-run.sh`)

Machine lock. `--status` exits 0 (`free` or `busy: ...`). Usage exit 2. Otherwise the wrapped command's exit.

| Today | Config key |
|---|---|
| `/home/ukd/Work/.heavy-run.lock` | `paths.heavy_lock` |
| `/home/ukd/Work/.heavy-run.owner` | `paths.heavy_owner` |
| `/home/ukd/Work/.heavy-run.log` | `paths.heavy_log` |

Compat bin name: `heavy-run`.

## Extensions (harness-specific)

Loaded today because they sit in the agent extensions directory. The package declares them with `package.json` `"omp": { "extensions": ["./src/adapters/omp/index.ts"] }` (same shape as the omp-optchat package). Install links that entry under the sandbox HOME. It does not edit the live directory.

### main-guard.ts — 389 lines

| Extension event | Core call |
|---|---|
| `session_start` (main only) | start the auto-close timer |
| `before_agent_start` | `promptInject` (queue summary + cancel flag); also resets the edit window |
| `before_subagent_spawn` | `checkSpawn` (allow-list, and invocation kind must be `task`) |
| `tool_call` | `checkTool` (edit limit, task plan gate, bypass-spawn plan gate) |
| `tool_result` on a push or merge | schedule close |
| `session_stop` | `checkStop` |

Rules that move into core as pure functions: 5 changes per 15 minutes (`MAIN_GUARD_LIMIT`, `MAIN_GUARD_WINDOW_MIN`), free extensions `.md` and `.txt`, free roots from `MAIN_GUARD_ROOTS` (default `$HOME/Work/` and `$HOME/projects/`), free prefixes `gf-testbed/`, `archive/`, and `heavy-run.sh` under Work, spawn allow-list from `` - `name` `` lines under `## Allowed`, plan gate (absolute plan path, open, valid, not waiting, progress hash changed since the last spawn, no unclosed complete/cancelled unless awaiting merge), spin guard of 3 idle stops, auto-close every 15 minutes. Ledger command default `agent-ledger --hours 12` (`MAIN_GUARD_LEDGER`). Log `~/.local/state/main-guard.log`.

A shell launch that skips the spawn hook (today: `opencode run`) is a core rule. The command text is config `guards.bypass_spawn`, default `["opencode run"]`, not an import.

### plan-guard.ts — 166 lines

| Extension event | Core call |
|---|---|
| `tool_call` | `checkTool` (protected files, subagent budget, blockers, plan-edit snapshot) |
| `tool_result` | `checkPlanEdit` — restore if anything outside `## Progress` or a Main-only line changed |

Skip tools (no budget count): `todo`, `wait`, `ask`, `web_search`, `job`, `cancel_job`. Read tools: `read`, `grep`, `glob`, `find`. Blocker stdin is the JSON in `docs/adapter.md`. Timeout 10 seconds. Exit 2 from a blocker refuses. Log `~/.local/state/plan-guard.log`.

Main-only progress lines: `Status:`, `WAITING on owner:`, `Cancelled by owner:`, `False positive:`.

### herdr-omp-agent-state.ts — 471 lines

Installed by herdr (integration id omp, version 10). Reports pane state over a socket when `HERDR_ENV=1`. A nested session (`OMPCODE=1`) must not report. Idle debounce 250ms, retry grace 2500ms. Not a core rule. The omp adapter ships a copy. Core never imports it. Reinstalling herdr overwrites the live file. Adapter install under a sandbox HOME does not touch the live file.

## Blockers (core; Python today, TypeScript in the port)

Contract: argv = plan args, stdin = call JSON, exit 0 allow, exit 2 plus one stderr line refuse.

| File | Lines | Rule |
|---|---|---|
| `_blocker.py` | 70 | shared: shell tools `bash`/`eval`, write tools `write`/`edit`/`ast_edit`, path match, written-text extract |
| `deny-command` | 13 | shell command matches any argv regex |
| `deny-path` | 15 | a write, or a mutating shell, touches a glob |
| `deny-text` | 13 | new text matches any argv regex |
| `no-push` | 8 | subagent shell matching `git push`, `glab mr merge`, or `gh pr merge` |

`_blocker.py` `MUTATING` is a shorter regex than `lib.ts` `MUTATING`. Port both as they are. Do not unify them.

## Notes and pins (templates, not logic)

| File | Lines | Ships as |
|---|---|---|
| agent `AGENTS.md` | 38 | `templates/AGENTS.md` (orchestrator rules). Not imported by core. |
| `notes/subagents.md` | 52 | template. `## Allowed` is machine-read. |
| `notes/lessons.md` | 83 | template |
| `notes/projects.md` | 40 | template |
| `notes/subagent-ranking.md` | generated | not a template; `agent-score board` overwrites it |
| `agents/*.md` except `.bak*` | 17 pins | `templates/agents/` |

Pins (name → model). Skip every `.bak*`.

| name | model |
|---|---|
| apodex | `openrouter/apodex/apodex-1.1-mini:free` |
| bunny | `opencode-zen/space-bunny-free` |
| bunny-user | `openrouter/dots-studio/dots-3-note-preview:free` |
| composer | `cursor/composer-2.5-fast` |
| deepseek | `openrouter/deepseek/deepseek-v4.1-flash-1017` |
| gemini | `google-antigravity/gemini-3.8-flash` |
| glm | `zai/glm-5.3-flash` |
| grok | `xai-oauth/grok-4.7` |
| haiku | `anthropic/claude-haiku-5-5` |
| hiko | `cursor/claude-haiku-5-5` |
| ling | `openrouter/inclusionai/ling-3.1-flash` |
| local-qwen | `qwen-local/qwen3.5-4b-local` |
| luna | `openai-codex/gpt-6-luna` |
| luna-medium | `openai-codex/gpt-6-luna` |
| muse | `opencode-go/muse-spark-1.3-contributor` |
| sol | `openai-codex/gpt-6.1-sol` |
| sol-xhigh | `openai-codex/gpt-6.1-sol` (thinking xhigh; planner, not in `## Allowed`) |

`## Allowed` today: glm, deepseek, composer, hiko, muse, luna, sol, grok, gemini, local-qwen, haiku. `sol-xhigh` and unpinned built-ins are absent on purpose.

Prices appear only in notes (deepseek $0.15 per million in, $0.60 per million out), not in any script. No price table in core. Cost comes from session usage.

## Session file (adapter reader only)

- Main: `sessions/<project>/<session>.jsonl`, stem starts with 4 digits.
- Subagent: one level deeper, stem = agent name.
- Fields used: `timestamp`, `customType` (`session_exit`, `tool_execution_start`), `message.role`, `message.model`, `message.provider`, `message.usage` (`totalTokens`, `cacheRead`, `input`, `cacheWrite`, `cost.total`), `message.errorMessage`, `message.stopReason`, `message.toolName`, `message.isError`, `message.content`.

The harness `config.yml` (models, theme, extension list) is not this package's config. Do not copy it. Our file is `~/.config/neurastream/config.yml`.
