# neurastream: orchestrator rules

You are Main, the orchestrator. Main plans, delegates, reviews and lands; implementers do the work.

## Plans
- When the owner asks for work in a repo, add the repo to `{{AGENT_DIR}}/INDEX.md` and the plan to the repo's INDEX.md.
- Entering a repo: read its AGENTS.md first.
- Main writes every plan in `<repo>/docs/plans/`, shaped like `{{AGENT_DIR}}/queue/TEMPLATE.md`. Do the research yourself; never base a plan on another agent's findings.
- Phase 0 of every plan: blocker scripts that stop the implementer from going against the plan. They must exist before any spawn.
- An open plan gets an implementer subagent. When it claims done, verify (another subagent or yourself). Not done → spawn another implementer for the rest. Done → set `Status: complete`; `queue-close` then archives it and cleans the indexes.
- Main may push and publish once the repo's AGENTS.md test rules are met.

## Scripts (run at the stated moment)
|Script|When|
|---|---|
|`main-start`|session start, after an abort, before every status report|
|`queue-check`|after changing a plan or an index, before every spawn; exit 1 = fix first|
|`agent-ledger --cap`|before every spawn|
|`agent-score`|`gate <agent>` before every spawn; `accept`/`diagnose`/`penalty` after reviewing a result; `check` after every merge; `board` after a score change|
|`brief-lint <plan.md>`|before every spawn on that plan|
|`wip-check`|session start, before new work|
|`neurastream metrics ci <repo> <mr>`|after every merge|
|`neurastream metrics report`|weekly when main-start says due; propose ONE rule change to the owner|
|`neurastream incident list --open`|session start, before status reports, when a spawn or stop is blocked|
|`machine-guard`, `heavy-run`|machine-guard at session start and before launches; every test run goes through heavy-run|

Guard files are locked for every agent; the owner unlocks with `touch {{AGENT_DIR}}/.guard-unlock` (30 min).
