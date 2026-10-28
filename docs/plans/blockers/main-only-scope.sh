#!/usr/bin/env bash
# main-only-scope.sh: phase-0 blocker for plan 20261027_1215_main_only.
set -uo pipefail
if [ ! -t 0 ]; then
  CALL=$(timeout 2 cat 2>/dev/null || true)
  if [ -n "$CALL" ] && ! printf '%s' "$CALL" | grep -qE 'git[^|;&]*\b(commit|push)\b'; then exit 0; fi
fi
WT=/home/ukd/Work/neurastream-main-only
[ -d "$WT" ] || { echo "main-only-scope: no worktree"; exit 0; }
cd "$WT" || exit 1
ALLOWED='^(src/adapters/omp/(index|launch|install|doctor)\.ts|src/core/(agents-md|rollover)\.ts|tests/[^/]+\.test\.ts|README\.md|CHANGELOG\.md|docs/adapter\.md)$'
BASE=$(git merge-base origin/main HEAD 2>/dev/null || echo origin/main)
FILES=$( { git diff --name-only "$BASE"; git ls-files --others --exclude-standard; } 2>/dev/null | sort -u)
rc=0
for f in $FILES; do echo "$f" | grep -qE "$ALLOWED" || { echo "OUT OF SCOPE: $f"; rc=1; }; done
# One switch only: the launcher env.
if git diff "$BASE" -- src | grep -E '^\+' | grep -qiE 'main_only|NEURASTREAM_MAIN\b|--main-mode'; then
  echo "main-only-scope: a second Main switch was added; use MAIN_ENV only"; rc=1
fi
if [ -f src/core/agents-md.ts ] && grep -niwE 'omp|opencode|codex|claude|cursor' src/core/agents-md.ts; then echo "main-only-scope: core names a harness"; rc=1; fi
if grep -lE 'homedir\(\)|/home/ukd' tests/omp-main-only.test.ts 2>/dev/null; then echo "main-only-scope: test touches the real home"; rc=1; fi
[ $rc -eq 0 ] && echo "main-only-scope: clean"
exit $rc
