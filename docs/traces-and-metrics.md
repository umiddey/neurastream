# Scoring, Trace Audits, Metrics, Incidents, and Rule Tuning

## Scoring and ledger

- **`agent-ledger [--hours N] [--cap]`**: Reports tokens, prefill `tok/call`, cost, state, and exit reason per run. `--cap` refuses spawns when a provider already runs `ledger.max_running_per_provider` (default 2), when a run is `OVER-BUDGET` (unless `--incident <id>`), or when a priority plan is unstaffed (unless `--priority`).
- **`agent-score`**:
  - `agent-score accept` awards points only for commits Main accepted, weighted by phase `difficulty: N`, ranked per dollar and per hour.
  - `agent-score validate <Agent> --plan <plan.md> --phase <P> --evidence <report.md> --section "<heading>"` scores no-commit validation phases backed by a ticked phase and a matching `heavy-run` log record.
  - `agent-score gate` recommends an agent respecting `ledger.prefer` when set, otherwise by score.

## Trace audits (`neurastream traces`)

All trace commands read session files read-only and support `<runId | --since <window>> [--json]`:

- **`traces efficiency`**: Counts wasted tool calls (repeated file reads, repeated failed commands, failed edits, repeated guard blocks, idle polling). `score.waste_weight` (default `0`) optionally scales score rankings by waste.
- **`traces briefs [--report]`**: Extracts structural features of spawn briefs (length, `file:line`, verify command, phase id, plan path, call budget, acceptance lines) alongside waste and accept outcomes without printing brief text.
- **`traces actions`**: Flags secret-path reads (`traces.actions.secret_globs`), network commands (`net_tools`) to unknown hosts, shell pipes (`shell_patterns`), and writes outside `write_roots` or matching `deny_globs`. High-severity hits also open incidents.
- **`traces claims`**: Cross-checks claims in a run's final assistant message (test counts, exit codes, commit SHAs, `heavy-run` labels, changed paths) against that run's own tool activity, flagging unmatched items as `claim-unbacked`.
- **`traces bloat`**: Reports per-call prefill tokens (`input + cacheRead + cacheWrite`) and flags runs exceeding `traces.bloat.first_call_max` (default 150,000) or `ratio_of_limit` (default 0.8) × `context_limits[model]`. Matches `~/.omp/logs/http-400-requests` dumps to identify prompt breakdown (system, messages, tool groups).
- **Provider honesty (`src/core/trace-provider.ts`)**: Checks traces for `model-swap`, `odd-response-id`, `unoffered-tool`, `phantom-output`, and `cost-mismatch` (> ±20% vs `traces.provider.prices`). Summarized in `neurastream metrics report`. Sampled `id_patterns` you can paste into `~/.config/neurastream/config.yml`:
  ```yaml
  traces:
    provider:
      id_patterns:
        anthropic: '^msg_[A-Za-z0-9]+$'
        zai: '^[0-9]{14}[0-9a-f]+$'
        openai-codex: '^resp_[0-9a-f]+$'
        openrouter: '^gen-[0-9]+-[A-Za-z0-9]+$'
      prices: {}
      allow_tools: []
  ```

## Episode labels and `diff-check`

- **`neurastream labels episodes [--since 30d] [--json]`**: Joins score events, runs, and spawn briefs.
- **`neurastream labels update --repo <dir>`**: Labels episodes and flips accepted work that a later commit reverted or broke (`labels.flip_weight`, default `1.0`).
- **`neurastream labels assign <episode> --party plan|implementer|both --why "<text>"`**: Records a root-cause party override.
- **`neurastream diff-check [--staged | <rev>]`**: Flags added removal comments (`labels.removal_comment_patterns`) and added lines in removal commits (`labels.removal_subjects`). Plan-guard runs this automatically on subagent `git commit`.

## Self-metrics (`neurastream metrics`)

- **`metrics report [--days N]`**: Compares the last `metrics.report_days` (default 7) against the prior window, writes `<paths.notes>/metrics.md`, and marks the worst regression `◀ worst`:
  - **M1**: Cost per merge (total, worker-only, Main-only)
  - **M2**: Idle calls from runs with no accept/diagnose/validate
  - **M3**: Mean CI tries per merged MR (`metrics.ci_pipelines_cmd`)
  - **M4**: Owner corrections (`metrics.correction_patterns`) and Main questions
  - **M5**: Guard blocks, false alarms, and top 3 block reasons
  - **M6**: Incidents opened / planned / dismissed / fixed and median time to fix
- **`metrics features [--days N] [--json]`**: Cost per finished feature chain.
- **`metrics releases [--days N] [--json]`**: Before/after stats per `v*` tag (`$/feature`, `features/day`, `main calls/feature`, `tokens/call`, `fix plans/feature`, and configured `metrics.product_cmds`).
- Recording helpers: `metrics ci <repo-dir> <mr-id>`, `metrics false-alarm <log-ts> --why "<text>"`, `metrics rule "<text>" --approved|--rejected`.

## Self-improvement (`neurastream incident`) and rule tuning (`neurastream rules`)

Incidents are stored in `<queue_state>/incidents.jsonl` and fed by real-time detectors (`D1` ledger contradiction, `D2` tool crash, `D3` block loop, `D4` owner correction, `D6`/`D7` trace actions & unreported findings, `D8` block-then-bypass), daily/weekly metric regressions, `neurastream watch`, `neurastream incident add`, and plan `Findings:` lines.

- While an incident is open, every Main prompt lists it, non-fix spawns are refused, and Main cannot stop (including stops that only offer to write a plan, matched by `guards.plan_offer`).
- Close an incident via:
  - `neurastream incident plan <id> <plan.md>` (indexed plan citing `INCIDENT <id>` with a fail-before test phase),
  - `neurastream incident dismiss <id> --why "<text>"` (finding incidents require `--owner "<quote>"` from a last-24h owner message or an owner tap on the workspace UI after `incident propose <id> --why "<file:line ...>"`), or
  - `queue-close` automatically recording `fixed` when a plan citing the incident closes.
- **Self-pruning (`neurastream rules`, `tuning.*`)**: Scores detector kinds and (when `tuning.guards: true`) guard rule IDs by useful share. Noisy rules with low usefulness step down automatically (`block` → `tell` → `off`) with probation windows and an undo-rate brake (`bar`).
