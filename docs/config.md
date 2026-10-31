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

harness: omp                                # which adapter (docs/adapter.md) serves runs, traces, launch, install and doctor

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
  product_cmds: {}       # {<repo path>: {<name>: shell command printing one number}}, run in that repo after every `metrics ci` merge
  # product_cmds:
  #   /opt/myapp:
  #     dist_mb: "du -sm frontend/dist | cut -f1"
  # Each merge then appends {type: "product", repo, name, value, ts} to metrics.jsonl; a command
  # that fails, times out (10 s) or prints anything but one number is skipped with a stderr line
  # and never fails the ci record. `neurastream metrics releases` shows each number's last value
  # before vs first value after every release.

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

watch:                         # the watcher (src/core/watch.ts): `neurastream watch` runs one pass
  expect:                      # hours after which a job's last heartbeat is stale (beat-stale); only listed jobs must beat at all
    wip-snapshot: 2            # hourly snapshot
    wip-backup: 26             # nightly 23:30 backup; one missed day is not yet stale
    metrics-report: 192        # 8 days; the weekly report job
  units:                       # user units the watcher reports when failed (unit-failed), as globs
    - "neurastream-*"
    - "wip-*"
  max_posts_per_run: 3         # per run: at most this many new-incident posts, then one "+N more, see `neurastream incident list --open`" line
  interval_min: 15            # minutes between watcher runs; `neurastream watch on` installs the timer at this interval

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
  main_warn_calls: 12      # Main tool calls per turn that draw the wrap-up warning
  main_max_calls: 15       # Main tool calls per turn before refusal; 0 = off
  main_call_exempt_tools: [task, todo, ask, wait]   # never counted, never refused at the cap: delegating, tracking and asking stay open
  main_edit_limit: 5
  main_window_min: 15
  unlock_minutes: 30
  chat_unlock: false   # the owner's whole chat message "unlock"/"unlock N"/"lock" moves the guard unlock file
  plan_read_max_hours: 24
  idle_stops: 3
  plan_offer: 'want me to (write|make) a plan|should i plan|shall i plan|if you want, i(''ll)? plan|plan it or|\bi will\b|\bi(''|’)ll\b'   # refused: don't promise or offer it — do it now, or write the plan and index it
  rate_limit:
    patterns: ["429", "rate_limit", "rate limit", "overloaded", "529"]   # error-text substrings (case-insensitive) that mark a provider rate limit
    default_wait_s: 300    # wait when the error text names no retry-after
    max_wait_s: 3600       # cap for the parsed (or doubled default) wait, before slack
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
  allow_this_machine: false   # admit this machine (loopback and its own tailnet IP) as the owner,
                        # GET and POST; any local process can then press the buttons


pages:
  enabled: false
  port: 7788
  dir: "~/.local/share/neurastream/pages"
  keep_days: 15            # delete a published page this many days later; `pages publish --keep` keeps it

knowledge:                 # repo-local HTML explainers (docs/knowledge/<topic>.html) on the phone page's Knowledge tab
  roots: ["$HOME/projects", "$HOME/Work"]   # scanned for git repos; $HOME expands to the config's home
  max_age_s: 300           # rebuild the topic list when older, so a git pull shows up on the next reload

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
  reset_pattern: 'reset at (\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?)\s*(Z|UTC|GMT|[+-]\d{2}:?\d{2}|[A-Z]{2,5}\b)?'
  label: "quota"

secrets:
  redact: true
  known_value_files: ["~/.npmrc"]
  extra_patterns: []
  proxy: "none"

