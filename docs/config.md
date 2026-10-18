# config.yml

Path: `~/.config/neurastream/config.yml`. `neurastream init` creates it. A second init does not change it.

The loader merges, in order (later wins): packaged defaults below, this file, then the env overrides named in the inventory (`QUEUE_AGENT`, `QUEUE_INDEX`, `QUEUE_BLOCKERS`, `QUEUE_STATE`, `QUEUE_SUBAGENTS`, `QUEUE_CANCELLED`, `QUEUE_UNLOCK`, `MAIN_GUARD_LIMIT`, `MAIN_GUARD_WINDOW_MIN`, `MAIN_GUARD_ROOTS`, `MAIN_GUARD_LEDGER`, `MAIN_GUARD_LOG`, `PLAN_GUARD_LOG`, `WIP_LIMIT`, `WIP_DAYS`, `WIP_BACKUP_MAX_REPO_MB`, `WIP_SNAPSHOT_MAX_MB`, `LOAD_MAX`, `AVAIL_MIN_MB`, `DISK_MIN_GB`, `TMP_MAX_MB`, `IDLE_MAX_MIN`). Env exists so tests and the old command lines keep working. Code reads the merged object only.

`src/core` does not embed `/home/ukd`, a branch, a provider, a model, a price, or a harness name. Those values live here. `~` and `$HOME` expand at load. An empty string means unset (the command requires the flag).

Today's live values that name a harness are the omp overlay, applied by `neurastream adapter install omp`. A later harness adds its own overlay. Core defaults stay the portable column.

## Defaults (today's numbers, portable form of today's paths)

```yaml
paths:
  home: "~"                                  # today: /home/ukd
  work_roots: ["~/Work", "~/projects"]       # today: /home/ukd/Work, /home/ukd/projects
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
  heavy_lock: "~/Work/.heavy-run.lock"
  heavy_owner: "~/Work/.heavy-run.owner"
  heavy_log: "~/Work/.heavy-run.log"
  heavy_idle_state: "~/Work/.heavy-run.idle-state"
  alert_state: "~/.cache/resource-alerts"
  snapshot_lock: "~/.cache/tmp-snapshot.lock"

score:
  default_repo: ""                 # init writes ~/Work/pm-counts only if that directory exists
  default_branch: "pm/pr01-counts" # today's branch; ignored when default_repo is empty
  penalties:
    false-claim: 5
    rule-break: 2
    escaped-defect: 8
  diagnose_weight: 4
  gate_days: 7
  board_days: 7
  min_dollars: 0.01
  min_hours: 0.05

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
  method_marker: "opus-implementer-method.md"
  heavy_marker: "heavy-run.sh"
  max_keys: 10
  warn_chars: 12000
  aim_chars: 8000
  path_prefixes: ["$HOME/"]
  method_read: "$HOME/projects/opus-implementer-method.md"  # text of the missing-method line
  heavy_path: "$HOME/Work/heavy-run.sh"                    # text of the missing-heavy-run line

oc:
  model_prefix: "opencode/"
  tail_lines: 40
  tail_chars: 600

wip:
  limit: 6
  days: 14
  backup_url: "git@github.com:umiddey/wip-backup-clean.git"
  backup_log: "~/Work/WIP-BACKUP.md"
  backup_hook_off: ["umiddey/aetherios-property-management"]
  backup_max_repo_mb: 1000
  secret_gate: "~/.local/bin/git-secret-gate"
  snapshot_max_mb: 5
  status_log: "~/Work/WIP-STATUS.md"
  secret_file: "(?i)(^|/)(\\.env(\\.(?!example$|sample$|template$|dist$)[\\w-]+)?|[^/]*\\.env|env\\.json|[^/]*\\.(pem|p12|pfx|jks|keystore|key)|id_(rsa|dsa|ecdsa|ed25519)|credentials(\\.json)?|\\.netrc|\\.pgpass|\\.htpasswd|local-run\\.env)$|(^|/)\\.gateforge/test-gates/"

pm:
  backend_log: "~/Work/gf-testbed/pm-batch-logs/backend-last.log"
  fail_lines: 25
  backend_error: "Traceback|ERROR|CRITICAL|Exception| 5\\d\\d "

health:
  warn_ctx: 150000
  tail_calls: 50
  default_hours: 12

queue:
  archive_days: 30
  background_max_lines: 40
  priority_id: "^[A-Z]{2}[0-9]{2}$"
  cancel_min_words: 3
  auto_close_min: 15
  repo_index: "INDEX.md"
  cancelled_rel: "docs/plans/CANCELLED.md"

guards:
  sub_warn_calls: 90
  sub_max_calls: 100
  main_edit_limit: 5
  main_window_min: 15
  unlock_minutes: 30
  idle_stops: 3
  blocker_timeout_ms: 10000
  skip_tools: [todo, wait, ask, web_search, job, cancel_job]
  read_tools: [read, grep, glob, find]
  shell_tools: [bash, eval]
  write_tools: [write, edit, ast_edit]
  free_ext: "\\.(md|txt)$"
  free_prefixes: ["~/Work/gf-testbed/", "~/Work/archive/", "~/Work/heavy-run.sh"]
  bypass_spawn: ["opencode run"]
  protected: []
  ledger_command: "agent-ledger --hours 12"

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

glm:
  reset_tz: "Asia/Shanghai"
  label: "GLM"

priority:
  sleep_sec: 120

alerts:
  temp_c: 90
  mem_psi: 30
  io_psi: 40
  cooldown_sec: 600

snapshot:
  tmp_dest: "~/Work/tmp-snapshot"
  git_repo: "~/Work/gateforge"
  git_backup: "~/Work/gf-backups/latest"
  excludes:
    - "playwright-transform-cache-*"
    - "pytest-of-*"
    - "systemd-private-*"
    - ".X11-unix"
    - ".ICE-unix"
    - ".XIM-unix"
    - ".font-unix"
    - "snap-private-tmp"
    - "gf-luna"
    - "*.sock"
```

`ledger.providers` is today's allow-list. It is data. Core checks membership and does not know the names.

`guards.protected` starts empty. Init and adapter install append the paths they own (package bins, notes, blockers, and, for the omp adapter, the pin dir and extension dir). Core does not hardcode those paths.

`score.default_branch` is today's branch name. It is config, not a core literal. When `score.default_repo` is empty the branch is unused and `accept` / `check` require `--repo` and `--branch`.

## omp overlay (adapter install, not core)

Written only by `neurastream adapter install omp`. A machine that never installs that adapter does not get these keys.

```yaml
adapter:
  name: omp
  sessions: "~/.omp/agent/sessions"
  pins: "~/.omp/agent/agents"
  extensions: "~/.omp/agent/extensions"
```

`paths.agent_dir`, `paths.queue_index`, `paths.blockers`, `paths.ranking_board`, `paths.subagents`, `paths.cancelled`, and `paths.unlock` stay at the portable defaults unless the owner points them at the live files at cutover. Cutover is Main's job.

The harness `config.yml` (models, theme) is not read and not copied.

## Validation

The loader rejects:

- an unknown top-level key
- a threshold that is not a number where this table says a number
- `ledger.max_slots` below 1
- `guards.sub_warn_calls` greater than `guards.sub_max_calls`
- a `paths.*` value that is not a string
- YAML that does not parse

Missing keys are filled from the defaults above. A present key replaces the default. Objects merge one level (`score.penalties` merges per kind; an omitted kind keeps the default). Arrays replace.
