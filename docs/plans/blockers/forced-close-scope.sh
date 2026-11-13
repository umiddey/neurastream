#!/usr/bin/env bash
# forced-close-scope.sh: phase-0 blocker for plan 20261031_0911_forced_close_index_guard.
set -uo pipefail
if [ ! -t 0 ]; then
  CALL=$(timeout 2 cat 2>/dev/null || true)
  if [ -n "$CALL" ] && ! printf '%s' "$CALL" | grep -qE 'git[^|;&]*\b(commit|push)\b'; then exit 0; fi
fi
WT=/home/ukd/Work/neurastream-forced-close
[ -d "$WT" ] || { echo "forced-close-scope: no worktree"; exit 0; }
cd "$WT" || exit 1
ALLOWED='^(src/core/(queue-close|queue-migrate|guards|doctor|config|owner-ui)\.ts|src/core/queue/lib\.ts|src/adapters/omp/index\.ts|src/cli/[^/]+\.ts|bunfig\.toml|package\.json|tests/[^/]+\.test\.ts|tests/golden/[^/]+\.test\.ts|tests/preload\.ts|tests/fixtures/[^ ]+|templates/help/[a-z-]+\.txt|README\.md|CHANGELOG\.md|docs/[^/]+\.md)$'
BASE=$(git merge-base origin/main HEAD 2>/dev/null || echo origin/main)
FILES=$( { git diff --name-only "$BASE"; git ls-files --others --exclude-standard; } 2>/dev/null | sort -u)
rc=0
for f in $FILES; do echo "$f" | grep -qE "$ALLOWED" || { echo "OUT OF SCOPE: $f"; rc=1; }; done
# No restore/snapshot logic (owner rejected it) and no reply-text matching for the lock.
if git diff "$BASE" -- src | grep -nE '^\+.*(restoreIndex|index-snapshot|indexSnapshot)'; then echo "forced-close-scope: restore logic is forbidden"; rc=1; fi
# Exactly one raw write of the index: inside writeIndex. origin/main still has two raw writes
# (queue-close.ts, queue-migrate.ts) that P2 replaces, so the check starts once writeIndex exists.
if grep -qE 'export function writeIndex\b' src/core/queue/lib.ts 2>/dev/null; then
  n=$(grep -rnE 'writeFileSync\((INDEX|index)\b' src 2>/dev/null | grep -v 'src/core/queue/lib.ts' | wc -l)
  [ "$n" -eq 0 ] || { echo "forced-close-scope: raw index write outside writeIndex"; grep -rnE 'writeFileSync\((INDEX|index)\b' src | grep -v src/core/queue/lib.ts; rc=1; }
fi
# Tests must not touch the real home.
if grep -lE 'homedir\(\)|/home/ukd/\.omp' tests/index-guard.test.ts tests/auto-close.test.ts 2>/dev/null; then echo "forced-close-scope: a test names the real home"; rc=1; fi
[ $rc -eq 0 ] && echo "forced-close-scope: clean"
exit $rc