write_check:
  enabled: false
  applies_to: sub
  timeout_ms: 5000
  suppress: '(#|//|/\*)\s*(noqa|type:\s*ignore|oxlint-disable|eslint-disable|biome-ignore|@ts-ignore|@ts-expect-error|@ts-nocheck)'
  defer_rules: ["no-unused-vars", "F401", "F841"]
  linters:
    - ext: [".py"]
      argv: ["ruff", "check", "--no-cache", "--output-format=concise", "{file}"]
      pattern: '^.+?:\d+:\d+: (?<rule>\S+) '
      only_with_config: ["pyproject.toml", "ruff.toml", ".ruff.toml"]
    - ext: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]
      argv: ["oxlint", "-f", "unix", "{file}"]
      pattern: '^.+?:\d+:\d+: .*\[(?:Error|Warning)/(?<rule>[^\]]+)\]'
      only_with_config: [".oxlintrc.json", ".oxlintrc.jsonc", ".oxlintrc.js", ".oxlintrc.mjs", ".oxlintrc.cjs", "eslint.config.js", "eslint.config.mjs", "eslint.config.cjs", "eslint.config.mts", "eslint.config.cts"]

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
    aggregate_apis: ["cursor-agent"] # APIs whose usage aggregates multiple internal calls
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
  briefs:              # brief-quality rules (src/core/trace-briefs.ts): what a spawn brief names, and the report's length buckets
    verify_pattern: '\b(?:bun test|bun run typecheck|pytest|npm test|go test|cargo test)\b'
    phase_pattern: '\bP\d+[a-z]?\b'
    plan_pattern: 'docs/plans/\S+\.md'
    char_buckets: [1500, 4000]   # brief length edges: <1500, 1500-3999, >=4000
    min_n: 5             # the report shows a mean only with at least this many rows on that side
```

`ledger.providers` is the allow-list. It is data. Core checks membership and does not know the names.

`secrets.*` feeds `src/core/secret-redact.ts`. With `secrets.redact` on, every tool result (Main and every subagent, before the model, the chat and the session log see it), every notify post and `neurastream redact` (stdin → stdout, hit summary on stderr) go through the redactor; each hit prints as `[REDACTED:<type>]` and only types and counts are ever logged. Detection is by content, never by file name: built-in shapes (npm, GitHub, GitLab, `sk-` keys, AWS, Google, Slack, Discord webhooks, Stripe, JWT, PEM private keys, URL credentials, `.npmrc` `_authToken`/`_password`, generic `password|secret|token|api_key|…` assignments of 8+ characters), then `secrets.extra_patterns` (`{type, regex}`), then the exact known values (8+ characters) from credential-named env vars, the `KEY=value` lines of `secrets.known_value_files`, every top-level `.env…` file under `paths.work_roots` and the notify webhook secret files; known values are re-read when a file's mtime or size changes. `secrets.proxy: secretgate` launches the harness as `secretgate wrap -- <cmd>` as a second net on outbound traffic; a missing `secretgate` binary prints one warning and launches normally. `neurastream doctor` shows the redactor state, the number of known values (count only) and the proxy state.

`ledger.idle_not_live_min` is the idle time, in minutes, after which `agent-ledger --cap` stops counting a RUNNING or WAITING agent as using a provider slot. Such agents are listed on a `NOT LIVE` line; their session has been dead or stalled that long. Default 60.

`guards.protected` starts empty. Init and adapter install append the paths they own (package bins, notes, blockers, and, for the omp adapter, the pin dir and extension dir). Core does not hardcode those paths.

`guards.sub_max_calls_cap` bounds the per-spawn call budget: a `Call budget: <N>` line in a `task` brief (the task's own text, or the shared `context` of the same call; the task's own line wins) gives that run a hard stop at N calls — warning at N − (`guards.sub_max_calls` − `guards.sub_warn_calls`), floored at 1 — instead of the global warn 90 / stop 100. At the stop only plan Progress reads and edits pass, as at the global limit. The spawn is refused when N is outside 10..`guards.sub_max_calls_cap` or the task has no `name`: the budget is keyed by the task name in `<queue_state>/spawn-budgets.json` (next to `spawns.json`), and the ledger flags a still-running sub `OVER-BUDGET` past its own N. A task without the line keeps the global values.

`guards.plan_offer` is the case-insensitive regex a Main stop reply is matched against. A hit refuses the stop with "don't promise it — do it now, or write the plan and index it": offering the owner a plan for a found bug is not progress, the plan is (plan 20261028_0900, owner 2026-10-28: "I mean to plan bugs … how is one and two going to force you to plan them?"). A promise ("I will", "I'll") is refused the same way: Main does it now or files it. The omp adapter hands the guard the reply text Main stops with; the two-idle-stops release does not lift the block, and a reply without an offer stops as before. The value must be a non-empty string that compiles as a regex, validated like its neighbours.

`autonomy.*` is the owner's preference layer (src/core/autonomy.ts): how much Main may do without asking. `autonomy.tier` (default `opinionated`) is the tier in force whenever `<queue_state>/autonomy-tier` does not name one of the three; the owner moves the real setting any time with the whole chat message `tier strict|opinionated|full` (when `guards.chat_unlock` is on) or the phone page's tier buttons — never a tool call, the state dir is protected. `strict` caps Main's project-file changes at `autonomy.strict_edit_limit` per `guards.main_window_min` minutes and refuses `git push`, `glab mr merge` and `gh pr merge` (seen through `sh -c`/`sudo` like the ui-start rule) until the owner types the approve phrase `autonomy.go_phrase` (default `go push`): the whole trimmed message, case-insensitive with inner spaces collapsed — a bare `go` is an ordinary message. One landing, valid `autonomy.go_minutes` minutes, consumed by the first gated call. `opinionated` keeps `guards.main_edit_limit`. `full` drops the edit cap and accepts a `Priority skip: <plan> — Main: "<reason>"` line (reason ≥ 4 words) at the priority gate; the owner-quote proof still works there. Every tier keeps the owner-only moves owner-only: protected guard files, starting the phone page, notify secrets, the unlock and the tier file itself.

`review.mr_cache_minutes` (default `10`, `0` = no cache) bounds the spawn gate's open-MR cache: for `review.mr_cache_minutes` minutes after one repo's forge list, a spawn on a plan of that repo reuses `<queue_state>/mr-cache.json` instead of calling `glab`/`gh` again. A forge outage is never cached — the spawn gate degrades to a guard-log line and the next spawn retries, exactly like the MR sweep.

`review.agents` (default `["reviewer"]`) lists the agents a review spawn may run under: the reviewer-PASS gate exempts a spawn whose agent is on this list and whose brief carries the `Plan review: <plan>` line naming the plan. Everyone else needs the recorded PASS, and only a subagent's `PLAN REVIEW: PASS|FAIL` progress entry can record one (`<queue_state>/plan-reviews.json`; Main's plan edits never record). An EMPTY list turns only the `## Reuse` requirement off: no plan needs a `## Reuse` section; the reviewer PASS gate follows `review.plan` (P6) — any other value gates every plan, plans are no longer exempted by their filename stamp, the old cutover key is gone.

