# Traces 7: living labels (good/bad work, traced back from later bug fixes)
Worktree: /home/ukd/Work/neurastream-traces-labels
Branch: feat/traces-labels

## Goal
- Owner (2026-10-24 ~19:10, after seeing the architecture diagram): "Looks great, super. Plan it." Label every piece of agent work (episode = spawn brief + agent run + its commits + plan phase) as good / bad / unknown from results, never from an LLM opinion.
- Labels are living (owner): work that looked good can turn bad days later. When a bug fix lands, trace its changed lines back with git blame to the commit that caused the bug, flip that commit's episode to bad, and say who caused it: the plan (Main), the implementer, both, and always the test hole that let it through.
- The ledger is append-only and dated: a flip is a new line ("good 24 Oct" then "bad from 27 Oct, found by fix f9"), never an edit. Scores read the latest line.
- Good set = episodes 14+ days old that never flipped; it feeds brief examples now and a local fine-tune later.
- Owner-approved point 4: a removal must only remove. Added comments like "removed X" / "no longer used" are flagged.
- Order: after traces 01 (TraceSource) and traces 05 (waste counters) land.

## Forbidden
- Never push, merge, tag or publish; commit on the plan's branch and report.
- Never edit or delete a line of the label ledger in code or tests: append only. A correction is a new line.
- No LLM call anywhere in labelling. Every label comes from a recorded event, git, or an explicit Main command.
- Never read, copy or commit secrets (`~/.config/gateforge/**`, `*.env*`, `*keys*.txt`, `mcp.json`, keyrings). The good-set export holds references (run id, file paths, shas), never copied transcript text.
- Never touch the live setup (`~/.omp/agent`, `~/.local/bin`, `~/.local/state`) except READ-ONLY reads of session files and the score events file. Tests use a sandbox `HOME=/tmp/neurastream-home-*`, fixture git repos built in temp dirs, and fixture JSONL under `tests/fixtures/`.
- No harness or provider names in `src/core/` (AGENTS.md architecture rule). Repo paths, fix patterns, ages and weights come from config (`templates/config.yml` + README defaults).

## Blockers
- no-push
- blockers/traces-core-clean.sh

