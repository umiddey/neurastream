# neurastream visual explainer deck
Worktree: /home/ukd/Work/neurastream-visual-deck
Branch: docs/visual-deck
PRIORITY-ID:

## Goal
- Owner (2026-10-21): "use a subagent to [visualize] neurastream with every low level detail, ensure a non techie can understand, no analogies" (visualize-this skill, forest + trees deck).

## Forbidden
- Read /home/ukd/projects/opus-implementer-method.md first. `find` is broken: use grep/glob/read.
- Never push, never tag, never publish. Never `--no-verify`, never `git add -A`. No installs.
- Edit only docs/visual/** in the worktree. Never edit engine.html of the skill. Live setup (~/.omp, ~/.local, ~/.config) is read only.
- No analogies or metaphors anywhere in the deck.
- Heavy runs (check-eco --play) go through `/home/ukd/Work/heavy-run.sh <Agent> "<label>" -- <cmd>`, tool timeout 0. Budget ~100 tool calls; Progress bullet by call 85.

## Blockers
- no-push
- deny-path /home/ukd/.omp/agent/** /home/ukd/.local/bin/** /home/ukd/.local/state/** /home/ukd/.config/** /home/ukd/.codex/** INDEX.md /home/ukd/Work/neurastream-visual-deck/src/** /home/ukd/Work/neurastream-visual-deck/tests/**
- deny-command npm\s+publish bun\s+publish git\s+tag --no-verify git\s+add\s+(-A|--all|\.)(\s|$)

## Phases
- [x] P1 Build docs/visual/neurastream.eco.js + docs/visual/neurastream-deck.html per the visualize-this skill; layout and --play checks clean; screenshots looked at; committed locally — difficulty: 3 — verify: `cd /home/ukd/Work/neurastream-visual-deck && test -s docs/visual/neurastream-deck.html && PLAYWRIGHT=/home/ukd/Work/pm-counts/node_modules/playwright/index.mjs node /home/ukd/.codex/skills/visualize-this/ecosystem/check-eco.mjs docs/visual/neurastream-deck.html`

## Done check
`cd /home/ukd/Work/neurastream-visual-deck && git fetch -q origin && git merge-base --is-ancestor HEAD origin/main && test -s docs/visual/neurastream-deck.html && PLAYWRIGHT=/home/ukd/Work/pm-counts/node_modules/playwright/index.mjs node /home/ukd/.codex/skills/visualize-this/ecosystem/check-eco.mjs docs/visual/neurastream-deck.html`

## Code read by Main
- `/home/ukd/projects/neurastream/README.md`
- `/home/ukd/projects/neurastream/AGENTS.md`
- `/home/ukd/projects/neurastream/docs/inventory.md`
- `/home/ukd/projects/neurastream/src/core/guards.ts`
- `/home/ukd/projects/neurastream/src/core/queue-close.ts`
- `/home/ukd/projects/neurastream/src/core/blockers.ts`
- `/home/ukd/projects/neurastream/src/core/heavy-run.ts`
- `/home/ukd/projects/neurastream/src/adapters/omp/index.ts`

## Progress
Status: complete
- 2026-10-22 (Main): verified 5b4fc8b: check-eco "layout: 50 steps, 0 problems", `--play` "playthrough done", "page errors: none"; Main viewed all 50 shots across passes (steps 6, 27-37, 44, 47 after the fix). Accepted + scored NsVisualDeckHaiku (9aeee74) and NsVisualDeck2Haiku (8f67dfb, 5229a85, 5b4fc8b). Rebased onto 0.1.9 and pushed to main as cdfd68f (README links the deck). P1 ticked.
- 2026-10-21 (NsVisualDeck2Haiku): P2 overflow fixes committed locally as 5229a85 on docs/visual-deck (on top of 8f67dfb; not pushed). Fixed overflowing cards in the flagged steps of docs/visual/neurastream.eco.js (file tag 2002 at fix time): shortened port labels, wrapped long card lines, widened or moved chips, widened the heavy-run terminal to w 680 and moved the busy chip to x 940. Checks on 5229a85: `check-eco.mjs` → "layout: 50 steps, 0 problems", "page errors: none"; `--play` via heavy-run → "played 50/50", "playthrough done", "page errors: none"; `--shots` 1..50 regenerated. Re-viewed clean: steps 3, 5, 9, 21, 25, 29, 34, 38, 39, 47, 48. Not re-viewed after the fix (edits are the same kind as the viewed ones): steps 6, 27–28, 30–33, 35–37. Next: Main reviews 5229a85.
- 2026-10-21 21:09 UTC (NsVisualDeck2Haiku): P2 pass done, committed locally as 8f67dfb on docs/visual-deck (not pushed). Files: docs/visual/neurastream.eco.js, docs/visual/neurastream-deck.html. Now 50 steps (was 36): rollover and main health, helper refusals and call budget, close proofs and reopen, ledger cap / allow-list / task-only gates. Checks: `check-eco.mjs` → "layout: 50 steps, 0 problems", "page errors: none"; `--play` via heavy-run → "played 50/50", "playthrough done", "page errors: none". Labelled as paraphrase or example in the step notes: spawn and proof checklist labels, examples (msg, machine, ctx, plan, test counts, okCmd/okPath). Unlock path checked against live config (~/.omp/agent/.guard-unlock). Next: Main verifies, decides P1 tick and push.
- 2026-10-22 00:2x (Main): reviewed 9aeee74 (36 steps, layout 0 problems, play clean; shots 1/12/30 viewed): missing owner-asked detail → pass 2: side boxes (health checks, rollover, release+doctor), all 4 blocker kinds + protected files + call 90/100, queue-close merged proofs/reopen/AWAITING, fill sparse views. NsVisualDeckHaiku hit budget before editing; fresh agent gets its verified facts in /home/ukd/Work/neurastream-visual-deck-facts.md.
- 2026-10-21 23:0x (Main): NsVisualDeckSol failed at start ("No model selected"; openai-codex out since 10-13). Luna same provider, Muse needs owner privacy setting → Haiku (owner's stated last resort).
- 2026-10-21 22:5x (Main): NsVisualDeckGemini failed at start: Gemini quota exhausted (resets 2026-10-23 23:10Z). Relaunching on sol.
- 2026-10-21 22:5x (Main): NsVisualDeckHiko failed at start: Cursor usage limit (resets 2026-11-10). Relaunching on gemini (GLM slots full, Grok/DeepSeek out of credit).
- 2026-10-21 22:4x (Main): plan written (owner wanted no plan; main-guard requires one for any spawn). Worktree created from origin/main a013ccc.
- 2026-10-21 23:xx (NsVisualDeckHaiku): P1 done, committed locally as 9aeee74 on docs/visual-deck (not pushed). Files: docs/visual/neurastream.eco.js, docs/visual/neurastream-deck.html. Checks: build ok; `check-eco.mjs` → "layout: 36 steps, 0 problems", "page errors: none", exit 0; `--play` through heavy-run → "playthrough done", exit 0; `--shots` 1,5,10,20,30 looked at, fixed overlaps on steps 10 and 20 and re-checked. Next: Main verifies the deck, ticks P1, and decides on the push.

## Background
Forest boxes (real order, verify each in code): 1 owner message → omp adapter injects queue summary, flags cancel words, resets Main's edit window (src/adapters/omp/index.ts before_agent_start, guards.ts checkInject/flagCancel). 2 Main writes plan (template sections, repo + main INDEX.md, queue-check, main-reads log, guards.ts recordMainReads). 3 spawn gates: agent-ledger --cap, agent-score gate, brief-lint, main-guard allow-list + Progress changed + task only (guards.ts spawnProblem/planGate/checkSpawn). 4 helper agents in parallel under plan-guard (guards.ts checkTool/subRules/checkPlanEdit; blockers.ts no-push/deny-path/deny-command/deny-text; call 90 warn, 100 stop; heavy-run.ts lock). 5 Main review + agent-score accept/validate/board. 6 merge + push. 7 queue-close (queue-close.ts: done check, merged incl. squash detection, refs/queue-archive, worktree/branch removal, archive, index removal; cancel → CANCELLED.md). Side: main-start/machine-guard, session rollover at 10 MB (README "Session rollover"), doctor + npm release.
Running example: plan docs/plans/archive/202610/20261020_2100_agent_score_validate.md, agent NsScoreValidateGlm, branch feat/score-validate. Failures next to successes: helper `git push` refused by no-push; edit outside Progress restored; queue-close "AWAITING merge" for an unmerged branch.
