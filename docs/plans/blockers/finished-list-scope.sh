#!/usr/bin/env bash
# finished-list-scope.sh: phase-0 blocker for plan 20261027_1714_finished_list.
set -uo pipefail
if [ ! -t 0 ]; then
  CALL=$(timeout 2 cat 2>/dev/null || true)
  if [ -n "$CALL" ] && ! printf '%s' "$CALL" | grep -qE 'git[^|;&]*\b(commit|push)\b'; then exit 0; fi
fi
WT=/home/ukd/Work/neurastream-finished-list
[ -d "$WT" ] || { echo "finished-list-scope: no worktree"; exit 0; }
cd "$WT" || exit 1
ALLOWED='^(src/core/queue/lib\.ts|src/core/queue-finished\.ts|tests/queue-finished\.test\.ts|CHANGELOG\.md)$'
BASE=$(git merge-base origin/main HEAD 2>/dev/null || echo origin/main)
FILES=$( { git diff --name-only "$BASE"; git ls-files --others --exclude-standard; } 2>/dev/null | sort -u)
rc=0
for f in $FILES; do echo "$f" | grep -qE "$ALLOWED" || { echo "OUT OF SCOPE: $f"; rc=1; }; done
[ $rc -eq 0 ] && echo "finished-list-scope: clean"
exit $rc
