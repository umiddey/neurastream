#!/usr/bin/env bash
# project-rules-scope.sh: phase-0 blocker for plan 20261027_1530_project_rules.
set -uo pipefail
if [ ! -t 0 ]; then
  CALL=$(timeout 2 cat 2>/dev/null || true)
  if [ -n "$CALL" ] && ! printf '%s' "$CALL" | grep -qE 'git[^|;&]*\b(commit|push)\b'; then exit 0; fi
fi
WT=/home/ukd/Work/neurastream-project-rules
[ -d "$WT" ] || { echo "project-rules-scope: no worktree"; exit 0; }
cd "$WT" || exit 1
ALLOWED='^(src/core/(repo-rules|config)\.ts|src/adapters/omp/[^/]+\.ts|templates/(config\.yml|AGENTS\.md)|tests/[^/]+\.test\.ts|README\.md|CHANGELOG\.md|docs/adapter\.md)$'
BASE=$(git merge-base origin/main HEAD 2>/dev/null || echo origin/main)
FILES=$( { git diff --name-only "$BASE"; git ls-files --others --exclude-standard; } 2>/dev/null | sort -u)
rc=0
for f in $FILES; do echo "$f" | grep -qE "$ALLOWED" || { echo "OUT OF SCOPE: $f"; rc=1; }; done
if [ -f src/core/repo-rules.ts ] && grep -niwE 'omp|opencode|codex|claude|cursor' src/core/repo-rules.ts; then echo "project-rules-scope: core names a harness"; rc=1; fi
if [ -f src/adapters/omp/index.ts ] && grep -n 'Code is a burden' src/adapters/omp/*.ts src/core/*.ts 2>/dev/null; then echo "project-rules-scope: rule text duplicated in code; read it from templates/AGENTS.md"; rc=1; fi
[ $rc -eq 0 ] && echo "project-rules-scope: clean"
exit $rc
