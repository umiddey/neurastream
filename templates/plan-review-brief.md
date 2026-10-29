# Plan review: <plan title>

Read opus-implementer-method.md first.
Plan review: <absolute plan path in its main checkout, e.g. <main checkout>/docs/plans/YYYYMMDD_HHMM_name.md>
Reviewer: read-only — you never edit code, never write repo files, never push, never open an MR. You may write only the plan's `## Progress`, once.
Stop and report within ~20 tool calls.

## Goal
- Review P<n> of the plan against its phases: is it free of redundant, inefficient and insecure work before anyone is spawned on it? Name exactly one unticked phase here (the spawn gate requires it).

## Forbidden
- never push, never open a PR, never edit a file (read-only review)

## Task
1. Read the plan whole, then every file it cites — each `## Reuse` line's `checked: <path>:<n>` opened at that path:line, confirming the cited code is what the line claims.
2. For each unticked phase, grep the repo for code that already does that phase's job; a phase re-doing existing code is redundant.
3. Judge the plan's design for: secrets or credentials in examples, auth and input-trust mistakes, wasteful work (needless dependencies, duplicate state, what an existing guard or config key already covers).

## Report
Append one entry to the plan's `## Progress` — the PASS is recorded by plan-guard from that subagent edit only (Main can never write it), and it expires when the plan text changes:

- <date> <time> <YourName>: PLAN REVIEW: PASS|FAIL — redundant: <finding or none, file:line> — inefficient: <finding or none, file:line> — insecure: <finding or none, file:line>

ending with a `Findings:` line — `Findings: none`, or one item per finding with `file:line` evidence (a FAIL finding opens an incident like any other).

## Acceptance
- the plan's `## Progress` holds the one `PLAN REVIEW:` entry with all three fields and a `Findings:` line
