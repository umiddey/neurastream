# Results: $ per finished feature and before/after per release, on the phone page
Worktree: /home/ukd/Work/neurastream-results
Branch: feat/results
Summary: Your phone page shows what each finished feature cost and whether each release made things faster or slower.

## Goal
- Owner (2026-10-25 ~21:35): "these are the type of things that I want to calculate … maybe this can go to the UI … we want to be able to track it … when we release a feature, whether it becomes more efficient, less efficient, takes more space, less space, gets more work done". Then (~21:45): "the x-axis can be the time or it can be the feature itself … the y-axis can be the metric … and it can be for multiple"; built into neurastream, not a separate tool (Main's recommendation, owner asked "which is better").
- Done means: (1) `neurastream metrics features` prints $ per finished feature, a feature = a plan plus every later plan whose Goal names its file stem, finished = every plan in the chain closed; (2) `neurastream metrics releases` prints, per release, the metrics for the N days before vs after it; (3) the phone page has a "Results" tab with one inline-SVG line chart: y = a chosen metric, x = time or feature/release, one line per series (product repos vs neurastream), plus the table under it.

## Forbidden
- Host-neutral (owner 2026-10-26): logic and types in src/core name no harness (omp/opencode/codex/claude/cursor); harness-specific reads/writes live under src/adapters/<harness>/ (docs/adapter.md).
- Never push, merge, tag or publish; commit on feat/results and report.
- Never touch the live setup (`~/.omp/agent`, `~/.local/state`, `~/.local/bin`, `~/.bun`, the user config dir); tests use a temp HOME and fixtures.
- No chart library and no new dependency: the chart is hand-written inline SVG under the page's existing CSP (no inline script beyond the page's nonce script).
- No harness or provider name in `src/core/`.
- Never change how M1–M5 or the ranking are computed.

