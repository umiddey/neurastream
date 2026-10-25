# config.yml

Path: `~/.config/neurastream/config.yml`. `neurastream init` creates it. A second init does not change it.

`neurastream init --allow a,b` (or the prompt on a terminal) adds slugs to the subagent allow-list in `paths.subagents`; it never removes one. See the README install section.

The loader merges, in order (later wins): packaged defaults below, this file, then the env overrides listed below (`QUEUE_AGENT`, `QUEUE_INDEX`, `QUEUE_BLOCKERS`, `QUEUE_STATE`, `QUEUE_SUBAGENTS`, `QUEUE_CANCELLED`, `QUEUE_UNLOCK`, `MAIN_GUARD_LIMIT`, `MAIN_GUARD_WINDOW_MIN`, `MAIN_GUARD_ROOTS`, `MAIN_GUARD_LEDGER`, `MAIN_GUARD_LOG`, `PLAN_GUARD_LOG`, `WIP_LIMIT`, `WIP_DAYS`, `WIP_BACKUP_MAX_REPO_MB`, `WIP_SNAPSHOT_MAX_MB`, `LOAD_MAX`, `AVAIL_MIN_MB`, `DISK_MIN_GB`, `TMP_MAX_MB`, `IDLE_MAX_MIN`). Env exists so tests and the old command lines keep working. Code reads the merged object only.

`src/core` does not embed a home directory, a branch, a provider, a model, a price, or a harness name. Those values live here. `~` and `$HOME` expand at load. An empty string means unset (the command requires the flag).

Values that name a harness are the omp overlay, applied by `neurastream adapter install omp`. A later harness adds its own overlay. Core defaults stay the portable column.

## Defaults (portable form)