## Phases
- [x] P1 Episode builder `src/core/episodes.ts`: join score events (accept / validate / diagnose / penalty: agent, plan, phase, repo, branch, commits) with the run (RunSource: model, calls, tokens, status) and the spawn brief (traces 01 TraceSource: the main session's task call naming that agent). Episode = {id, agent, model, plan, phase, repo, commits[], runId, briefRef, acceptedAt, rework}. Runs that DIED or went over budget with no accept are episodes too (no commits). CLI `neurastream labels episodes [--since 30d] [--json]`. — difficulty: 3 — verify: `bun test tests/episodes.test.ts`
- [x] P2 Label ledger + first labeller `src/core/labels.ts`; the ledger is labels.jsonl in the score_state dir, one line = {ts, episode, label: good|bad|unknown, reason, party: plan|implementer|both|test|none, evidence, found_by?}. Rules: accept without rework → good; accept with rework → bad (implementer); penalty → bad; DIED / over budget with no accept → bad; an episode commit later reverted ("This reverts commit <sha>") → bad. Effective label = last line per episode. Test: the file's old bytes are an unchanged prefix after every write. — difficulty: 3 — verify: `bun test tests/labels.test.ts`
- [ ] P3 Trace-back `src/core/label-traceback.ts`: for each new commit on the repo's default branch whose subject matches config labels.fix_patterns (default `^(fix|hotfix)\b`, `^Revert `), take the lines it removed or changed in non-test files, `git blame -w <fix>^` them, map each introducing commit to its episode (P1), and append bad with found_by = the fix sha. Skip merge commits and commits older than labels.horizon_days. Fixture repo: episode commit A, then "fix:" commit F changing A's line → A's episode flips bad; a fix touching only non-episode lines → no label; a fix touching only tests → no label. — difficulty: 4 — verify: `bun test tests/label-traceback.test.ts`
- [ ] P4 Blame split + scores. Party rules, deterministic, from the plan file the episode names: plan if a backticked identifier or path from the phase line / Background appears in the blamed lines; implementer if the blamed lines sit in files the plan never names; both true → both; neither → unclear. Every flip of an accepted episode also appends a test-party line and opens an incident "test hole: <fix sha> changed lines no check caught" via addIncident. Main override: `neurastream labels assign <episode> --party plan|implementer|both --why "<text>"` (appends a line). agent-score board and gate: a flipped episode loses its accept points (config labels.flip_weight, default 1.0 = all); plan-party flips count against MAIN in the board. Golden outputs stay identical when the ledger is empty. — difficulty: 4 — verify: `bun test tests/label-party.test.ts tests/agent-score*.test.ts tests/golden && bun run typecheck`
- [ ] P5 Triggers + good set. `neurastream labels update --repo <dir>` runs P2+P3 on commits since its cursor (a cursor line in the same ledger). Run moments: after every merge (next to `neurastream metrics ci`) and once a day from main-start for each repo in config labels.repos. `neurastream labels export --good [--min-age-days 14] [--json]`: episodes whose latest label is good, older than the min age, never flipped; each row lists runId, brief ref, commits, and the step indexes traces 05 marks as wasted (dropped steps). Add the after-merge moment to the managed orchestrator rules block in the package. — difficulty: 3 — verify: `bun test tests/labels-update.test.ts tests/labels-export.test.ts`
- [ ] P6 Removal check (owner point 4). `neurastream diff-check [--staged | <rev>]`: flags added comment lines matching config labels.removal_comment_patterns (default: `\bremoved\b`, `\bno longer\b`, `\bpreviously\b`, `\bused to\b`, `\bwas deleted\b`); when the commit subject matches labels.removal_subjects (default `^(remove|drop|delete)\b`, `^chore: remove`) any added non-blank line is flagged. Plan-guard: a subagent's `git commit` runs it on the staged diff in its cwd and refuses on hits, listing the flagged lines. Red: fixture removal adding "# removed old helper" is refused; green: a pure deletion passes. — difficulty: 3 — verify: `bun test tests/diff-check.test.ts tests/guards.test.ts`
- [ ] P7 Smoke, read-only, sandbox ledger: build episodes and run labels update over the last 30 days of PM (/home/ukd/Work/pm-mr196), CP (/home/ukd/Work/aetherios-contractor-portal), gateforge (/home/ukd/Work/gateforge) and neurastream with HOME pointed at a sandbox copy of the score events. Progress: episode count, good / bad / unknown counts, every flip found with its fix sha, and 3 hand-checked flips (true / false positive). README + CHANGELOG Unreleased + config defaults. — difficulty: 2 — verify: `bun run typecheck && bun test`

Read /home/ukd/projects/opus-implementer-method.md first. Call budget: stop and report within ~80 calls. Suite runs: `/home/ukd/Work/heavy-run.sh <agent> "<label>" -- bun test`.

## Done check
`cd /home/ukd/Work/neurastream-traces-labels && bash /home/ukd/projects/neurastream/docs/plans/blockers/traces-core-clean.sh && bun run typecheck && bun test && git merge-base --is-ancestor HEAD origin/main`

## Code read by Main
- `/home/ukd/projects/neurastream/src/core/agent-score.ts` (events.jsonl in score_state; accept records agent, plan, phase, repo, branch, commits, rework; validate / diagnose / penalty / exempt / base / check / board / gate)
- `/home/ukd/projects/neurastream/src/core/adapter.ts` (Run, RunSource, ToolEvent, SpawnEvent{agent, invocationKind, brief})
- `/home/ukd/projects/neurastream/src/core/guards.ts` (changedProjectFiles, planGate, subRules call budget at 290-294, checkSpawn)
- `/home/ukd/projects/neurastream/src/cli/metrics.ts` (recordCi appends {type:"ci", mr, repo, tries}; the after-merge moment)
- `/home/ukd/projects/neurastream/docs/plans/blockers/traces-core-clean.sh` (covers every neurastream-traces-* worktree under /home/ukd/Work)
- `/home/ukd/projects/neurastream/docs/plans/20261024_0300_traces_01_source_and_claims.md` (TraceSource this plan builds on)
- `/home/ukd/projects/neurastream/docs/plans/20261024_0304_traces_05_agent_efficiency.md` (waste counters used for dropped steps)

## Progress
Status: open
WAITING on owner: split decision (2026-10-25 ~18:00): move git labels (P3 trace-back) + release metrics into a standalone any-repo tool, or build P3 inside neurastream now
- 2026-10-25 (NsTracesLabelsP1b): Implemented P1 episode builder, `labels episodes`, config default, docs, and tests; commit `d983c8d`. Targeted test: 5 pass, 0 fail. Full suite: 814 pass, 3 skip, 3 fail due to `/tmp` quota (`tests/golden/ports-p4.test.ts:67` two EDQUOT writes; `tests/golden/ports-p4.test.ts:236` EDQUOT git index). Typecheck was not available (`tsc: command not found`, exit 127). Findings: tests/golden/ports-p4.test.ts:67 two sandbox writes failed EDQUOT; tests/golden/ports-p4.test.ts:236 sandbox git index write failed EDQUOT; src/core/episodes.ts: typecheck unverified because `tsc` is unavailable

- 2026-10-25 16:15 (Main): spawn NsTracesLabelsP1 (haiku) died at once on an Anthropic account 429 (retry-after ~44 min); no work done, nothing committed. Relaunching as NsTracesLabelsP1b on luna (glm blocked till 18:56, grok out of credits). Findings: none

- 2026-10-25 ~17:50 (Main): P2 verified (commit b045e35; heavy-run 826 pass, 3 skip, 0 fail, typecheck ok; accept recorded). Next: P3 trace-back on glm (live probe OK). Findings: none
- 2026-10-25 16:40 (Main): verified P1. The EDQUOT failures were /tmp/neurastream-home-golden-p4 (4.1G) filling the tmpfs quota; deleted. `tsc` was missing because the worktree had no node_modules; after `bun install`, typecheck caught a real regression: d983c8d replaced the `snapshot` type (src/core/config.ts:171) and the `metrics.report_days` check (:407) instead of adding next to them. Main restored both in 1c58205. Main rerun: typecheck OK, 820 pass / 0 fail. Scored as accept with rework. P2 next. Findings: src/core/config.ts:171 snapshot type deleted by d983c8d (fixed in 1c58205); src/core/config.ts:407 report_days check deleted by d983c8d (fixed in 1c58205)

- 2026-10-25 (NsTracesLabelsP2): Added append-only `labels.jsonl` ledger and deterministic first labeller for accept/rework, penalty, failed/over-budget runs, and later reverts; added tests for all rules, effective latest-per-episode labels, and byte-prefix preservation. Targeted: 6 pass, 0 fail; full suite: 823 pass, 3 skip, 0 fail; typecheck: pass. Findings: none

## Background
Design agreed in chat 2026-10-24:
- Sources already recorded: transcripts, spawn briefs + plans, agent-score events, heavy-run log, git, CI results, owner corrections (incidents).
- Labels from results only. Unknown is thrown away, not guessed.
- SZZ-style trace-back: fix → blame its changed lines at the parent → the commit that introduced them → that episode flips bad.
- Penalty split: plan wrong → Main; plan fine, agent did something else → implementer; both → both; every late bug is also a test hole and opens an incident.
- Good set needs 14 days with no flip; younger episodes stay unknown.
