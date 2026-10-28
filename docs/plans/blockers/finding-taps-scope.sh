#!/usr/bin/env bash
# finding-taps-scope.sh: phase-0 blocker for plan 20261028_1135_finding_taps.
set -uo pipefail
if [ ! -t 0 ]; then
  CALL=$(timeout 2 cat 2>/dev/null || true)
  if [ -n "$CALL" ] && ! printf '%s' "$CALL" | grep -qE 'git[^|;&]*\b(commit|push)\b'; then exit 0; fi
fi
WT=/home/ukd/Work/neurastream-finding-taps
[ -d "$WT" ] || { echo "finding-taps-scope: no worktree"; exit 0; }
cd "$WT" || exit 1
ALLOWED='^(src/core/(incidents|owner-ui)\.ts|src/cli/incident\.ts|tests/[^/]+\.test\.ts|README\.md|CHANGELOG\.md)$'
BASE=$(git merge-base origin/main HEAD 2>/dev/null || echo origin/main)
FILES=$( { git diff --name-only "$BASE"; git ls-files --others --exclude-standard; } 2>/dev/null | sort -u)
rc=0
for f in $FILES; do echo "$f" | grep -qE "$ALLOWED" || { echo "OUT OF SCOPE: $f"; rc=1; }; done
if grep -niwE 'omp|opencode|codex|claude|cursor' src/core/incidents.ts src/core/owner-ui.ts 2>/dev/null | grep -vE '^\S+:[0-9]+:\s*(//|\*)'; then echo "finding-taps-scope: core names a harness"; rc=1; fi
# The CLI must never gain a way to fake the owner's tap.
if grep -nE 'tap' src/cli/incident.ts 2>/dev/null; then echo "finding-taps-scope: the CLI names a tap"; rc=1; fi
[ $rc -eq 0 ] && echo "finding-taps-scope: clean"
exit $rc
