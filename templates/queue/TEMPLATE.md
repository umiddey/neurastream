# <short title>
Worktree: <work root>/<repo>-<topic> (configure paths.work_roots, e.g. {{HOME}}/work)
Branch: <type>/<topic>
Summary: <one or two plain sentences: what this plan gives the owner>
PRIORITY-ID: <optional, e.g. PR01>
<!-- One plan = one worktree: this file lives in the main checkout (<main checkout>/docs/plans/), never
     inside its worktree, and the main index (paths.queue_index) lists its absolute path, one line per plan. -->

## Goal
- <owner's words, 1-3 lines: what must be true when this is done>

## Forbidden
- <what the implementer must never do, one per line>

## Blockers
- no-push
- deny-path <glob>
- <plan-specific script relative to this file, e.g. blockers/deny-legacy>

## Phases
- [ ] P1 <what> — difficulty: <N> — verify: `<command that proves P1>`
- [ ] P2 <what> — difficulty: <N> — verify: `<command>`
<!-- difficulty: set by Main at plan time, before any result (agent-score reads it): 1 mechanical · 2 rules · 3 new spec · 4 root-cause · 5 product fix · 8 engine. Owner may override. -->

## Done check
`<one command, run in the worktree; exit 0 = the Goal is met and the work is landed>`

## Code read by Main
<!-- Main lists each file it read to write this plan's code claims, as backticked paths. Required for plans stamped 20261021_0100 or later. -->
- `<path/to/file.ts>`

## Progress
Status: open
<!-- The implementer may only append dated entries here: what was done, what was verified (command +
     result), commits, what is next. It never changes the Status line or adds "WAITING on owner".
     A hold is one line: `WAITING on owner: <what to do> — blocked: <what stays stuck until then> — why you: <why Main cannot do it>` (blocked and why you may be omitted).
     Every new entry ends with a Findings line: "Findings: none", or one item per finding (bug,
     workaround, improvement — any repo) with file:line evidence, items separated by ";". Plan-guard
     restores an entry without it, and each item becomes an incident Main must plan or dismiss.
     Main reviews the work and then writes "Status: complete"; main-guard auto-runs queue-close, which
     closes the plan once the branch is on main and the done check passes (else reopens it), then removes
     the plan's worktree with a plain git worktree remove when it is clean and its branch landed — a dirty,
     unmerged or unremovable worktree (or the repo's main checkout) is kept and the reason printed.
     Owner calls it off: Main writes "Status: cancelled" + "Cancelled by owner: <date> "<words>"";
     queue-close archives it and adds it to docs/plans/CANCELLED.md. A new plan resembling a cancelled
     one is refused until Main checks and writes "False positive: <cancelled file> — <why>". -->

## Background
<!-- optional, at most 40 lines; link a separate file for long context -->
