#!/usr/bin/env bash
# planner-punchlist-scope.sh: phase-0 blocker for plan 20261102_2315_planner_punchlist.
set -uo pipefail
if [ ! -t 0 ]; then
  CALL=$(timeout 2 cat 2>/dev/null || true)
  if [ -n "$CALL" ] && ! printf '%s' "$CALL" | grep -qE 'git[^|;&]*\b(commit|push)\b'; then exit 0; fi
fi
WT=/home/ukd/Work/neurastream-planner-punchlist
[ -d "$WT" ] || { echo "planner-punchlist-scope: no worktree"; exit 0; }
cd "$WT" || exit 1
# Every src/tests path the plan's brief names. src/core/plan-approval.ts is named read-only:
# the scan allows it so brief-lint's ALLOWED cross-check passes, but any DIFF to it is refused
# below — reviewHash/approvalProblem are the page-approval seam and stay untouched.
ALLOWED='^(src/core/(guards|plan-approval)\.ts|templates/AGENTS\.md|tests/(planner-mode|guards)\.test\.ts|README\.md|CHANGELOG\.md|package\.json)$'
BASE=$(git merge-base origin/main HEAD 2>/dev/null || echo origin/main)
FILES=$( { git diff --name-only "$BASE"; git ls-files --others --exclude-standard; } 2>/dev/null | sort -u)
rc=0
for f in $FILES; do echo "$f" | grep -qE "$ALLOWED" || { echo "OUT OF SCOPE: $f"; rc=1; }; done
# Never a second gate: reviewer PASS, page approval and the Allowed list stay untouched in guards.ts.
if git diff "$BASE" -- src/core/guards.ts | grep -E '^-.*(reviewPassProblem|approvalProblem|allowedAgents)'; then
  echo "planner-punchlist-scope: an existing gate was weakened"; rc=1
fi
# The reviewHash seam never changes at all: the exemption masks plannerBody only.
if git diff "$BASE" -- src/core/plan-approval.ts | grep -q .; then
  echo "planner-punchlist-scope: src/core/plan-approval.ts (reviewHash seam) is out of scope"; rc=1
fi
[ $rc -eq 0 ] && echo "planner-punchlist-scope: clean"
exit $rc
