# Operations: Rollover, Rate Limits, Watch, WIP, Secrets, and Recall

## Session rollover

When Main's session file exceeds `rollover.max_session_mb` (default 5 MB) or the installed `neurastream` version in `package.json` differs from the running plugin:

1. At turn end, Main is asked once to write a handoff note to `<queue_state>/mains/<id>/rollover/<session-id>.md`.
2. While a rollover is pending, new `task` spawns are refused and the normal stop guard is lifted so running jobs can finish.
3. Once the note is fresh (< 1 hour old) and no own jobs are running, `omp` writes `relaunch.json` and exits; `neurastream main` automatically starts a fresh session seeded with the handoff note, `main-start` state (including owner holds and unanswered owner messages), and any unsent editor draft.
4. If `omp` does not exit within `rollover.exit_grace_s` (default 20s), the adapter falls back to an in-process session switch.
5. Manual trigger: `/main-rollover <message>`. Disable via `rollover.enabled: false`.

## Provider rate limits, reset times, and pick order

- **Rate-limit recovery**: When a Main turn ends on an error matching `guards.rate_limit.patterns` (`429`, `rate_limit`, `rate limit`, `overloaded`, `529`), the stop guard opens one episode and posts a notice to configured chat channels.
  - If the error includes a reset time (`retry-after-ms`, `retry-after`, or timestamp), `neurastream` waits until reset + `slack_s` (default 15s).
  - Otherwise, a detached niced child runs `guards.rate_limit.probe_cmd` every `probe_interval_s` (300s) up to `max_probes` (288 = 24h).
  - When capacity returns, Main receives a resume turn and chat channels receive a back-online post; an owner message cancels the wait.
- **Reset time annotation**: Timestamps matching `quota.reset_pattern` are annotated with local time (using `quota.reset_tz` when no zone is explicit).
- **Live provider state & pick order**: Out-until timestamps from `quota-reset`, task results, rate limits, and harness provider checks are stored in `<queue_state>/provider-out.jsonl`. When `ledger.prefer` lists preferred agents, spawn gates refuse lower-ranked picks while a higher pick's provider is free unless the brief carries `Pick note: <why>`, and refuse briefs claiming a free provider is rate-limited.

## Chat notifications (`neurastream notify`)

At Main's terminal hand-back, deterministic adapter code posts Main's final reply to configured Discord and/or Slack webhooks (5s timeout per attempt, serialized, Discord 429 retry, automatic chunking at 2000/3000 chars, scrubbed by the secret redactor).

Webhook URLs never go in `config.yml`—only paths to `chmod 600` secret files:

```yaml
notify:
  discord_webhook_file: "~/.config/neurastream/secrets/discord-webhook"
  slack_webhook_file: "~/.config/neurastream/secrets/slack-webhook"
  prefix: ""
```

Test with `neurastream notify test`. No agent (Main included) can read configured secret files or list their directory, even while unlocked.

**"Needs you" pings**: Posts `🔔 Needs you — <plan>: <question>` once per new `WAITING on owner:` hold (with the workspace link when enabled) and `🔓 Main needs an unlock to continue (<file>)` at most once per 30 minutes.

## Continuous feedback (`neurastream watch`)

```sh
neurastream watch          # run one pass manually
neurastream watch on|off   # install/remove systemd user timer or macOS LaunchAgent
neurastream heartbeat <name> [--fail "<why>"]
```

Every `watch.interval_min` (default 15), `watch` checks:
1. Failed or stale job heartbeats (`<queue_state>/heartbeats/<name>.json`, checked against `watch.expect`).
2. Failed systemd user units matching `watch.units`.
3. CI status for active-plan repos (`ci-red-main`, `ci-red-mr` past `watch.ci_red_hours`, M3 records for newly merged MRs, `ci-flaky` metrics).
4. Gated incident detectors and per-release verdicts.

Each new problem opens one incident (posting at most `watch.max_posts_per_run`, default 3, plus a `+N more` line) and auto-closes on recovery. `main-start` opens a `watch:not-running` incident if the watcher itself stops beating for 3 intervals.

## Machine health and pressure

- `machine-guard` checks load, available memory (`machine.avail_min_mb`), disk (`machine.disk_min_gb`), and `/tmp` usage (`machine.tmp_max_mb`).
- `heavy-run` enforces a single-slot lock for heavy test runs (`paths.heavy_lock`).
- **Pressure alerts (`neurastream pressure`)**: On Linux, the `omp` adapter samples `/proc/pressure/memory`, `/proc/pressure/cpu`, and `/proc/meminfo` every `machine.pressure.sample_sec` (10s). Sustained RED (`red_after_sec`, default 30s) sends a tell-only alert to Main naming any `heavy-run` lock holder; sustained calm (`green_after_sec`, default 120s) sends a GREEN follow-up. State lives in `<queue_state>/pressure.json`.

## Saving unsaved work (`neurastream wip`)

```sh
neurastream wip add <path>
neurastream wip on [--backup-url <url>]
neurastream wip restore [<worktree>] [--pick N] [--worktree]
neurastream wip off
```

- Hourly snapshots commit dirty worktrees to hidden `refs/wip/<key>/<stamp>` refs without touching the working tree, index, `HEAD`, or branches.
- Nightly backups push those refs to `wip.backup_url` **only** after verifying repository visibility is strictly `private` (via `gh`, `glab`, or `wip.private_check`). Pre-push hooks are never bypassed unless explicitly listed in `wip.backup_hook_off`.

## Secrets redaction

`src/core/secret-redact.ts` redacts secrets by **content** across every tool result (Main and subagents), every outbound notification, and `neurastream redact < file`:

- **Built-in shapes**: private keys, npm/GitHub/GitLab/AWS/Google/Slack/Stripe/OpenAI/Anthropic/OpenRouter tokens, Discord webhooks, JWTs, URL credentials, `_authToken`/`_password`, and generic `password|secret|token|api_key = <8+ chars>` assignments.
- **Exact machine values**: Secret-named env vars, `~/.npmrc`, files in `secrets.known_value_files`, top-level `.env*` files under `paths.work_roots`, and notify webhook files (cached by mtime/size).
- **Custom patterns**: `secrets.extra_patterns: [{ type, regex }]`.
- **Wire proxy**: Set `secrets.proxy: secretgate` to launch `omp` wrapped in `secretgate wrap -- omp` (falls back with a warning if `secretgate` is not on `PATH`).

## Recall (`neurastream recall`)

Append-only, secret-redacted log of owner messages and Main answers under `<queue_state>/recall/` (`owner-log.jsonl` + `owner-log.backfill.jsonl`, mode `0600`):

```sh
neurastream recall <words>... [--since 7d|12h|YYYY-MM-DD] [--limit N] [--json]
neurastream recall --show <id|a..b>
neurastream recall backfill [--since ...]
```

Set `recall.topics_model` to enable background LLM topic segmentation (every `recall.topics_every` Main entries, default 30, and at session shutdown; manual run via `neurastream recall topics [--close]`).