```yaml
paths:
  home: "~"
  work_roots: []                             # set your own roots; tools that walk them no-op while empty
  config_dir: "~/.config/neurastream"
  agent_dir: "~/.config/neurastream"        # root for index, blockers, notes, unlock, protected suffixes
  score_state: "~/.local/state/agent-score"  # events.jsonl, oc-runs.jsonl
  queue_state: "~/.local/state/queue"
  queue_index: "~/.config/neurastream/INDEX.md"
  blockers: "~/.config/neurastream/blockers"
  notes: "~/.config/neurastream/notes"
  ranking_board: "~/.config/neurastream/notes/subagent-ranking.md"
  subagents: "~/.config/neurastream/notes/subagents.md"
  cancelled: "~/.config/neurastream/CANCELLED.md"
  unlock: "~/.config/neurastream/.guard-unlock"
  guard_log: "~/.local/state/main-guard.log"
  plan_guard_log: "~/.local/state/plan-guard.log"
  heavy_lock: "~/.local/state/neurastream/heavy-run.lock"
  heavy_owner: "~/.local/state/neurastream/heavy-run.owner"
  heavy_log: "~/.local/state/neurastream/heavy-run.log"
  heavy_idle_state: "~/.local/state/neurastream/heavy-run.idle-state"
  alert_state: "~/.cache/resource-alerts"
  snapshot_lock: "~/.cache/tmp-snapshot.lock"

score:
  default_repo: ""                 # set your own scoring repo; empty = accept/check require --repo
  default_branch: ""               # no default: pass --branch
  penalties:
    false-claim: 5
    rule-break: 2
    escaped-defect: 8
  diagnose_weight: 4
  gate_days: 7
  board_days: 7
  min_dollars: 0.01
  waste_weight: 0                    # rank multiplier for wasted-call rate (0 disables)
  min_hours: 0.05

rollover:
  enabled: true
  max_session_mb: 5
  exit_grace_s: 20

notify:
  discord_webhook_file: ""   # file holding the Discord webhook URL; "" = off
  slack_webhook_file: ""     # file holding the Slack webhook URL; "" = off
  prefix: ""                 # optional label prepended to each posted reply, e.g. "Main:"

metrics:
  report_days: 7
  correction_patterns: ['\bno\b', 'wrong', 'why did', 'properly', 'not what', 'stop', 'bullshit', 'fuck']
  ci_pipelines_cmd: ""   # run in the repo dir with {mr} replaced (shell-quoted); stdout must be a JSON array; tries = its length; "" = not set

incidents:
  contradiction_grace_min: 3   # minutes after a finished task-result before a RUNNING/WAITING ledger row is a contradiction (detector D1)
  block_repeat: 20             # same guard BLOCK reason within 60 minutes that means a block loop (detector D3)
  scan_interval_sec: 120       # seconds between scans of the expensive detectors (D1 ledger, D3 block loop); the cheap ones run on every event
  daily_worse_pct: 25          # a daily metric must be worse than the 7-day mean by at least this percent
  daily_floor:                 # per-metric daily floors: a regression below the floor is noise
    m1: 0.5                    # $ per merge
    m2: 50                     # idle calls/day
    m3: 1.5                    # mean CI tries
    m4_corrections: 1          # owner corrections/day
    m4_questions: 3            # Main questions/day
    m5: 50                     # guard blocks/day

ledger:
  default_hours: 24
  idle_show_min: 5
  idle_not_live_min: 60
  max_running_per_provider: 2
  max_slots: 2
  providers:
    - zai
    - openai-codex
    - anthropic
    - xai-oauth
    - google-antigravity
    - openrouter
    - opencode-zen

brief:
  method_marker: ""  # empty = no method read required
  heavy_marker: "heavy-run"
  max_keys: 10
  warn_chars: 12000
  aim_chars: 8000
  path_prefixes: ["$HOME/"]
  method_read: ""  # text of the missing-method line
  heavy_path: "heavy-run"  # text of the missing-heavy-run line
  repo_rules: []   # optional repo-specific lint rules; each fires when `match` (regex, whole brief) hits and the body lacks `require`:
  # - match: 'legacy-api'            # trigger anywhere in the brief (case-insensitive)
  #   first: 'Refactor'              # optional: also require this on the title line
  #   unless: 'plan only|read-only'  # optional: skip when the title matches this
  #   require: 'regression test'     # the brief must contain this when the rule fires
  #   message: 'legacy-api work must name its regression test'

oc:
  model_prefix: "opencode/"
  tail_lines: 40
  tail_chars: 600

wip:
  limit: 6
  days: 14
  backup_url: ""   # your own private backup repo; wip-backup refuses to invent one
  backup_log: "~/.local/state/neurastream/WIP-BACKUP.md"
  backup_hook_off: []   # origin name fragments whose pre-push hook wip-backup may bypass
  backup_max_repo_mb: 1000
  secret_gate: "~/.local/bin/git-secret-gate"
  snapshot_max_mb: 5
  status_log: "~/.local/state/neurastream/WIP-STATUS.md"
  secret_file: "(?i)(^|/)(\\.env(\\.(?!example$|sample$|template$|dist$)[\\w-]+)?|[^/]*\\.env|env\\.json|[^/]*\\.(pem|p12|pfx|jks|keystore|key)|id_(rsa|dsa|ecdsa|ed25519)|credentials(\\.json)?|\\.netrc|\\.pgpass|\\.htpasswd|local-run\\.env)$"

health:
  warn_ctx: 150000
  tail_calls: 50
  default_hours: 12

queue:
  archive_days: 30
  background_max_lines: 40
  progress_keep: 6
  priority_id: "^[A-Z]{2}[0-9]{2}$"
  cancel_min_words: 3
  auto_close_min: 15
  repo_index: "INDEX.md"
  cancelled_rel: "docs/plans/CANCELLED.md"

guards:
  sub_warn_calls: 90
  sub_max_calls: 100
  sub_max_calls_cap: 200
  main_edit_limit: 5
  main_window_min: 15
  unlock_minutes: 30
  chat_unlock: false   # the owner's whole chat message "unlock"/"unlock N"/"lock" moves the guard unlock file
  plan_read_max_hours: 24
  idle_stops: 3
  rate_limit:
    patterns: ["429", "rate_limit", "rate limit", "overloaded", "529"]   # error-text substrings (case-insensitive) that mark a provider rate limit
    default_wait_s: 300    # wait when the error text names no retry-after
    max_wait_s: 3600       # cap for the parsed (or doubled) wait, before slack
    slack_s: 15            # added on top of every wait
  blocker_timeout_ms: 10000
  skip_tools: [todo, wait, ask, web_search, job, cancel_job]
  read_tools: [read, grep, glob, find]
  shell_tools: [bash, eval]
  write_tools: [write, edit, ast_edit]
  free_ext: "\\.(md|txt)$"
  free_prefixes: []   # path prefixes the write guard allows without an unlock
  bypass_spawn: ["opencode run"]
  protected: []
  ledger_command: "agent-ledger --hours 12"

ui:
  enabled: false        # the owner's phone page (neurastream ui); binds the tailnet address only;
                        # `neurastream ui on` sets it true, `neurastream ui off` back to false
  port: 7787            # `neurastream ui on --port N` writes it here
  owner_login: ""       # the tailscale login that may open the page; empty = the page refuses to start;
                        # `neurastream ui on --login <email>` sets it (kept on `ui off`)

machine:
  load_over_cores: 4
  load_max: 0                       # 0 = nproc + load_over_cores; env LOAD_MAX sets an absolute cap
  avail_min_mb: 3072
  disk_min_gb: 15
  disk_path: "$HOME"
  tmp_max_mb: 4096
  idle_max_min: 20
  idle_min_ticks: 300
  watch_sec: 60
  watch_streak: 3

quota:
  reset_tz: "Asia/Shanghai"
  label: "quota"

priority:
  sleep_sec: 120

alerts:
  temp_c: 90
  mem_psi: 30
  io_psi: 40
  cooldown_sec: 600

snapshot:
  tmp_dest: "~/.local/state/neurastream/tmp-snapshot"
  git_repo: ""   # optional: a repo whose git worktrees get patch snapshots (git worktree list)
  git_backup: ""   # where the patch snapshot lands (only used when snapshot.git_repo is set)
  excludes:
    - "playwright-transform-cache-*"
    - "pytest-of-*"
    - "systemd-private-*"
    - ".X11-unix"
    - ".ICE-unix"
    - ".XIM-unix"
    - ".font-unix"
    - "snap-private-tmp"
    - "*.sock"

traces:
  allowed_hosts:        # hosts a network command may touch without a finding
    - localhost
    - 127.0.0.1
    - "::1"
  bloat:
    first_call_max: 150000   # the largest first-call prompt a healthy run may open with
    ratio_of_limit: 0.8      # a call flags past ratio_of_limit × its model's context limit
    context_limits: {}       # model -> context tokens; open map, no entry = not limit-checked
    tool_group: '^_?mcp__([A-Za-z0-9]+)_'   # first capture names a tool's bloat group
  actions:
    secret_globs:       # a read matching any glob is a high finding; evidence is masked either way
      - "~/.ssh/**"
      - "**/*.env*"
      - "**/*keys*.txt"
      - "**/mcp.json"
      - "**/keyring*/**"
      - "**/.gnupg/**"
      - "**/.password-store/**"
    net_tools: [curl, wget, nc, ssh, scp]   # commands that reach a host (word match inside shell tools)
    shell_patterns: ['| sh', '| bash', 'eval "$(']   # a command containing one feeds a shell from a pipe
    write_roots: []     # prefixes a run may write (plan Worktree: roots); empty falls back to paths.work_roots; both empty = the scope check is off
    deny_globs:         # writes matching any glob are flagged wherever they land
      - "~/.omp/**"
      - "~/.local/bin/**"
      - "~/.local/state/**"
  efficiency:          # wasted-call rules (src/core/trace-efficiency.ts)
    repeat_read_min: 3   # the Nth identical read (same args, no write between) counts; 2 = the first re-read
    guard_prefixes:      # a toolResult text starting with one of these is a guard block
      - "plan-guard:"
      - "main-guard:"
    poll_pattern: '^\s*(sleep\s+\d|ps\b|pgrep\b)'   # shell commands that poll while nothing else runs
```

