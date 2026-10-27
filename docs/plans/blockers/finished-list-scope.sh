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
ALLOWED='^(src/core/(queue-close|queue-finished|recorded-claim|config|doctor)\.ts|src/core/queue/lib\.ts|src/adapters/omp/[^/]+\.ts|src/cli/[^/]+\.ts|templates/(AGENTS\.md|config\.yml)|templates/help/[a-z-]+\.txt|package\.json|tests/[^/]+\.test\.ts|tests/fixtures/[^ ]+|README\.md|CHANGELOG\.md|docs/[^/]+\.md)$'
BASE=$(git merge-base origin/main HEAD 2>/dev/null || echo origin/main)
FILES=$( { git diff --name-only "$BASE"; git ls-files --others --exclude-standard; } 2>/dev/null | sort -u)
rc=0
for f in $FILES; do echo "$f" | grep -qE "$ALLOWED" || { echo "OUT OF SCOPE: $f"; rc=1; }; done
# Tests must never write the live index or the live finished list.
if grep -nE '/home/ukd|\.omp/agent/(INDEX|FINISHED)\.md' tests/*finished*.test.ts 2>/dev/null; then echo "finished-list-scope: a test names a live path"; rc=1; fi
# An entry is at most 4 lines after its heading; the code must not paste whole plan sections.
if [ -f src/core/queue-finished.ts ] && grep -nE 'Progress[^\n]*join\(|plan\.text\)' src/core/queue-finished.ts | grep -v '//'; then echo "finished-list-scope: entry copies plan text wholesale"; rc=1; fi
[ $rc -eq 0 ] && echo "finished-list-scope: clean"
exit $rc