`review.plan` (default `true`) is the reviewer PASS gate (plan 20261028_1600 P6): `false` skips it entirely — every plan then spawns without a reviewer PASS — and an empty `review.agents` list no longer turns it off. Must be `true` or `false`.

`review.code` (default `false`) is the code review gate (plan 20261028_1600 P6): when `true`, a Main plan edit that ticks a phase (`- [ ] P6` → `- [x] P6`) is refused until the plan's `## Progress` holds a `- <date> <time> <name>: CODE REVIEW: PASS` entry naming that phase — recorded like a PLAN REVIEW verdict, only by the plan's named review spawn (`<queue_state>/plan-reviews.json`; Main's plan edits never record) — and that entry still sits after the phase's last implementer entry. The refusal names the phase and says to spawn a code reviewer or set `review.code: false`. Must be `true` or `false`.

`review.shell_allow` (default: `git show`, `git log`, `git diff`, `git blame`, `git rev-parse`, `git ls-files`, `git status`, `git merge-base`, `grep`, `cat`, `head`, `tail`, `wc`, `ls`, `jq`, `glab mr list/view/diff`, `gh pr list/view/diff`, `date`) is the allow list a review spawn's bash is judged against (plan 20261028_1600 P7): the command must be one line without `$(`, backticks, `<(`, `>(` or any `>` redirect (`2>`, `&>`, `>|` included; quoted text ignored the way the redirect parser does), every segment split on `|`, `&&`, `||`, `;`, `&` must start with one entry followed by a word boundary, and a segment may not carry an option that writes or executes — `--output`, `--pre`, `--ext-diff`, `--textconv`, `-O`, `--open-files-in-pager`, `--exec`, `-w`/`--web` on `gh`/`glab` segments only (they open a browser), and `-c` right after `git`. `eval` is denied outright for review spawns. `git fetch`, `sed`, `rg`, `git grep` and `find` are off the list on purpose — they write or run commands, and the reviewer's read tools cover their read uses. An empty list allows no shell at all.

`approval.since` (default `""`, off) is the plan approval hard gate (plan 20261029_1455 P3). While it is `""`, approval is off entirely: no page and no approval record is required (plan 20261031_1207 P5 — the reviewer agent replaced the hard gate). When it is set, a plan whose file stamp (`YYYYMMDD_HHMM`) is at or after `since` needs a page in Base: with no page, a spawn is refused until `neurastream pages publish <page.html> --plan <file>` runs. A plan with a page needs its approval record (the Approve button or `approve <stamp>` in chat) for its current text; a Progress-only edit keeps the record. Plans stamped before `since` keep the old behaviour: a plan with no page is not gated. A plan file with no stamp counts as after `since` once it is set. Must be `""` or a `YYYYMMDD_HHMM` stamp; anything else fails config load.

Doctor and `queue-check` fail when no `review.agents` entry is in `## Allowed` of `notes/subagents.md` (`neurastream agents allow <name>`), and warn for each entry that is not, since such an entry can never run a review spawn. An empty `review.agents` list is valid and silent: no review spawn can run, and only the `## Reuse` requirement is off — the reviewer PASS gate follows `review.plan` (P6).

`score.default_branch` has no default. It is config, not a core literal: set it here or pass `--branch`; with `score.default_repo` empty, `accept` / `check` require `--repo` and `--branch`.

`score.waste_weight` must be between 0 and 1. It scales each model's points-per-dollar ranking by its wasted-call fraction; the default 0 leaves the existing ranking unchanged.

`traces.actions` feeds `src/core/trace-actions.ts`. A tool call whose path arguments match a `secret_globs` glob is a secret read. A shell command naming a `net_tools` word reaches a host; it is allowed while the host matches `traces.allowed_hosts` (exact, or `*.suffix`), otherwise flagged — shaped as exfiltration when data flows out (a pipe into the tool, a body/upload option, a stdin redirect, a local scp source). Write targets outside every `actions.write_roots` root (empty falls back to `paths.work_roots`; both empty turn the scope check off) or matching a `deny_globs` glob are out of scope wherever they land. A command containing a `shell_patterns` substring feeds a shell from a pipe. All lists are data: core matches globs and words, it never hardcodes a tool, host or path.

`traces.bloat` feeds `src/core/trace-bloat.ts`. A call's prompt is what the provider read before it wrote: `usage.input + usage.cacheRead + usage.cacheWrite` of one assistant message. A run flags `prompt-bloat` when its first non-aggregated call opens over `bloat.first_call_max`, or when any non-aggregated call's prompt passes `bloat.ratio_of_limit` × its model's `bloat.context_limits` entry; a model without an entry is not limit-checked (the map is open: add your models). APIs listed in `bloat.aggregate_apis` (default `["cursor-agent"]`) report turn-level totals, not individual calls, so they are excluded from call sizes and the metrics largest-first-call value; the CLI labels them "usage aggregated by provider, per-call size unknown". `bloat.tool_group` names the group of a request's tools for the breakdown: the first capture of the regex on the tool name; a name that does not match groups as `builtin`.

`traces.efficiency` feeds `src/core/trace-efficiency.ts`, the waste counters behind `neurastream traces efficiency` and the board's waste columns. A call is wasted under the first rule that matches, at most once: `repeat-read` — a read-tool call with the same arguments JSON as an earlier one and no write-tool call between them, the `repeat_read_min`-th and later count; `repeat-fail` — a shell command repeated after an earlier result flagged it as an error, with no write-tool call between, every repeat counts; `failed-edit` — a write-tool call whose result is an error; `guard-repeat` — a toolResult text starting with a `guard_prefixes` entry whose first line repeats an earlier block's first line, every repeat counts; `poll` — shell commands matching `poll_pattern` in an unbroken run of consecutive calls, every one after the first counts. The read and fail chains reset on any write-tool call (a rerun after a change is not a blind repeat); the read tool names, shell tool names and write tool names come from the `guards` section.

`traces.briefs` feeds `src/core/trace-briefs.ts`, the brief-quality report behind `neurastream traces briefs [--since N m|h|d] [--json] [--report]` (default window 30d). Each spawn a Main run made is one row: a `task` call whose result says `Spawned` (a refused spawn sent nothing). The row carries the brief's features: `chars`, `fileLines` (a `path:line` location), `verify`, `phase` and `plan` (the three patterns above), `budget` (a `Call budget:` line) and `acceptance` (non-empty lines under Acceptance headings). Each row joins to its agent's waste from `traces.efficiency` and to whether a score event of type accept, validate or diagnose named the agent. The report compares briefs with and without each feature and buckets them by `char_buckets`; a mean shows only with at least `min_n` rows on that side. `--json` carries these features and lengths, never the brief text.

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
- `guards.main_warn_calls` greater than `guards.main_max_calls` (only when `guards.main_max_calls` is above 0; 0 = off)
- `guards.sub_max_calls_cap` below `guards.sub_max_calls`
- `autonomy.tier` that is not `strict`, `opinionated` or `full`
- `autonomy.strict_edit_limit` or `autonomy.go_minutes` that is not an integer >= 1
- `autonomy.go_phrase` that is not a non-empty string
- a `paths.*` value that is not a string
- `metrics.report_days` below 1, or a `metrics.correction_patterns` entry that does not compile as a case-insensitive regex
- a `metrics.product_cmds` that is not `{<repo path>: {<name>: non-empty shell command}}`
- `ui.port` outside 1..65535
- `pages.keep_days` below 1, or not an integer
- `approval.since` that is not `""` or a `YYYYMMDD_HHMM` stamp
- `knowledge.roots` that is not a non-empty list of non-empty paths, or `knowledge.max_age_s` below 1 or not an integer
- a `brief.repo_rules` entry whose `match`, `require`, `first` or `unless` does not compile as a case-insensitive regex, or whose `message` is empty
- `secrets.proxy` that is not `none` or `secretgate`, a `secrets.known_value_files` entry that is not a non-empty path, or a `secrets.extra_patterns` entry without a non-empty `type` and a `regex` that compiles
- `write_check.applies_to` that is not `sub` or `all`, `write_check.timeout_ms` that is not above 0, a `write_check.suppress` that is empty or does not compile, a `write_check.defer_rules` that is not a list of non-empty rule names, or a `write_check.linters` entry whose `ext` is not a list of dotted extensions, whose `argv` lacks `{file}`, or whose `pattern` lacks a `(?<rule>` group or does not compile, or whose `only_with_config`, if present, is not a list of non-empty file names
- YAML that does not parse

Missing keys are filled from the defaults above. A present key replaces the default. Objects merge one level (`score.penalties` merges per kind; an omitted kind keeps the default). Arrays replace.

## write_check

Write-time lint (`src/core/write-check.ts`, applied by the omp adapter). With `enabled: true`, each edit to a file that a linter entry covers is linted before and after the change. A `(rule, message)` pair whose count grows, or a new line matching `suppress`, refuses the edit: the file is restored and the agent gets the reason. Findings that were already there never block. A missing linter, a crash or a timeout allows the edit and logs a note. `applies_to: sub` covers subagents only; `all` covers Main too. Arrays replace, so a user `linters` list replaces the two shipped entries.

A pattern may name a `(?<message>` group next to `rule`; findings are then compared by `(rule, message)` multiset, so the refusal names each new finding's own line and a rule's old debt can neither be blamed for a refusal nor hide the new finding behind one merged count (INCIDENT I-20261028-150, I-20261028-151). A pattern without a `message` group keeps the older per-rule counting.

The shipped `suppress` regex only counts a marked word: a comment marker (`#`, `//` or `/*`) must sit before it, so a test fixture or string that merely contains `noqa` is not a suppression (INCIDENT I-20261028-113). The shipped linters set `only_with_config`: the linter runs only when one of those files is found walking up to the git top, so the repo's own lint config governs instead of the shipped argv overriding it, and a directory with no config is not linted at all (INCIDENT I-20261028-112).

A new finding whose rule is in `defer_rules` does not refuse the edit: it is allowed with a logged note, and the omp adapter re-lints the file at the turn's end — one steer lists the deferred findings still present, a file fixed or deleted later in the turn steers nothing (INCIDENT I-20261028-166, so a declare-then-use refactor works with plain edits). A missing or crashed linter steers nothing too. `defer_rules: []` turns the deferral off.

## traces.owned_repos

Names of the owner's products, spelled the way the repos and worktree dirs spell them. A
subagent run that reads files of one of these products outside its own plan's repo — installed
copies under `node_modules` and global installs included, so `@gate-forge/core/...` counts as
gateforge — while its final report says `Findings: none` becomes an `unreported-finding`
incident (source `traces`) and records an `agent-score penalty` event (kind
`unreported-finding`, weight `score.penalties.unreported-finding`) for that agent on the plan.
Intended list: gateforge, neurastream, oi-agent, clanky, PM, CP. The template ships `[]`; an
empty list turns the rule off.
