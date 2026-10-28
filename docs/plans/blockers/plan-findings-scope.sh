#!/usr/bin/env bash
# plan-findings-scope.sh: phase-0 blocker for plan 20261028_0900_main_findings_force_plan.
set -uo pipefail
if [ ! -t 0 ]; then
  CALL=$(timeout 2 cat 2>/dev/null || true)
  if [ -n "$CALL" ] && ! printf '%s' "$CALL" | grep -qE 'git[^|;&]*\b(commit|push)\b'; then exit 0; fi
fi
WT=/home/ukd/Work/neurastream-plan-findings
[ -d "$WT" ] || { echo "plan-findings-scope: no worktree"; exit 0; }
cd "$WT" || exit 1
ALLOWED='^(src/core/(guards|incidents|adapter|config)\.ts|src/cli/(incident|guard)\.ts|src/adapters/omp/index\.ts|templates/config\.yml|tests/[^/]+\.test\.ts|README\.md|CHANGELOG\.md|docs/(config|adapter)\.md)$'
BASE=$(git merge-base origin/main HEAD 2>/dev/null || echo origin/main)
FILES=$( { git diff --name-only "$BASE"; git ls-files --others --exclude-standard; } 2>/dev/null | sort -u)
rc=0
for f in $FILES; do echo "$f" | grep -qE "$ALLOWED" || { echo "OUT OF SCOPE: $f"; rc=1; }; done
if grep -niwE 'omp|opencode|codex|claude|cursor' src/core/guards.ts src/core/incidents.ts 2>/dev/null | grep -vE '^\S+:[0-9]+:\s*(//|\*)'; then echo "plan-findings-scope: core names a harness"; rc=1; fi
[ $rc -eq 0 ] && echo "plan-findings-scope: clean"
exit $rc
