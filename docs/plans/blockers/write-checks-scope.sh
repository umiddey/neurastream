#!/usr/bin/env bash
# write-checks-scope.sh: phase-0 blocker for plan 20261028_1228_write_time_checks.
set -uo pipefail
if [ ! -t 0 ]; then
  CALL=$(timeout 2 cat 2>/dev/null || true)
  if [ -n "$CALL" ] && ! printf '%s' "$CALL" | grep -qE 'git[^|;&]*\b(commit|push)\b'; then exit 0; fi
fi
WT=/home/ukd/Work/neurastream-write-checks
[ -d "$WT" ] || { echo "write-checks-scope: no worktree"; exit 0; }
cd "$WT" || exit 1
ALLOWED='^(src/core/(write-check|config|guards|blockers)\.ts|src/adapters/omp/index\.ts|templates/config\.yml|docs/(config|adapter)\.md|tests/[^/]+\.test\.ts|tests/fixtures/write-check/.+|README\.md|CHANGELOG\.md)$'
BASE=$(git merge-base origin/main HEAD 2>/dev/null || echo origin/main)
FILES=$( { git diff --name-only "$BASE"; git ls-files --others --exclude-standard; } 2>/dev/null | sort -u)
rc=0
for f in $FILES; do echo "$f" | grep -qE "$ALLOWED" || { echo "OUT OF SCOPE: $f"; rc=1; }; done
# Core stays harness-neutral.
if grep -niwE 'omp|opencode|codex|claude|cursor' src/core/write-check.ts 2>/dev/null | grep -vE '^[0-9]+:\s*(//|\*)'; then echo "write-checks-scope: core names a harness"; rc=1; fi
# The public template ships the check off.
if [ -f templates/config.yml ] && awk '/^write_check:/{f=1;next} /^[^ #]/{f=0} f && /^  enabled:/' templates/config.yml | grep -q true; then echo "write-checks-scope: template turns write_check on"; rc=1; fi
# Linters run as argv arrays, never through a shell.
if grep -nE 'shell:\s*true|\bsh\s+-c\b|bash\s+-c' src/core/write-check.ts 2>/dev/null; then echo "write-checks-scope: linter runs through a shell"; rc=1; fi
[ $rc -eq 0 ] && echo "write-checks-scope: clean"
exit $rc
