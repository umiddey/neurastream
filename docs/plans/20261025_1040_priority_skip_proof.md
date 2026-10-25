# A priority skip needs proof, not any reason
Worktree: /home/ukd/Work/neurastream-skip-proof
Branch: fix/priority-skip-proof

## Goal
- Owner (2026-10-25 ~10:35, answering "Plan this fix now?"): "yes". His rule: with N free agents, the top N plans in INDEX.md get them. A lower plan may get an agent before a higher idle one only when the owner said so, or when the higher plan waits on the owner or on another plan.
- Today priorityProblem (src/core/guards.ts:354-377) accepts any `Priority skip: <path> — <why>` with a non-empty why, so Main skipped traces_04 with "WIP over limit" (main-guard.log 07:17:05Z). Owner holds (`WAITING on owner:`) already do not block (priorityIdle, :344-346).
- Done = only two things let a lower plan go first:
  1. The higher plan carries a `Waits on: <absolute plan path>` line, and that plan is still in INDEX.md and not complete/cancelled. Then the higher plan is not idle, with no skip line needed.
  2. A skip line `Priority skip: <path> — owner: "<words>"` whose quoted words (at least 4 words, compared after lower-casing and folding whitespace) appear in an owner message recorded in the last 24 h.
- Every other skip line is refused: `higher plan <path> (rank N) is idle; a skip needs the owner's words (Priority skip: <path> — owner: "<quote>") or a "Waits on: <plan>" line in that plan`.
- Owner messages come from checkInject (:833-853): every injected prompt that is not a guard continuation (starts with "main-guard:") and not a harness notice (starts with "<system-notice>" or contains "<task-result") is appended to `<queue_state>/owner-messages.jsonl` as {at, text}, keeping the newest 50.

