#!/usr/bin/env bash
# plan-read-ease-scope.sh: phase-0 blocker for plan 20261025_2335_plan_read_ease.
# Files changed vs origin/main must stay in scope; the refusal for a truly unread file must stay.
set -uo pipefail
if [ ! -t 0 ]; then
  CALL=$(timeout 2 cat 2>/dev/null || true)
  if [ -n "$CALL" ] && ! printf '%s' "$CALL" | grep -qE 'git[^|;&]*\b(commit|push)\b'; then exit 0; fi
fi
WT=/home/ukd/Work/neurastream-plan-read-ease
[ -d "$WT" ] || { echo "plan-read-ease-scope: no worktree"; exit 0; }
cd "$WT" || exit 1
ALLOWED='^(src/core/guards\.ts|src/adapters/omp/index\.ts|src/cli/guard\.ts|src/core/queue/lib\.ts|src/core/owner-ui\.ts|tests/plan-read-section\.test\.ts|tests/guards-omp\.test\.ts|tests/one-index\.test\.ts|tests/queue-summary\.test\.ts|tests/owner-ui\.test\.ts|README\.md|CHANGELOG\.md|docs/[^/]+\.md)$'
BASE=$(git merge-base origin/main HEAD 2>/dev/null || echo origin/main)
FILES=$( { git diff --name-only "$BASE"; git ls-files --others --exclude-standard; } 2>/dev/null | sort -u)
rc=0
for f in $FILES; do
  echo "$f" | grep -qE "$ALLOWED" || { echo "OUT OF SCOPE: $f"; rc=1; }
done
# The unread-file refusal must survive: its message text stays in guards.ts.
if [ -f src/core/guards.ts ] && ! grep -q 'was not read by Main within' src/core/guards.ts; then
  echo "plan-read-ease-scope: the refusal for a file Main never read was removed"; rc=1
fi
[ $rc -eq 0 ] && echo "plan-read-ease-scope: clean"
exit $rc