`ledger.providers` is the allow-list. It is data. Core checks membership and does not know the names.

`ledger.idle_not_live_min` is the idle time, in minutes, after which `agent-ledger --cap` stops counting a RUNNING or WAITING agent as using a provider slot. Such agents are listed on a `NOT LIVE` line; their session has been dead or stalled that long. Default 60.

`guards.protected` starts empty. Init and adapter install append the paths they own (package bins, notes, blockers, and, for the omp adapter, the pin dir and extension dir). Core does not hardcode those paths.

`guards.sub_max_calls_cap` bounds the per-spawn call budget: a `Call budget: <N>` line in a `task` brief (the task's own text, or the shared `context` of the same call; the task's own line wins) gives that run a hard stop at N calls — warning at N − (`guards.sub_max_calls` − `guards.sub_warn_calls`), floored at 1 — instead of the global warn 90 / stop 100. At the stop only plan Progress reads and edits pass, as at the global limit. The spawn is refused when N is outside 10..`guards.sub_max_calls_cap` or the task has no `name`: the budget is keyed by the task name in `<queue_state>/spawn-budgets.json` (next to `spawns.json`), and the ledger flags a still-running sub `OVER-BUDGET` past its own N. A task without the line keeps the global values.

`score.default_branch` has no default. It is config, not a core literal: set it here or pass `--branch`; with `score.default_repo` empty, `accept` / `check` require `--repo` and `--branch`.

`score.waste_weight` must be between 0 and 1. It scales each model's points-per-dollar ranking by its wasted-call fraction; the default 0 leaves the existing ranking unchanged.

