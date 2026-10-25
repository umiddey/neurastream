# Owner page reorder works while the index also lists non-open plans
Worktree: /home/ukd/projects/neurastream-reorder-fix
Branch: fix/reorder-open-only

## Goal
- INCIDENT I-20261025-29 / INCIDENT I-20261025-30 (agent finding on the redesign P4, confirmed by Main): the page's queue shows only `status: open` plans (queueRows, src/core/owner-ui.ts:176-180), but POST /reorder compares `order` and `before` against EVERY plan line in INDEX.md (handleReorder :726-762 via indexPlanLines :665-687). A plan that is `Status: complete` but still indexed (queue-close keeps it while it AWAITS merge, e.g. W16 tonight) makes every drag answer 400, and the page ranks differ from the file ranks.
- Done when: with INDEX.md = [open A, complete B, open C, waiting D], the page shows A, C, D ranked 1–3; dragging D to the top rewrites INDEX.md to [D, B, A, C] (non-open lines keep their slots, open plans fill the open slots in the new order); the inbox record's `from`/`to` are the page ranks (3 → 1).

## Forbidden
- Read /home/ukd/projects/opus-implementer-method.md first and work by it. Read the repo AGENTS.md.
- Work only in /home/ukd/projects/neurastream-reorder-fix on fix/reorder-open-only. Never push, merge, tag or publish. Never change the package.json version or CHANGELOG release headings; add lines under `## Unreleased`. Commit files by name; never `git add -A`/`.`; never `--no-verify`.
- Never touch live copies (~/.omp/agent, ~/.bun, the user config dir).
- Never change `authenticate`, `isLoopback`, `isTailnet`, `hostAllowed`, the Origin check, the bind address or the request log line in src/core/owner-ui.ts, nor their tests.
- Tests: no Bun.sleep/setTimeout; sandbox HOME + temp INDEX.md like tests/owner-ui.test.ts; red test first.
- Every test run goes through `/home/ukd/Work/heavy-run.sh agent "<label>" -- <cmd>`.
- Stop and report within ~75 calls (the brief's `Call budget:` line wins): write a Progress entry with the exact resume point before you run out.

## Blockers
- no-push
- deny-path /home/ukd/.omp/agent/** /home/ukd/.bun/** src/adapters/** src/core/guards.ts src/core/tailscale.ts
- deny-command --no-verify git\s+add\s+(-A|--all|\.)(\s|$) git\s+push\b git\s+merge\b git\s+tag\b npm\s+publish reset\s+--hard systemctl\s+--user neurastream\s+ui\b

## Phases
- [ ] P1 One source of truth for "the reorderable set": the open plans of the index in index order, the same list queueRows renders (activePlans(...).filter(status === "open")). handleReorder checks `order` (exact set, no duplicates → else 400) and `before` (equal to the current open order → else 409) against that list, not against every index line. reorderedIndexText takes the new open order and fills only the slots that open plans held; every other plan line keeps its slot with its attached comment/blank lines; a path listed twice keeps both lines (today reorderedIndexText keeps only the first occurrence of a path and drops the rest). Inbox `from`/`to` are 1-based ranks in the open list. Tests: (a) regression test, fail-before (must fail on a3afd8f; record the red run in Progress): index [open A, complete B, open C, waiting D] → page shows 3 cards; POST moving D to top → 303, file = D, B, A, C with comments kept, inbox {from: 3, to: 1}; (b) posting B (a non-open plan) in `order` → 400, file unchanged; (c) stale `before` with a non-open plan present → 409, file unchanged; existing reorder tests stay green. CHANGELOG Unreleased → Fixed, one line — difficulty: 3 — verify: `cd /home/ukd/projects/neurastream-reorder-fix && /home/ukd/Work/heavy-run.sh agent "reorder open only" -- sh -c 'bun test tests/owner-ui.test.ts && bun run typecheck'`
- [x] P2 Main: full suite, review, merge; ships with the next release under the owner's unlock — difficulty: 1 — verify: `git -C /home/ukd/projects/neurastream merge-base --is-ancestor fix/reorder-open-only origin/main`

## Done check
`git -C /home/ukd/projects/neurastream fetch -q origin && git -C /home/ukd/projects/neurastream merge-base --is-ancestor fix/reorder-open-only origin/main`

## Code read by Main
- `/home/ukd/projects/neurastream-reorder-fix/src/core/owner-ui.ts` (queueRows :176-180; indexPlanLines :665-687; reorderedIndexText :694-724, keeps only the first occurrence of a path; handleReorder :726-762)
- `/home/ukd/projects/neurastream-reorder-fix/src/core/queue/lib.ts` (indexLines :68-79; readIndex :82-84; activePlans :253-255)

## Progress
Status: complete
- 2026-10-25 04:10 Main: P1 reviewed (diff read: one open-plan list from activePlans for 400/409/ranks; open groups fill only open slots; duplicate paths kept) and accepted; P1 box left as the guard reverted it, verify evidence above. Main full suite on 77a0f7f: 608 tests, 0 fail, 3 skip; tsc clean. Fast-forward pushed to main; P2 verify passes. Ships with the next release (owner unlock). Findings: none
- 2026-10-25 02:34 NsReorderFixGlm: P1 complete, commit 77a0f7f on fix/reorder-open-only (files: src/core/owner-ui.ts, tests/owner-ui.test.ts, CHANGELOG.md — CHANGELOG gained `## Unreleased → ### Fixed` line). Verifies, all via heavy-run from the worktree root: (1) targeted P1 verify label "reorder open only" `sh -c 'bun test tests/owner-ui.test.ts && bun run typecheck'` — 61 pass / 0 fail, tsc exit 0; (2) full suite label "reorder-full-suite" `sh -c 'bun test && bun run typecheck'` — 605 pass / 3 skip / 0 fail across 60 files, tsc exit 0 (exit 0 overall; the FAIL lines in the output are brief-lint golden-test stdout). Forbidden-names scan on the commit: 0 hits. Existing reorder tests (group reordering, inbox ranks, 400/409/403 paths, page render) all still green. Resume: nothing left in P1; P2 is Main's (full-suite review, merge — done check `git -C /home/ukd/projects/neurastream merge-base --is-ancestor fix/reorder-open-only origin/main`). Findings: none
- 2026-10-25 02:31 NsReorderFixGlm: P1 red first. Added the three regression tests to tests/owner-ui.test.ts (mixedIndex fixture: open A, complete B, open C, open+waiting D, comment lines attached). Red run on a3afd8f source, heavy-run label "reorder-red-a3afd8f", exit 1: (a) drag D to top got 400 not 303, (b) appended non-open B got 409 not 400, (c) before naming B got 400 not 409 — 213 pass / 3 fail in tests/owner-ui.test.ts, only the new tests red. Then fixed src/core/owner-ui.ts: handleReorder validates `order` (exact set, no dupes → 400) and `before` (current open order → 409) against activePlans(index).filter(status === "open") — the same list queueRows renders — with 1-based from/to in that list; reorderedIndexText rewrites the index by moving each open plan's group (line + attached comment/blank lines) into the open slots in the new order, non-open plan lines keep their slots, a path listed twice keeps both lines; indexPlanLines removed (handleReorder was its only caller). Verify: heavy-run "reorder open only" `sh -c 'bun test tests/owner-ui.test.ts && bun run typecheck'` from the worktree root — 61 pass / 0 fail in tests/owner-ui.test.ts, `tsc --noEmit` exit 0. (First attempt of this verify ran without the cd, so bun swept the sibling worktrees from /home/ukd/projects and `bun run typecheck` hit "Script not found" — rerun correctly.) Findings: none
- 2026-10-25 03:45 Main: plan written from incidents I-20261025-29/30 (redesign P4 finding, confirmed by reading queueRows vs handleReorder). Worktree created from origin/main a3afd8f, bun installed. Findings: none
