# 20261120_1720_readme_split_and_outage_memo_fix
**Task**: Refactor README.md into a concise landing page + 4 focused docs/, and fix the publish.yml CI failure in `src/core/team-client.ts` (`downUntil` outage memo collision across servers with the same team name)
**Status**: COMPLETE

## WHAT
- Rewrote `README.md` from 544 lines (80.4 KB) down to a concise, accurate landing page (~145 lines) with fixed Markdown tables, a 5-minute quickstart, and clean feature tables ✓
- Extracted detailed reference specs into `docs/guards.md`, `docs/workspace.md`, `docs/operations.md`, and `docs/traces-and-metrics.md` (verified against `src/cli/dispatch.ts`, `templates/config.yml`, and `src/core/*`) ✓
- Fixed `src/core/team-client.ts` `askRaw()` outage memo key (`${team.name}\0${team.server}` instead of `team.name` alone) so an unreachable team server on one port does not poison a different server/port with the same team name for 60s ✓
- Hardened `tests/owner-ui.test.ts` recorder port read (loop until `\n` + `try/finally` `proc.kill()`) ✓
- Released and tagged `v0.3.20` (replacing unpublished `v0.3.19` which failed `publish.yml` twice on the `downUntil` collision) ✓

## HOW
- Inspected `gh run view 44770781739 --log-failed` across both attempts: `tests/owner-ui.test.ts:2151` consistently received `[]` because `downUntil` in `src/core/team-client.ts` memoized `"acme"` globally by team name only, colliding with earlier `"acme"` outage tests in the same Bun process.
- Keyed `downUntil` by `${team.name}\0${team.server}` in `askRaw()`.
- Verified with `bun run typecheck`, `bun run lint`, and `bun test tests/team-client.test.ts tests/owner-ui.test.ts` (`160 pass, 0 fail`).

## WHY
- `README.md` had grown into an 80 KB monolithic spec dump with a broken overview table at line 39, internal plan/incident IDs, and 400-word walls of text.
- `publish.yml` for `v0.3.19` failed twice in a row on the exact same line (`tests/owner-ui.test.ts:2151`), proving a real process-level outage-memo bug rather than a transient flake.

## FILES MODIFIED
- `README.md`: rewritten into concise landing page linking to `docs/`
- `docs/guards.md`: extracted queue, blockers, review/read gates, autonomy, planner mode, multi-Main, project rules
- `docs/workspace.md`: extracted owner phone UI, static pages, plan approval, Base tab
- `docs/operations.md`: extracted rollover, rate limits, notifications, watch, machine pressure, WIP, secrets, recall
- `docs/traces-and-metrics.md`: extracted scoring, trace audits, provider honesty, prompt bloat, metrics, incidents, rule tuning
- `src/core/team-client.ts`: keyed `downUntil` outage memo by `${team.name}\0${team.server}`
- `tests/owner-ui.test.ts`: read full port line until `\n` and kill recorder in `finally`
- `package.json`, `CHANGELOG.md`: bumped to `0.3.20`

## VERIFICATION
- `bun run typecheck`: exit 0
- `bun run lint`: exit 0 (`Found 0 warnings and 0 errors` on 322 files)
- `bun test tests/team-client.test.ts tests/owner-ui.test.ts`: exit 0 (`160 pass, 0 fail, 742 expect() calls`)

## NEXT SESSION
- Confirm `v0.3.20` GitHub Actions `publish` workflow completes and `npm view neurastream version` reports `0.3.20`.

## REFERENCES
- Failed publish run: GitHub Actions run `44770781739`
- Root cause: `src/core/team-client.ts` (`askRaw` / `downUntil`)