`traces.actions` feeds `src/core/trace-actions.ts`. A tool call whose path arguments match a `secret_globs` glob is a secret read. A shell command naming a `net_tools` word reaches a host; it is allowed while the host matches `traces.allowed_hosts` (exact, or `*.suffix`), otherwise flagged — shaped as exfiltration when data flows out (a pipe into the tool, a body/upload option, a stdin redirect, a local scp source). Write targets outside every `actions.write_roots` root (empty falls back to `paths.work_roots`; both empty turn the scope check off) or matching a `deny_globs` glob are out of scope wherever they land. A command containing a `shell_patterns` substring feeds a shell from a pipe. All lists are data: core matches globs and words, it never hardcodes a tool, host or path.

`traces.bloat` feeds `src/core/trace-bloat.ts`. A call's prompt is what the provider read before it wrote: `usage.input + usage.cacheRead + usage.cacheWrite` of one assistant message. A run flags `prompt-bloat` when its first call opens over `bloat.first_call_max`, or when any call's prompt passes `bloat.ratio_of_limit` × its model's `bloat.context_limits` entry; a model without an entry is not limit-checked (the map is open: add your models). `bloat.tool_group` names the group of a request's tools for the breakdown: the first capture of the regex on the tool name; a name that does not match groups as `builtin`.

`traces.efficiency` feeds `src/core/trace-efficiency.ts`, the waste counters behind `neurastream traces efficiency` and the board's waste columns. A call is wasted under the first rule that matches, at most once: `repeat-read` — a read-tool call with the same arguments JSON as an earlier one and no write-tool call between them, the `repeat_read_min`-th and later count; `repeat-fail` — a shell command repeated after an earlier result flagged it as an error, with no write-tool call between, every repeat counts; `failed-edit` — a write-tool call whose result is an error; `guard-repeat` — a toolResult text starting with a `guard_prefixes` entry whose first line repeats an earlier block's first line, every repeat counts; `poll` — shell commands matching `poll_pattern` in an unbroken run of consecutive calls, every one after the first counts. The read and fail chains reset on any write-tool call (a rerun after a change is not a blind repeat); the read tool names, shell tool names and write tool names come from the `guards` section.

## omp overlay (adapter install, not core)

Written only by `neurastream adapter install omp`, appended to this file. The loader accepts this one optional top-level object (name, sessions, pins, extensions, all non-empty strings) and still rejects every other unknown key. A machine that never installs that adapter does not get these keys.

```yaml
adapter:
  name: omp
  sessions: "~/.omp/agent/sessions"
  pins: "~/.omp/agent/agents"
  extensions: "~/.omp/agent/extensions"
```

`paths.agent_dir`, `paths.queue_index`, `paths.blockers`, `paths.notes`, `paths.ranking_board`, `paths.subagents`, `paths.cancelled`, and `paths.unlock` stay at the portable defaults unless init is told to keep an existing layout: `neurastream init --agent-dir <dir>` writes all eight under `<dir>` (and protects `<dir>/notes/`, `<dir>/blockers/`, `<dir>/queue/`). Existing files there are left alone; missing index, notes and blockers are created there. `<dir>/queue/` is left to the harness adapter (the omp adapter links `queue/lib.ts` and `queue/TEMPLATE.md`). `scripts/cutover.sh` passes `--agent-dir ~/.omp/agent` when `~/.omp/agent/INDEX.md` exists.

The harness `config.yml` (models, theme) is not read and not copied.

## Validation

The loader rejects:

- an unknown top-level key
- a threshold that is not a number where this table says a number
- `ledger.max_slots` below 1
- `guards.sub_warn_calls` greater than `guards.sub_max_calls`
- `guards.sub_max_calls_cap` below `guards.sub_max_calls`
- a `paths.*` value that is not a string
- `metrics.report_days` below 1, or a `metrics.correction_patterns` entry that does not compile as a case-insensitive regex
- `ui.port` outside 1..65535
- a `brief.repo_rules` entry whose `match`, `require`, `first` or `unless` does not compile as a case-insensitive regex, or whose `message` is empty
- YAML that does not parse

Missing keys are filled from the defaults above. A present key replaces the default. Objects merge one level (`score.penalties` merges per kind; an omitted kind keeps the default). Arrays replace.


## traces.owned_repos

Names of the owner's products, spelled the way the repos and worktree dirs spell them. A
subagent run that reads files of one of these products outside its own plan's repo — installed
copies under `node_modules` and global installs included, so `@gate-forge/core/...` counts as
gateforge — while its final report says `Findings: none` becomes an `unreported-finding`
incident (source `traces`) and records an `agent-score penalty` event (kind
`unreported-finding`, weight `score.penalties.unreported-finding`) for that agent on the plan.
Intended list: gateforge, neurastream, oi-agent, clanky, PM, CP. The template ships `[]`; an
empty list turns the rule off.
