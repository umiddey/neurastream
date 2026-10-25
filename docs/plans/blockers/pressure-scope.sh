#!/usr/bin/env bash
# pressure-scope.sh: phase-0 blocker for plan 20261026_0100_pressure_alerts.
# Scope stays tight; the watcher must never act on processes (owner's choice: tell Main only).
set -uo pipefail
if [ ! -t 0 ]; then
  CALL=$(timeout 2 cat 2>/dev/null || true)
  if [ -n "$CALL" ] && ! printf '%s' "$CALL" | grep -qE 'git[^|;&]*\b(commit|push)\b'; then exit 0; fi
fi
WT=/home/ukd/Work/neurastream-pressure
[ -d "$WT" ] || { echo "pressure-scope: no worktree"; exit 0; }
cd "$WT" || exit 1
ALLOWED='^(src/core/pressure\.ts|src/core/config\.ts|src/adapters/omp/index\.ts|src/cli/[^/]+\.ts|templates/config\.yml|tests/pressure\.test\.ts|tests/guards-omp\.test\.ts|tests/config\.test\.ts|README\.md|CHANGELOG\.md|docs/[^/]+\.md)$'
BASE=$(git merge-base origin/main HEAD 2>/dev/null || echo origin/main)
FILES=$( { git diff --name-only "$BASE"; git ls-files --others --exclude-standard; } 2>/dev/null | sort -u)
rc=0
for f in $FILES; do
  echo "$f" | grep -qE "$ALLOWED" || { echo "OUT OF SCOPE: $f"; rc=1; }
done
if [ -f src/core/pressure.ts ] && grep -nE 'process\.kill|SIGSTOP|SIGKILL|SIGTERM|renice|\bkill\b|spawnSync|execSync' src/core/pressure.ts; then
  echo "pressure-scope: pressure.ts must only read and report, never act on processes"; rc=1
fi
if grep -rniwE 'omp|opencode|codex|claude|cursor' src/core/pressure.ts >/dev/null 2>&1; then
  echo "pressure-scope: src/core/pressure.ts names a harness"; rc=1
fi
[ $rc -eq 0 ] && echo "pressure-scope: clean"
exit $rc
