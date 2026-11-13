#!/usr/bin/env bash
# stop-valve-scope.sh: phase-0 blocker for plan 20261031_2320_stop_lock_valve.
set -uo pipefail
if [ ! -t 0 ]; then
  CALL=$(timeout 2 cat 2>/dev/null || true)
  if [ -n "$CALL" ] && ! printf '%s' "$CALL" | grep -qE 'git[^|;&]*\b(commit|push)\b'; then exit 0; fi
fi
WT=/home/ukd/Work/neurastream-stop-valve
[ -d "$WT" ] || { echo "stop-valve-scope: no worktree"; exit 0; }
cd "$WT" || exit 1
ALLOWED='^(src/core/guards\.ts|src/core/queue/lib\.ts|tests/(guards|auto-close)\.test\.ts|package\.json|CHANGELOG\.md)$'
BASE=$(git merge-base origin/main HEAD 2>/dev/null || echo origin/main)
FILES=$( { git diff --name-only "$BASE"; git ls-files --others --exclude-standard; } 2>/dev/null | sort -u)
rc=0
for f in $FILES; do echo "$f" | grep -qE "$ALLOWED" || { echo "OUT OF SCOPE: $f"; rc=1; }; done
[ $rc -eq 0 ] && echo "stop-valve-scope: clean"
exit $rc
