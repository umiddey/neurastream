# Plan blockers apply to every worktree of the repo (0.2.0 one-index regression)
Worktree: /home/ukd/projects/neurastream-blocker-scope
Branch: fix/blocker-scope

## Goal
- Owner rule (one-index, 0.2.0): "One plan = one worktree". A plan's blockers must guard its own worktree, its main checkout and its `## Applies to` paths, never another open plan's worktree.
- Seen live 2026-10-24 ~16:00: PmStaticGateP7Haiku, working on plan /home/ukd/Work/pm-mr196/docs/plans/20261024_1100_pm_ambiguous_observed_mocking.md in its worktree /home/ukd/Work/pm-ambiguous, was refused an edit of tests/e2e/real/portal_me_session.spec.js by `deny-path tests/**` of a DIFFERENT plan (/home/ukd/Work/pm-mr196/docs/plans/20261015_2003_pm_suite_e2_endpoint_scan.md, Worktree /home/ukd/Work/pm-suite-E2-s1.wt).
- Cause: src/core/queue/lib.ts:286-289 `planCovers` returns true when `repoRoot(p) === plan.repo`; `repoRoot` (lib.ts:257-280) maps any linked worktree to its main checkout. Since 0.2.0 every plan lives in the main checkout, so every open plan of a repo covers every worktree of that repo, and src/core/guards.ts:303-309 `subRules` runs the union of all their blockers.
- Wanted: a path inside a linked worktree that another open plan names as its `Worktree:` is covered only by that plan (plus any plan whose `## Applies to` lists it). Paths in the main checkout and in worktrees no open plan names stay covered as today (safe default).

## Forbidden
- Read /home/ukd/projects/opus-implementer-method.md first and work by it. Read the repo AGENTS.md.
- Work only in /home/ukd/projects/neurastream-blocker-scope on fix/blocker-scope. Never push, merge, tag or publish; never change package.json version or CHANGELOG release headings (Main releases). Commit files by name; never `git add -A`/`.`; never `--no-verify`.
- Never touch live copies (~/.omp/agent/**, ~/.bun/**), never the live queue index.
- Tests assert behaviour (which call is refused/allowed), never wording or source text.
- Every phase is fail-before: write the test, run it red, record the red run, then change src.
- Every test run via `/home/ukd/Work/heavy-run.sh <agent> "<label>" -- <cmd>` with tool timeout 0. Green = `bun test` at the worktree root.
- Call budget: stop and report within ~100 calls (warning at 90). By call 85 add ONE dated bullet under `## Progress` after the `Status:` line.

## Blockers
- no-push
- deny-path /home/ukd/.omp/agent/** /home/ukd/.bun/** package.json INDEX.md
- deny-command --no-verify git\s+add\s+(-A|--all|\.)(\s|$) git\s+push\b git\s+merge\b git\s+tag\b npm\s+publish reset\s+--hard

## Phases
- [x] P1 Red test in tests/guards.test.ts style (sandbox HOME, toy repo with a main checkout holding two open plans A and B, each naming its own linked worktree; B has `deny-path tests/**`): a subagent edit of `tests/x.spec.js` inside A's worktree is refused today (record the red run). Also assert: the same edit inside B's worktree stays refused; an edit in the main checkout under tests/ stays refused; an edit inside a worktree no plan names stays refused — difficulty: 4 — verify: `cd /home/ukd/projects/neurastream-blocker-scope && /home/ukd/Work/heavy-run.sh agent "blocker scope red" -- bun test tests/guards.test.ts`
- [x] P2 Fix in src/core/queue/lib.ts `planCovers` (or its caller in src/core/guards.ts subRules): a path whose git worktree top is the `Worktree:` of another open plan is not covered by this plan unless this plan's `## Applies to` lists it. Keep the main-checkout and unnamed-worktree behaviour. Check every other caller of `planCovers` (grep) keeps its meaning. CHANGELOG `## Unreleased` → Fixed entry. Full suite green — difficulty: 4 — verify: `cd /home/ukd/projects/neurastream-blocker-scope && /home/ukd/Work/heavy-run.sh agent "blocker scope full" -- bun test`

## Done check
`git -C /home/ukd/projects/neurastream merge-base --is-ancestor fix/blocker-scope origin/main`

## Code read by Main
- `src/core/queue/lib.ts`
- `src/core/guards.ts`
- `src/core/blockers.ts`

## Progress
Status: complete
- 2026-10-24 ~20:30 (Main): merged (0.2.3 released, publish green); macOS CI fix c7fc1ae green (run 40103126540). Install waits on the owner unlock. Findings: none
- 2026-10-24 15:56 (NsBlockerScopeGlm): P1+P2 done in /home/ukd/projects/neurastream-blocker-scope on fix/blocker-scope. `planCovers` (src/core/queue/lib.ts:286) now takes the plan list: a path whose git worktree top is another open plan's `Worktree:` is covered only by that plan (plus `## Applies to`); main checkout and unnamed-worktree coverage unchanged; only live caller src/core/guards.ts:304 subRules passes `plans` (fixture originals untouched).
  Red: `/home/ukd/Work/heavy-run.sh NsBlockerScopeGlm "blocker scope red (reason)" -- bun test tests/guards-scope.test.ts` → 0 pass / 1 fail, exit 1 — write of tests/x.spec.js in plan A's worktree refused with "blocked by plan 20261019_plan_b.md: deny-path … (deny-path tests/**)".
  Green: `/home/ukd/Work/heavy-run.sh NsBlockerScopeGlm "blocker scope full" -- bun test` → 406 pass / 3 skip / 0 fail (409 tests, 47 files, 124.5s, exit 0); `bun run typecheck` exit 0.
  Commits: 3c75d27 (test, red), e101384 (fix + CHANGELOG Unreleased Fixed); forbidden-names scan 0 hits; worktree clean; nothing pushed.
  Next: Main reviews and merges fix/blocker-scope (done check: merge-base --is-ancestor origin/main).
  Findings: none
- 2026-10-24 ~16:05 (Main): plan written after the live refusal above. Next: spawn P1+P2. Findings: src/core/queue/lib.ts:288 planCovers covers every worktree of the repo once plans live in the main checkout.
