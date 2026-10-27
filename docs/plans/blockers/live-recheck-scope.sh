#!/usr/bin/env bash
# live-recheck-scope.sh: phase-0 blocker for plan 20261027_0915_live_recheck.
set -uo pipefail
if [ ! -t 0 ]; then
  CALL=$(timeout 2 cat 2>/dev/null || true)
  if [ -n "$CALL" ] && ! printf '%s' "$CALL" | grep -qE 'git[^|;&]*\b(commit|push)\b'; then exit 0; fi
fi
WT=/home/ukd/Work/neurastream-live-recheck
[ -d "$WT" ] || { echo "live-recheck-scope: no worktree"; exit 0; }
cd "$WT" || exit 1
ALLOWED='^(src/core/(waiting-check|queue/lib|owner-ui|main-start|queue-check|rollover|metrics|config|incidents)\.ts|src/adapters/omp/index\.ts|src/cli/[^/]+\.ts|templates/config\.yml|templates/queue/TEMPLATE\.md|tests/[^/]+\.test\.ts|README\.md|CHANGELOG\.md|docs/[^/]+\.md)$'
BASE=$(git merge-base origin/main HEAD 2>/dev/null || echo origin/main)
FILES=$( { git diff --name-only "$BASE"; git ls-files --others --exclude-standard; } 2>/dev/null | sort -u)
rc=0
for f in $FILES; do echo "$f" | grep -qE "$ALLOWED" || { echo "OUT OF SCOPE: $f"; rc=1; }; done
if [ -f src/core/waiting-check.ts ] && grep -niwE 'omp|opencode|codex|claude|cursor' src/core/waiting-check.ts; then echo "live-recheck-scope: core names a harness"; rc=1; fi
if [ -f src/core/waiting-check.ts ] && grep -nE 'writeFileSync\([^)]*plan|replace\([^)]*WAITING' src/core/waiting-check.ts; then echo "live-recheck-scope: never rewrite a plan's WAITING line"; rc=1; fi
[ $rc -eq 0 ] && echo "live-recheck-scope: clean"
exit $rc
