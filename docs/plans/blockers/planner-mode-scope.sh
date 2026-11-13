#!/usr/bin/env bash
# planner-mode-scope.sh: phase-0 blocker for plan 20261102_1515_planner_mode.
set -uo pipefail
if [ ! -t 0 ]; then
  CALL=$(timeout 2 cat 2>/dev/null || true)
  if [ -n "$CALL" ] && ! printf '%s' "$CALL" | grep -qE 'git[^|;&]*\b(commit|push)\b'; then exit 0; fi
fi
WT=/home/ukd/Work/neurastream-planner-mode
[ -d "$WT" ] || { echo "planner-mode-scope: no worktree"; exit 0; }
cd "$WT" || exit 1
ALLOWED='^(src/core/(autonomy|config|guards|plan-approval|config-edit|queue/lib)\.ts|src/cli/(setup|config-set|guard)\.ts|src/adapters/omp/index\.ts|templates/AGENTS\.md|templates/queue/TEMPLATE\.md|templates/config\.yml|tests/planner-mode\.test\.ts|README\.md|CHANGELOG\.md)$'
BASE=$(git merge-base origin/main HEAD 2>/dev/null || echo origin/main)
FILES=$( { git diff --name-only "$BASE"; git ls-files --others --exclude-standard; } 2>/dev/null | sort -u)
rc=0
for f in $FILES; do echo "$f" | grep -qE "$ALLOWED" || { echo "OUT OF SCOPE: $f"; rc=1; }; done
# The mode file and its switch stay owner-only: no tool-call or model-text writer anywhere in the diff.
if grep -rnE 'planner-mode' src/ | grep -vE 'stateDirPath|tierFile|autonomy\.ts|writeFileSync.*owner|chat'; then
  echo "planner-mode-scope: suspicious planner-mode writer (owner paths only)"; rc=1
fi
# Never a second gate: reviewer PASS, page approval, Allowed-list and brief-lint checks are untouched.
if git diff "$BASE" -- src/core/guards.ts | grep -E '^-.*(reviewPassProblem|approvalProblem|allowedAgents)' ; then
  echo "planner-mode-scope: an existing gate was weakened"; rc=1
fi
[ $rc -eq 0 ] && echo "planner-mode-scope: clean"
exit $rc