## Forbidden
- Read /home/ukd/projects/opus-implementer-method.md first and work by it. Read the repo AGENTS.md.
- Work only in /home/ukd/Work/neurastream-skip-proof on fix/priority-skip-proof. Never push, merge, tag or publish; commit files by name (never `git add -A`/`.`), never `--no-verify`.
- Never change the package.json version or CHANGELOG release headings; add lines under `## Unreleased`.
- Never touch the live setup (~/.omp/agent, ~/.local/bin, ~/.local/state, ~/.bun, the owner's config dir). Tests use a sandbox HOME.
- Never change the frozen oracle scripts under tests/fixtures/originals/.
- Never weaken an existing guard test to make it pass; the old "any reason passes" tests (tests/guards-priority.test.ts:193-199 and :245-262) are rewritten to the new rule, not deleted.
- Tests: no Bun.sleep/setTimeout; time comes from NEURASTREAM_NOW. Every test run goes through `/home/ukd/Work/heavy-run.sh agent "<label>" -- <cmd>`.
- Stop and report within ~100 calls: write a Progress entry with the exact resume point before call 90.

## Blockers
- no-push
- deny-path /home/ukd/.omp/agent/** /home/ukd/.bun/** /home/ukd/.local/state/** /home/ukd/.local/bin/** tests/fixtures/originals/**
- deny-command --no-verify git\s+add\s+(-A|--all|\.)(\s|$) git\s+push\b git\s+merge\b git\s+tag\b npm\s+publish reset\s+--hard

## Phases
- [x] P1 Owner message record. In checkInject (src/core/guards.ts:833-853) append owner prompts to `owner-messages.jsonl` in q.STATE_DIR as Goal says (skip continuations and notices; newest 50 kept; a write error is logged to the guard log, never thrown). Export a pure `ownerSaid(words, messages, nowSec)` that is true when the normalised quote (≥ 4 words) is a substring of a normalised message from the last 86400 s. Red tests first in tests/guards-priority.test.ts: an owner prompt is recorded; a "main-guard:" continuation and a "<system-notice>" prompt are not; the 51st message drops the oldest; ownerSaid true for a quote with different case and spacing, false for a 3-word quote, false for a message 86401 s old — difficulty: 3 — verify: `cd /home/ukd/Work/neurastream-skip-proof && /home/ukd/Work/heavy-run.sh agent "skip p1" -- sh -c 'bun test tests/guards-priority.test.ts && bun run typecheck'`
- [x] P2 Gate. Parse `Waits on: <path>` (any line, optional "- " bullet) in parsePlan (src/core/queue/lib.ts:228-233 area) as `waitsOn: string[]`; priorityIdle (src/core/guards.ts:344-346) treats a plan as not idle while any waitsOn path is in the active index with status open. Add "Waits on:" to both MAIN_ONLY_LINE regexes (src/core/guards.ts:856, src/core/queue/lib.ts:117) so a subagent cannot add or remove it. priorityProblem (:354-377) accepts a skip line only in the `owner: "<words>"` form with ownerSaid true (messages read from owner-messages.jsonl by priorityGate :380-385, so priorityProblem stays pure: pass the messages in); refusal text exactly as Goal says; the logged skip line keeps the quote. Red tests first: "busy" skip refused; owner quote that the owner said → allowed and logged; owner quote nobody said → refused; quote older than 24 h → refused; higher plan with `Waits on:` an open indexed plan → lower spawn allowed with no skip line; same once that plan is closed (removed from the index) → refused; WAITING on owner still does not block; a subagent edit adding `Waits on:` to a plan is restored. Rewrite the tests at tests/guards-priority.test.ts:193-199 and :245-262 to the new rule — difficulty: 5 — verify: `cd /home/ukd/Work/neurastream-skip-proof && /home/ukd/Work/heavy-run.sh agent "skip p2" -- sh -c 'bun test tests/guards-priority.test.ts tests/guards.test.ts tests/queue-summary.test.ts && bun run typecheck'`
- [x] P3 Docs + full suite. templates/AGENTS.md:7 becomes: "INDEX.md order is priority: free agents go to the top plans first. A lower plan goes first only when the higher one says `Waits on: <plan>`, is WAITING on owner, or the brief quotes the owner: `Priority skip: <plan> — owner: \"<his words>\"`." README queue section (README.md:99), CHANGELOG Unreleased → Changed, queue TEMPLATE comment if it names skip lines. INCIDENT I-20261025-127: the plan-edit refusal sentence must name "Waits on:" with the other Main-only lines (MAIN_ONLY_LINE src/core/guards.ts:901); tests/guards.test.ts:218-220 pins the reason to the frozen original's text, so make it a port-only difference like the Findings rule (expect the original text with "Waits on:" added); the changed assertion is fail-before (it fails on the old refusal text, run it red first) — difficulty: 2 — verify: `cd /home/ukd/Work/neurastream-skip-proof && /home/ukd/Work/heavy-run.sh agent "skip full" -- sh -c 'bun test && bun run typecheck'`
- [ ] P4 Main: review, merge, release by tag under the owner's unlock, install, `neurastream doctor` exit 0; live check: a spawn on a lower plan with `Priority skip: <higher> — busy` is refused while the higher plan is idle — difficulty: 1 — verify: `git -C /home/ukd/projects/neurastream merge-base --is-ancestor fix/priority-skip-proof origin/main`

## Done check
`cd /home/ukd/Work/neurastream-skip-proof && bun run typecheck && git fetch -q origin && git merge-base --is-ancestor HEAD origin/main`

## Code read by Main
- `src/core/guards.ts` (planGate strips skip lines :290-293; priorityIdle :344-346; priorityProblem :354-377; priorityGate :380-385; checkSpawn :793; flagCancel :808-822; checkInject :833-853; MAIN_ONLY_LINE :856)
- `src/core/queue/lib.ts` (parsePlan waiting/waitingLine :229-230; MAIN_ONLY_LINE :117; CANCEL_PENDING in STATE_DIR :772-786)
- `src/core/queue-cancel.ts` (the not-a-cancel record only logs Main's why, not the owner's words :26-37)
- `tests/guards-priority.test.ts` (sandbox HOME setup :18-108; old any-reason skip tests :193-199, :245-262)
- `templates/AGENTS.md` (line 7, the skip rule text)
- `README.md` (queue priority section :99)
- `tests/guards.test.ts` (plan-edit refusal parity with the frozen original :210-230)

## Progress
Status: open
- 2026-10-25 11:45 Main (for NsSkipProofP3Luna, cannot write outside its worktree): P3 committed 62ed851 (templates/AGENTS.md:7, README.md:99, CHANGELOG.md, refusal text src/core/guards.ts:920 now names "Waits on:", tests/guards.test.ts:220). heavy-run "skip incident red" END exit 1 11:36:33 (the changed assertion failed on the old text), "skip full" END exit 0 11:39:17 (717 pass, 3 skip, 0 fail; tsc clean). Main reviewed the gate (guards.ts:391-418 owner-quote-only skips, Waits on) and ticked P1-P3. Before release: add `Waits on:` lines to traces_06 (→ traces_05) and traces_07 (→ traces_06), since "waits on another plan" skip reasons stop working. Findings: none
- 2026-10-25 11:35 Main: incident I-20261025-127 folded into P3 (refusal sentence names "Waits on:"). Spawning NsSkipProofP3Luna for P3. Findings: none
- 2026-10-25 10:42 Main (for NsSkipProofGlm, died on a zai 429 during P3): P1 70593cd and P2 65a5159 are committed; P3 is uncommitted (CHANGELOG.md, README.md, templates/AGENTS.md). heavy-run "skip full" END exit 1 at 10:24:05, never rerun. Resume: find the failing test, fix it, finish P3 docs, full suite to END exit 0, commit. Findings: none
- 2026-10-25 10:10 Main (for NsSkipProofLuna, stopped after 2m46s without a Progress entry): uncommitted in the worktree: src/core/guards.ts, src/core/queue/lib.ts, tests/guards-priority.test.ts (+59/−1): first owner-message record + ownerSaid code, P1 tests, a started `waitsOn` field on Plan. heavy-run "skip p1" END exit 1 at 10:04:26 (agent report: a test quote "TRACES   SERIES" had fewer than 4 words; it changed the quote but did not rerun). Resume: rerun the P1 verify, finish P1, then P2 and P3. Findings: none
- 2026-10-25 10:40 Main: plan written after the owner's "yes". Checked: priorityProblem accepts any non-empty why (:363, :369-372); WAITING plans already skip the gate (priorityIdle); no plan-dependency field exists today (grep of TEMPLATE.md, plans and lib.ts for "Depends on|Waits on" found nothing); no store of owner words exists (queue-cancel logs Main's why only). Findings: none
- 2026-10-25 10:18 glm P1: kept the previous agent's uncommitted work (owner-message record + ownerSaid + P1 tests) and fixed its typecheck: the second Plan literal in parsePlan's empty branch and the widened test event helper (typed InjectEvent). Committed 70593cd (src/core/guards.ts, tests/guards-priority.test.ts; forbidden-names scan 0 hits). Verify `skip p1` END exit 0 in /home/ukd/Work/.heavy-run.log (11 pass, tsc clean). Findings: the waitsOn Plan field the previous agent added forced parsePlan to populate it for tsc — that line sits uncommitted and ships with P2, so the P1 commit stays owner-record-only.
- Older Progress entries: archive/20261025_1040_priority_skip_proof-progress.md
