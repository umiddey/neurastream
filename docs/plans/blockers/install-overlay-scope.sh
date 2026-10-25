#!/usr/bin/env bash
# install-overlay-scope.sh: phase-0 blocker for plan 20261025_0830_install_overlay_protected.
# In /home/ukd/projects/neurastream-install-overlay, files changed vs origin/main (incl. untracked)
# must stay inside the plan's scope. Called by plan-guard with one tool call on stdin: the scan
# only judges commits/pushes, so a red tree never refuses the calls that clean it.
set -uo pipefail
if [ ! -t 0 ]; then
  CALL=$(timeout 2 cat 2>/dev/null || true)
  if [ -n "$CALL" ] && ! printf '%s' "$CALL" | grep -qE 'git[^|;&]*\b(commit|push)\b'; then exit 0; fi
fi
WT=/home/ukd/projects/neurastream-install-overlay
[ -d "$WT" ] || { echo "install-overlay-scope: no worktree"; exit 0; }
cd "$WT" || exit 1
ALLOWED='^(src/adapters/omp/install\.ts|tests/install-overlay\.test\.ts|CHANGELOG\.md)$'
BASE=$(git merge-base origin/main HEAD 2>/dev/null || echo origin/main)
FILES=$( { git diff --name-only "$BASE"; git ls-files --others --exclude-standard; } 2>/dev/null | sort -u)
rc=0
for f in $FILES; do
  if ! echo "$f" | grep -qE "$ALLOWED"; then echo "OUT OF SCOPE: $f"; rc=1; fi
done
[ $rc -eq 0 ] && echo "install-overlay-scope: clean"
exit $rc
