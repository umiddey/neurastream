#!/usr/bin/env bash
# main-budget-scope.sh: phase-0 blocker for plan 20261028_1545_main_call_budget.
set -uo pipefail
if [ ! -t 0 ]; then
  CALL=$(timeout 2 cat 2>/dev/null || true)
  if [ -n "$CALL" ] && ! printf '%s' "$CALL" | grep -qE 'git[^|;&]*\b(commit|push)\b'; then exit 0; fi
fi
WT=/home/ukd/Work/neurastream-main-budget
[ -d "$WT" ] || { echo "main-budget-scope: no worktree"; exit 0; }
cd "$WT" || exit 1
ALLOWED='^(src/core/(guards|config|owner-ui|notify|metrics|main-cost-alarm|main-call-budget)\.ts|src/adapters/omp/[^/]+\.ts|templates/(AGENTS\.md|config\.yml)|templates/help/[a-z-]+\.txt|tests/[^/]+\.test\.ts|tests/fixtures/[^ ]+|README\.md|CHANGELOG\.md|docs/config\.md)$'
BASE=$(git merge-base origin/main HEAD 2>/dev/null || echo origin/main)
FILES=$( { git diff --name-only "$BASE"; git ls-files --others --exclude-standard; } 2>/dev/null | sort -u)
rc=0
for f in $FILES; do echo "$f" | grep -qE "$ALLOWED" || { echo "OUT OF SCOPE: $f"; rc=1; }; done
# Thresholds come from config: no numeric literal compared against a call count or a percentage in the new code.
for f in src/core/main-call-budget.ts src/core/main-cost-alarm.ts; do
  [ -f "$f" ] && grep -nE '(calls?|count|pct|percent|limit)[A-Za-z]*\s*(>=|>|<=|<|===)\s*[0-9]{2,}' "$f" && { echo "main-budget-scope: hard-coded threshold in $f"; rc=1; }
done
# Tests never touch the live state dir or post to a real webhook.
if grep -nE '/home/ukd|discord\.com/api/webhooks' tests/main-call-budget.test.ts tests/main-cost-alarm.test.ts 2>/dev/null; then echo "main-budget-scope: a test names a live path or webhook"; rc=1; fi
[ $rc -eq 0 ] && echo "main-budget-scope: clean"
exit $rc
