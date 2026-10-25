# Traces 6/7: brief quality learned from traces
Worktree: /home/ukd/Work/neurastream-traces-briefs
Branch: feat/traces-briefs

## Goal
- Owner (2026-10-24). Learn which brief shapes waste agent calls: join each spawn brief with that run's waste counters (traces_05) and its accept result, and turn the strongest patterns into `brief-lint` warnings.
- Order (owner, 2026-10-24 23:02Z): "the data labelling plan series gets first prio" — this traces series (04 → 05 → 06 → 07) runs before every other plan. The old line "start only after the PM suite plans" is void. 06 starts once traces_05 P1+P2 are merged to main (it uses TraceEvent.callId and runEfficiency); Main creates the worktree from origin/main then.
- Done = `neurastream traces briefs [--since 30d] [--json]` lists per spawned subagent run its brief features, waste % and accepted y/n; `--report` prints grouped means per feature (n ≥ 5 per side); at most 2 Main-picked patterns become config-switchable `brief-lint` warnings. Released by Main.

## Forbidden
- Read /home/ukd/projects/opus-implementer-method.md first and work by it. Read the repo AGENTS.md.
- Work only in /home/ukd/Work/neurastream-traces-briefs on feat/traces-briefs. Never push, merge, tag or publish; commit files by name (never `git add -A`/`.`), never `--no-verify`.
- Never change the package.json version or CHANGELOG release headings; add lines under `## Unreleased`.
- Never read, copy or commit secrets (gateforge config, `*.env*`, `*keys*.txt`, `mcp.json`, keyrings). Briefs and trace text may hold secrets: evidence goes through maskEvidence (src/core/trace-claims.ts:31), at most 160 chars; --json carries brief features and lengths, never the brief text. Fixtures are small synthetic JSONL files under tests/fixtures/traces/.
- Never touch the live setup (~/.omp/agent, ~/.local/bin, ~/.local/state, ~/.bun, the owner's config dir) except READ-ONLY reads of session files and the score events file for the smoke. Tests use a sandbox HOME (/tmp/neurastream-home-*).
- No harness or provider names in src/core/ (AGENTS.md architecture rule; blockers/traces-core-clean.sh enforces it). Finding spawn calls in a Main session (tool name, result text shape) lives only in src/adapters/omp/. Feature regexes and thresholds come from config.
- P3 implements exactly the patterns Main writes into the plan; no others.
- Tests: no Bun.sleep/setTimeout. Every test run goes through `/home/ukd/Work/heavy-run.sh agent "<label>" -- <cmd>`.
- Stop and report within ~100 calls: write a Progress entry with the exact resume point before call 90.

## Blockers
- no-push
- deny-path /home/ukd/.omp/agent/** /home/ukd/.bun/** /home/ukd/.local/state/** /home/ukd/.local/bin/**
- deny-command --no-verify git\s+add\s+(-A|--all|\.)(\s|$) git\s+push\b git\s+merge\b git\s+tag\b npm\s+publish reset\s+--hard
- blockers/traces-core-clean.sh

## Phases
- [ ] P1 Join. Adapter src/adapters/omp/traces.ts, next to subagentTraces (src/adapters/omp/traces.ts:194): spawnBriefs(root, mainRunId) → {agent, brief, ts}[] — every spawn toolCall in the Main run whose paired result (by callId) says the agent was spawned; brief = the call's shared context + that task's own text; a refused spawn (no "Spawned agent" result) is skipped, a retried spawn keeps only the successful call. Core src/core/trace-briefs.ts: briefFeatures(brief, rules) → {chars, fileLines (names a path:line), verify (names a verify/test command), budget (briefBudget, src/core/guards.ts:168, non-null), acceptance (count of lines under an Acceptance heading), phase (names P<n>), plan (names a docs/plans/*.md file)}; briefRows(briefs, traces, scoreEvents, rules) joins runEfficiency (traces_05) of traces.events(agent) and accepted = any accept/validate/diagnose score event (readEvents, src/core/agent-score.ts:31) for that agent. CLI `neurastream traces briefs [--since 30d] [--json]` in src/cli/traces.ts (same style as claims/actions, runTraces src/cli/traces.ts:63). Config traces.briefs.{verify_pattern, phase_pattern, plan_pattern} with defaults in templates/config.yml + docs/config.md, validated in check(). Red tests first in tests/trace-briefs.test.ts: a fixture Main session with one refused + one successful spawn of the same agent (one row), two agents (two rows), each feature true/false, an agent with no trace (waste "-") — difficulty: 3 — verify: `cd /home/ukd/Work/neurastream-traces-briefs && /home/ukd/Work/heavy-run.sh agent "briefs p1" -- sh -c 'bun test tests/trace-briefs.test.ts && bun run typecheck'`
- [ ] P2 Report. `neurastream traces briefs --report [--since 30d]`: per boolean feature, mean waste % and accept rate with vs without (with n per side); chars in buckets from config traces.briefs.char_buckets (default [1500, 4000]); a side with n < traces.briefs.min_n (default 5) prints "n too small" instead of a mean. Plain grouped means, no statistics library. Tests: fixture rows give exact expected means; the n < 5 rule — difficulty: 3 — verify: `cd /home/ukd/Work/neurastream-traces-briefs && /home/ukd/Work/heavy-run.sh agent "briefs p2" -- sh -c 'bun test tests/trace-briefs.test.ts && bun run typecheck'`
- [ ] P3 Main runs the report read-only over 30 days, writes at most 2 patterns into this phase line (or "none strong enough" and P3 ends with docs only). The implementer adds each as a brief-lint warning in lint() (src/core/brief-lint.ts:37), switchable by config brief.learned_warnings (default on), with a red/green test each. README + CHANGELOG Unreleased/Added. Full suite green — difficulty: 2 — verify: `cd /home/ukd/Work/neurastream-traces-briefs && /home/ukd/Work/heavy-run.sh agent "briefs full" -- sh -c 'bun test && bun run typecheck'`
- [ ] P4 Main: review, merge to main, release by tag under the owner's unlock, install, `neurastream doctor` exit 0 — difficulty: 1 — verify: `neurastream doctor`

## Done check
`cd /home/ukd/Work/neurastream-traces-briefs && bash /home/ukd/projects/neurastream/docs/plans/blockers/traces-core-clean.sh && bun run typecheck && git fetch -q origin && git merge-base --is-ancestor HEAD origin/main`

## Code read by Main
- `src/adapters/omp/traces.ts` (parseTraceFile, ompTraceRuns, ompTraceSource, subagentTraces: depth-2 runs under a Main session dir)
- `src/cli/traces.ts` (TRACES_USAGE, runTraces dispatch, --since parse, sessions root)
- `src/core/brief-lint.ts` (lint: errs/warns, warn_chars rule; briefLint lints plan files)
- `src/core/guards.ts` (briefBudget)
- `src/core/agent-score.ts` (readEvents; accept/validate/diagnose events carry agent)
- `src/core/trace-claims.ts` (maskEvidence)
- `src/core/adapter.ts` (TraceEvent, TraceSource, SpawnEvent)
- Live Main session 2026-10-25T06-02-07 (read-only jq): spawn toolCall name "task", arguments {context, i, tasks[{name, agent, task}]}; the successful result text starts "Spawned agent" plus the backticked name; a refused spawn's result is a main-guard refusal; the subagent's session is the spawn name + .jsonl inside the Main session dir.

## Progress
Status: open
Waits on: /home/ukd/projects/neurastream/docs/plans/20261024_0304_traces_05_agent_efficiency.md
- 2026-10-25 09:50 Main: plan rewritten to the template (code read, call budget, difficulty and verify per phase). The owner's 2026-10-24 23:02Z order puts this series first; the old "start only after the PM suite plans" line is void. Starts after traces_05 P1+P2 merge; worktree is created then. Findings: none
- 2026-10-24 02:2x (Main): plan written from owner's request. Gate missing before -> after: 0/3 phases.

## Background
Trace format (read by Main 2026-10-24 in ~/.omp/agent/sessions/-projects/*.jsonl): one JSON object per line; type in session, model_change (model, resolvedModelIsFallback), message, model_usage, custom, compaction. message.message.role = user | assistant | toolResult. Assistant messages carry model, provider, api, responseId, stopReason, usage, content[] with {type:"toolCall", id, name, arguments, intent}. toolResult carries toolCallId, toolName, isError, content. Subagent sessions sit one level deeper (session dir).
