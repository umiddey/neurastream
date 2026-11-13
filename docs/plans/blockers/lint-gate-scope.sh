#!/usr/bin/env bash
# lint-gate-scope.sh: phase-0 blocker for plan 20261028_1530_lint_gate.
set -uo pipefail
if [ ! -t 0 ]; then
  CALL=$(timeout 2 cat 2>/dev/null || true)
  if [ -n "$CALL" ] && ! printf '%s' "$CALL" | grep -qE 'git[^|;&]*\b(commit|push)\b'; then exit 0; fi
fi
WT=/home/ukd/Work/neurastream-lint-gate
[ -d "$WT" ] || { echo "lint-gate-scope: no worktree"; exit 0; }
cd "$WT" || exit 1
ALLOWED='^(\.oxlintrc\.json|package\.json|bun\.lock|\.github/workflows/ci\.yml|src/.+\.ts|tests/.+\.ts|bin/[a-z-]+|CHANGELOG\.md|README\.md|AGENTS\.md)$'
BASE=$(git merge-base origin/main HEAD 2>/dev/null || echo origin/main)
FILES=$( { git diff --name-only "$BASE"; git ls-files --others --exclude-standard; } 2>/dev/null | sort -u)
rc=0
for f in $FILES; do echo "$f" | grep -qE "$ALLOWED" || { echo "OUT OF SCOPE: $f"; rc=1; }; done
# Findings are fixed, never silenced: no new disable comments, no rule turned off in the config.
if git diff "$BASE" -- src tests bin | grep -nE '^\+.*(oxlint-disable|eslint-disable|biome-ignore|@ts-ignore|@ts-expect-error|@ts-nocheck)'; then echo "lint-gate-scope: a diff line silences a finding"; rc=1; fi
if [ -f .oxlintrc.json ] && grep -nE '"(off|allow)"|: *0\b' .oxlintrc.json; then echo "lint-gate-scope: .oxlintrc.json turns a rule off"; rc=1; fi
[ $rc -eq 0 ] && echo "lint-gate-scope: clean"
exit $rc
