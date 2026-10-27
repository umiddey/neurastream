# Plan history guard: Main reads the plans behind the code (plantrail) before planning; closed plans list the code they changed
Worktree: /home/ukd/Work/neurastream-plan-history
Branch: feat/plan-history
Summary: Before I plan, I must read the old plans behind the code I'm about to change, so I know why it was built that way.
Waits on: /home/ukd/projects/doctrail/docs/plans/20261025_1440_doctrail_v1.md

## Goal
- INCIDENT I-20261025-153 (owner correction, 2026-10-25 ~14:20): "You've got to tell me why the design was changed, was there a reason behind that. And also, why did you miss this while you were planning?" Main had planned CP host monitoring from code and rules only and missed the 2026-08-09 design decision (infra plan Phase 2, commit 9d8fc7b4: each app's own Prometheus watches its host). The reason was in an old plan and a commit message; nothing made Main read them.
- Owner (2026-10-25 ~14:40): plans and code linked both ways, time ordered, by a separate tool in the same family, with "neurastream … one of the consumers". The tool is plantrail (plan above). This plan is the consumer side.
- Done = (1) plan-guard refuses a new Main plan unless every file under `## Code read by Main` also had `plantrail why <file>` run by Main within `guards.plan_read_max_hours`, and the plan has a `## History read by Main` section naming every plan ID those runs printed (or `none` for a file with no history); (2) queue-check requires a `Branch:` line on new plans (plantrail's hook maps branch → plan, so implementer commits get the `Plan:` trailer with no brief change); (3) queue-close writes a `## Code changed` section into a plan it closes, from `plantrail code <plan-id>`; (4) `neurastream doctor` fails when plantrail is missing or its hooks are not installed in a repo that has an indexed plan.

## Forbidden
- Read /home/ukd/projects/neurastream/AGENTS.md first.
- Work only in /home/ukd/Work/neurastream-plan-history on feat/plan-history. Never push, merge, tag or publish (Main does; releases only by tag push under the owner's unlock). Commit files by name; never `git add -A`/`.`; never `--no-verify`.
- No harness or provider names in src/core (the blocker checks added lines).
- Old plans are grandfathered by a stamp cutover, as `READ_CUTOVER` does today (/home/ukd/projects/neurastream/src/core/queue/lib.ts:31-33); never make an existing indexed plan fail queue-check.
- neurastream calls the `plantrail` binary (no import, no copy of its code); when it is missing, guards print the install line instead of crashing.
- Every test run via `/home/ukd/Work/heavy-run.sh <agent> "<label>" -- <cmd>` with tool timeout 0.
- Call budget: stop and report within ~90 calls. One dated bullet under `## Progress` after the `Status:` line, ending with `Findings:`.

## Blockers
- no-push
- blockers/plan-history-scope.sh
- deny-path /home/ukd/.omp/agent/** /home/ukd/.bun/** /home/ukd/.local/state/** /home/ukd/.local/bin/**
- deny-command --no-verify git\s+add\s+(-A|--all|\.)(\s|$) git\s+push\b git\s+merge\b git\s+tag\b npm\s+publish reset\s+--hard

## Phases
- [ ] P1 History read gate. Record: Main's shell call `plantrail why <file>…` that exits 0 logs, per file, the time and the plan IDs its output printed (IDs match `\d{8}_\d{4}_[\w.-]+`) into `main-why.json` in the queue state dir, next to `main-reads.json` (/home/ukd/projects/neurastream/src/core/guards.ts:765-793; the result hook is `recordMainResult`, :811-815). Check: extend `planReadProblems` (/home/ukd/projects/neurastream/src/core/guards.ts:1013-1034) for plans stamped at or after a new `HISTORY_CUTOVER` (the stamp of the commit date, e.g. `20261026_0000`): each listed file needs a why-run within `plan_read_max_hours`, and the `## History read by Main` section must name each printed plan ID (`none` allowed only when the run printed none). The refusal text says which file to run `plantrail why` on. queue lib: add `history read by main` to the known sections (/home/ukd/projects/neurastream/src/core/queue/lib.ts:196-199) and require it after the cutover; require a `Branch:` line after the cutover. Add both to templates/queue/TEMPLATE.md. Tests in tests/ for: missing run refused, run present but an ID missing refused, all IDs named allowed, old stamp grandfathered, missing binary gives the install hint. — difficulty: 3 — verify: `cd /home/ukd/Work/neurastream-plan-history && /home/ukd/Work/heavy-run.sh agent "ns plan history p1" -- bun test && bash /home/ukd/projects/neurastream/docs/plans/blockers/plan-history-scope.sh </dev/null`
- [ ] P2 Code changed + doctor. queue-close: when it closes a plan (branch landed, done check passed), run `plantrail code <plan-id> --repo <the plan's main checkout>` and write its file list and commits into a `## Code changed` section (known section, Main-only like Progress status lines); no plantrail → leave the plan as it is and print the install hint. doctor: one check that `plantrail` is on PATH and `plantrail install --check` passes in each repo with an indexed plan; the fix line is `plantrail install` in that repo. Tests for both, with plantrail stubbed on PATH. Docs (README guard table, CHANGELOG). — difficulty: 2 — verify: `cd /home/ukd/Work/neurastream-plan-history && /home/ukd/Work/heavy-run.sh agent "ns plan history p2" -- bun test`
- [ ] P3 Main: after plantrail v0.1.0 is installed, merge, release under the owner's unlock, `bun add -g neurastream@latest`, `neurastream doctor` exit 0, run `plantrail install` in CP, PM, infra, neurastream and clanky main checkouts; the next new Main plan must pass the gate (smoke). — difficulty: 2 — verify: `neurastream doctor`

## Done check
`cd /home/ukd/Work/neurastream-plan-history && git fetch -q origin && git merge-base --is-ancestor HEAD origin/main && neurastream doctor`

## Code read by Main
- `/home/ukd/projects/neurastream/src/core/guards.ts` (main-reads log :765-793; recordMainResult :811-815; checkMainPlan/planReadProblems :990-1034; Main read recording :733-745)
- `/home/ukd/projects/neurastream/src/core/queue/lib.ts` (READ_CUTOVER :31-33; known sections :190-199; Waits on parse :232)
- `/home/ukd/projects/neurastream/templates/config.yml` (plan_read_max_hours :110)
- `/home/ukd/.omp/agent/queue/TEMPLATE.md`

## Progress
Status: open
- 2026-10-25 ~14:50 Main: plan written for INCIDENT I-20261025-153 and the owner's plan↔code idea; worktree from origin/main 685ac36; blocker clean. Waits on plantrail v1 (its binary must exist first). Findings: none
- 2026-10-25 14:30 Main: the owner renamed the tool away from "plantrail" (working name doctrail; final name still being chosen). Repo moved to /home/ukd/projects/doctrail, plan file renamed; the `plantrail` command names in this plan change with the final name. Findings: none