## Blockers
- no-push
- blockers/results-scope.sh
- deny-path /home/ukd/.omp/agent/** /home/ukd/.bun/** /home/ukd/.local/state/** /home/ukd/.local/bin/**

## Phases
- [ ] P1 Message time. `RunMessage` (src/core/adapter.ts:5-9) gains `ts: number | null` (unix seconds); the omp mapper sets it from the line's `timestamp` (src/adapters/omp/sessions.ts:111-118 already parses it; push at :168-172). Red test first in tests/results.test.ts (a fixture session with two messages an hour apart → two ts values). — difficulty: 1 — verify: `cd /home/ukd/Work/neurastream-results && bun test tests/results.test.ts && bun run typecheck`
- [ ] P2 Feature ledger in a new `src/core/results.ts`. Plans = every `*.md` in `docs/plans/` and `docs/plans/archive/**` of each repo in `cfg.paths.work_roots`/main checkouts the queue already knows (reuse the queue's plan discovery; no new path config). Chain: plan B joins A's chain when B's Goal text contains A's file stem (`YYYYMMDD_HHMM_name`). Closed = `Status: complete|cancelled` or archived; close time = the newest dated Progress entry (CEST/CET suffix or none = local time → UTC). Cost: Main messages are bucketed per hour; each hour's Main cost splits evenly over the plan paths named in that hour's messages (no path → "overhead"); a sub run's cost goes to the plan path in its first user message. Output of `neurastream metrics features [--days N] [--json]`: one row per finished chain (stem, kind product|neurastream by repo, plans, fix plans, $ total, $ first plan, closed at) and a summary per kind: finished, per day, $/feature, first-pass $/feature, overhead %, open chains with sunk $. Fixture tests: a 2-plan chain closes only when the fix closes; an hour naming 2 plans splits 50/50; an hour naming none is overhead. — difficulty: 3 — verify: `cd /home/ukd/Work/neurastream-results && bun test tests/results.test.ts`
- [ ] P3 Releases. A release = a `v*` tag of the neurastream repo (git tag date), or a product merge recorded by `metrics ci` (src/cli/metrics.ts:36 `recordCi`, already run after every merge). New optional config `metrics.product_cmds: {<repo path>: {<name>: "<shell cmd printing one number>"}}` (src/core/config.ts with validation, templates/config.yml, docs/config.md); `recordCi` runs that repo's commands once and appends `{type:"product", repo, name, value, ts}` to metrics.jsonl (example: `du -sm frontend/dist | cut -f1`). `neurastream metrics releases [--days N] [--json]`: per release, N days (default 7) before vs after: $/feature, features/day, Main calls per feature, tokens per call, fix plans per feature, and each product number (last value before vs first after); "measuring" until N days pass. Tests: a tag 10 days old shows both sides; 2 days old shows measuring; a product value is picked per repo. — difficulty: 3 — verify: `cd /home/ukd/Work/neurastream-results && bun test tests/results.test.ts tests/metrics.test.ts`
- [ ] P4 Results tab (src/core/owner-ui.ts: tabs at :441, tab pick at :592). Pills: Now, Queue, Agents, Spend, Results. Controls are plain links (`?tab=results&y=<metric>&x=time|feature`), so they work through the page's existing fetch/pushState swap with no new script. Chart: inline SVG sized for 390 px wide, y axis = the chosen metric ($/feature default; features/day, calls/feature, tok/call, fix rate, each product number), x = day (time) or release/feature in order (feature), one polyline per series (product, neurastream; one per product number), points carry `<title>` tooltips, release markers as dashed verticals on the time axis, theme colors via the page's CSS variables. The table under it = `metrics releases` rows with ▲/▼ and green/red for better/worse. Data comes from P2/P3 functions, cached like the Spend tab. scripts/ui-preview.ts gets a `--tab results` fixture (2 series, 6 releases). Tests: the tab renders for each x mode; an unknown `y` falls back to $/feature; an empty ledger shows "No finished features yet". — difficulty: 3 — verify: `cd /home/ukd/Work/neurastream-results && bun test tests/owner-ui.test.ts && bun scripts/ui-preview.ts /tmp/results.html --tab results`
- [ ] P5 Docs and full run: README `metrics features` / `metrics releases` / Results tab paragraph, `neurastream help` lines (src/core/help.ts), CHANGELOG `## Unreleased` → Added. Full suite + typecheck green. — difficulty: 1 — verify: `cd /home/ukd/Work/neurastream-results && /home/ukd/Work/heavy-run.sh agent "results full" -- sh -c 'bun run typecheck && bun test'`
- [ ] P6 Main: browser check of the Results preview at 390×844 (both x modes, switch y twice, no full reload), run `neurastream metrics features` on the live data and compare with Main's 2026-10-25 hand count (product $15.2 → $17.6, neurastream $5.7 → $4.2 per feature), merge, release by tag, install after the owner's unlock, `neurastream doctor` exit 0. — difficulty: 1 — verify: `git -C /home/ukd/projects/neurastream merge-base --is-ancestor feat/results origin/main && neurastream doctor`

Read /home/ukd/projects/opus-implementer-method.md first. Call budget: stop and report within ~100 calls. Suite runs: `/home/ukd/Work/heavy-run.sh <agent> "<label>" -- bun test`.

## Done check
`cd /home/ukd/Work/neurastream-results && bun test tests/results.test.ts tests/owner-ui.test.ts && git merge-base --is-ancestor HEAD origin/main`

## Code read by Main
- `src/core/adapter.ts`
- `src/adapters/omp/sessions.ts`
- `src/core/metrics.ts`
- `src/cli/metrics.ts`
- `src/core/owner-ui.ts`

## Progress
Status: open
- 2026-10-25 21:50 Main: plan written from the owner's request; worktree to be made from origin/main after v0.2.27 lands. Findings: none

## Background
- Main's hand count on 2026-10-25 (Python over session JSONL, kernel lost): NS avg window product 4 finished, $15.2/feature, 1 fix plan; last 36 h product 6, $17.6; neurastream 19 → 29 finished, $5.7 → $4.2. Pre-NS overhead 48% of Main $ (no plan named), after 0–2%. 26 open chains held $268. P6 compares against these.
- Caveat to keep visible on the tab: fixes done inside the same plan are not split out; plans that do not cite an earlier stem are not linked.
