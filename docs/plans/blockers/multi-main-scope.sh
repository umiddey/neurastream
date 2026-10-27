#!/usr/bin/env bash
# multi-main-scope.sh: phase-0 blocker.
set -uo pipefail
if [ ! -t 0 ]; then
  CALL=$(timeout 2 cat 2>/dev/null || true)
  if [ -n "$CALL" ] && ! printf '%s' "$CALL" | grep -qE 'git[^|;&]*\b(commit|push)\b'; then exit 0; fi
fi
WT=/home/ukd/Work/neurastream-multi-main
[ -d "$WT" ] || { echo "multi-main-scope: no worktree"; exit 0; }
cd "$WT" || exit 1
ALLOWED='^(src/core/(claims|guards|config|main-start|owner-ui|owner-inbox|notify|rollover|queue-close|queue-check)\.ts|src/core/queue/lib\.ts|src/adapters/omp/(index|launch)\.ts|src/cli/[^/]+\.ts|templates/config\.yml|templates/help/[^/]+\.txt|tests/[^/]+\.test\.ts|README\.md|CHANGELOG\.md|docs/[^/]+\.md|package\.json)$'
BASE=$(git merge-base origin/main HEAD 2>/dev/null || echo origin/main)
FILES=$( { git diff --name-only "$BASE"; git ls-files --others --exclude-standard; } 2>/dev/null | sort -u)
rc=0
for f in $FILES; do echo "$f" | grep -qE "$ALLOWED" || { echo "OUT OF SCOPE: $f"; rc=1; }; done
for f in $(echo "$FILES" | grep -E '^src/core/.*\.ts$'); do
  [ -f "$f" ] || continue
  if grep -niwE 'omp|opencode|codex|claude|cursor' "$f"; then echo "multi-main-scope: $f names a harness"; rc=1; fi
done
if echo "$FILES" | grep -E '^tests/' | xargs -r grep -lE 'homedir\(\)|/home/ukd' 2>/dev/null; then echo "multi-main-scope: a test touches the real home"; rc=1; fi
# Atomic claims only.
if [ -f src/core/claims.ts ] && ! grep -qE 'O_EXCL|"wx"|linkSync|BEGIN' src/core/claims.ts; then echo "multi-main-scope: claims.ts has no atomic create"; rc=1; fi
[ $rc -eq 0 ] && echo "multi-main-scope: clean"
exit $rc
