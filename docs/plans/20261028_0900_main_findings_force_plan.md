# Main cannot walk away from a bug it found
Worktree: /home/ukd/Work/neurastream-plan-findings
Branch: feat/plan-findings
Summary: When Main finds a bug, the guards force a plan before Main may stop: Main's own Findings become incidents, offering "want me to plan it?" blocks the stop, and a finding can only be dismissed with the owner's words.

## Goal
- INCIDENT I-20261028-64 and INCIDENT I-20261028-65 (owner, 2026-10-28 ~08:25 / ~08:45): "I want you to be proactively writing bugs and I want you to tell me how it can be deterministically forced upon you" … "I mean to plan bugs … how is one and two going to force you to plan them?" → "do it".
- Today the stop guard already refuses while an incident is open (src/core/guards.ts:1392-1406). The hole: only subagent Findings and owner corrections become incidents, so a bug Main writes down or mentions in chat creates nothing and blocks nothing (2026-10-28: Main wrote the broken PM backup as a Finding at 08:05 and then asked the owner "plan it?").

## Forbidden
- Touching the live setup (~/.omp/agent, ~/.local/bin, ~/.local/state); tests run under a sandbox HOME.
- Harness names in src/core.
- Removing the existing subagent Findings → incident path or the cancel-pending flow.
- Pushing, publishing, `bun add -g`.

## Blockers
- no-push
- blockers/plan-findings-scope.sh
- deny-command --no-verify git\s+add\s+(-A|--all|\.)(\s|$) git\s+push\b npm\s+publish bun\s+add\s+-g

## Phases
- [ ] P1 Main's Findings become incidents: checkMainPlan (src/core/guards.ts:1183) returns ALLOW at :1184 for a Progress-only edit without calling recordFindings (:1133), which runs only for subagents (:1105-1124). Record Main's new Progress entries' Findings items too, kind "main-finding", evidence = plan path + "main". The plan the entry is written in does not count as planning it (Main must run `neurastream incident plan`, the existing path). Red first: a test where Main adds "Findings: bucket missing" and openIncidents (src/core/incidents.ts:131) is empty before the fix, one "main-finding" after. — difficulty: 3 — verify: `bun test tests/plan-findings.test.ts`
- [ ] P2 Offering instead of planning blocks the stop: StopEvent (src/core/adapter.ts:133) gains the reply text Main is stopping with; the omp adapter passes it (src/adapters/omp/index.ts:1003, the `reply` it already holds). checkStop (guards.ts:1373) refuses the stop when the reply offers to plan, matched by one config regex `guards.plan_offer` (default covers "want me to (write|make) a plan", "should I plan", "shall I plan", "if you want, I('ll)? plan", "plan it or"), reason: "don't offer it — write the plan and index it". The two-empty-stops valve (:1393) does not release this block. Red first: stop with reply "backups broken, want me to write a plan?" allowed before, refused after; a reply without the offer is allowed. — difficulty: 3 — verify: `bun test tests/plan-findings.test.ts`
- [ ] P3 A finding is dismissed only with the owner's words: dismissIncident (incidents.ts:199) / dismissIncidentCmd (src/cli/incident.ts:80) refuse kinds "agent-finding" and "main-finding" unless `--owner "<quote>"` is given and the quote is a substring of an owner message the inject hook saw in the last 24 h (the inject event already carries the prompt, guards.ts checkInject; store the owner messages under paths.queue_state). Other kinds keep `--why` only. Red first: dismissing a main-finding with only --why succeeds before, is refused after; with a real owner quote it succeeds. — difficulty: 3 — verify: `bun test tests/plan-findings.test.ts`
- [ ] P4 Docs + release notes: README guard list, docs/config.md for `guards.plan_offer`, templates/config.yml, CHANGELOG entry. — difficulty: 1 — verify: `grep -q plan_offer docs/config.md && grep -q plan_offer templates/config.yml`

## Done check
`cd /home/ukd/Work/neurastream-plan-findings && git merge-base --is-ancestor HEAD origin/main && bun test tests/plan-findings.test.ts`

## Code read by Main
- `src/core/guards.ts`
- `src/core/incidents.ts`
- `src/core/adapter.ts`
- `src/adapters/omp/index.ts`
- `src/cli/incident.ts`

## Progress
Status: open
- 2026-10-28 09:00 Main: plan written after the owner's "do it" (ideas 1 + 2 + owner-only dismiss, offered at ~08:45). Worktree from origin/main 72f5087 (0.2.40); blocker plan-findings-scope clean on the fresh tree. Findings: src/core/guards.ts:1184 Main's Progress-only edits skip recordFindings, so Main's own findings never become incidents; src/core/guards.ts:1393 two empty stop attempts release the open-incident block
