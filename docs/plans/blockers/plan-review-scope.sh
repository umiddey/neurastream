#!/usr/bin/env bash
# plan-review-scope.sh: phase-0 blocker for plan 20261028_1600_plan_review_gate.
set -uo pipefail
if [ ! -t 0 ]; then
  CALL=$(timeout 2 cat 2>/dev/null || true)
  if [ -n "$CALL" ] && ! printf '%s' "$CALL" | grep -qE 'git[^|;&]*\b(commit|push)\b'; then exit 0; fi
fi
WT=/home/ukd/Work/neurastream-plan-review
[ -d "$WT" ] || { echo "plan-review-scope: no worktree"; exit 0; }
cd "$WT" || exit 1
ALLOWED='^(src/core/(guards|config|brief-lint|mr-sweep|plan-review|plan-approval|queue-check|wip-check|adapter)\.ts|src/core/queue/lib\.ts|src/cli/(commands|guard)\.ts|src/adapters/omp/(index|doctor)\.ts|templates/(AGENTS\.md|config\.yml|plan-review-brief\.md|notes/subagents\.md)|templates/help/[a-z-]+\.txt|tests/[^/]+\.test\.ts|tests/golden/[^/]+\.test\.ts|tests/fixtures/[^ ]+|README\.md|CHANGELOG\.md|docs/config\.md)$'
BASE=$(git merge-base origin/main HEAD 2>/dev/null || echo origin/main)
FILES=$( { git diff --name-only "$BASE"; git ls-files --others --exclude-standard; } 2>/dev/null | sort -u)
rc=0
for f in $FILES; do echo "$f" | grep -qE "$ALLOWED" || { echo "OUT OF SCOPE: $f"; rc=1; }; done
# The PASS record is written by the guard from a subagent's edit only; no code path may let Main write it.
if [ -f src/core/plan-review.ts ] && grep -nE 'agent\s*===\s*"main"[^\n]*record|recordReview\([^)]*main' src/core/plan-review.ts; then echo "plan-review-scope: Main can record a review"; rc=1; fi
# Tests never touch live state or a real forge.
if grep -nE '/home/ukd|gitlab\.com/api|api\.github\.com' tests/plan-review*.test.ts tests/spawn-mr*.test.ts 2>/dev/null; then echo "plan-review-scope: a test names a live path or forge"; rc=1; fi
[ $rc -eq 0 ] && echo "plan-review-scope: clean"
exit $rc
