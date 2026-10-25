#!/usr/bin/env bash
# golden-clock-scope.sh: phase-0 blocker for plan 20261025_1225_golden_priority_watch_clock.
# In /home/ukd/Work/neurastream-golden-clock, files changed vs origin/main (incl. untracked) must stay
# inside the plan's scope: the fix is test-only, src/ must not change.
set -uo pipefail
# Called by plan-guard with one tool call on stdin: only commits/pushes are judged, so a red tree never
# refuses the reads and edits that clean it. Run with no stdin (terminal, Done check) it scans always.
if [ ! -t 0 ]; then
  CALL=$(timeout 2 cat 2>/dev/null || true)
  if [ -n "$CALL" ] && ! printf '%s' "$CALL" | grep -qE 'git[^|;&]*\b(commit|push)\b'; then exit 0; fi
fi
WT=/home/ukd/Work/neurastream-golden-clock
[ -d "$WT" ] || { echo "golden-clock-scope: no worktree"; exit 0; }
cd "$WT" || exit 1
ALLOWED='^(tests/golden/ports-p4\.test\.ts|CHANGELOG\.md)$'
BASE=$(git merge-base origin/main HEAD 2>/dev/null || echo origin/main)
FILES=$( { git diff --name-only "$BASE"; git ls-files --others --exclude-standard; } 2>/dev/null | sort -u)
rc=0
for f in $FILES; do
  if ! echo "$f" | grep -qE "$ALLOWED"; then echo "OUT OF SCOPE: $f"; rc=1; fi
done
[ $rc -eq 0 ] && echo "golden-clock-scope: clean"
exit $rc
