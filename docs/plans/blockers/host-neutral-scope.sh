#!/usr/bin/env bash
# host-neutral-scope.sh: phase-0 blocker for plan 20261026_0010_host_neutral.
# Files changed vs origin/main must stay in scope; core must never gain a harness name or adapter import;
# no stub adapter folders besides omp.
set -uo pipefail
if [ ! -t 0 ]; then
  CALL=$(timeout 2 cat 2>/dev/null || true)
  if [ -n "$CALL" ] && ! printf '%s' "$CALL" | grep -qE 'git[^|;&]*\b(commit|push)\b'; then exit 0; fi
fi
WT=/home/ukd/Work/neurastream-host-neutral
[ -d "$WT" ] || { echo "host-neutral-scope: no worktree"; exit 0; }
cd "$WT" || exit 1
ALLOWED='^(src/adapters/index\.ts|src/adapters/omp/[^/]+\.ts|src/cli/[^/]+\.ts|src/core/adapter\.ts|src/core/config\.ts|tests/[^/]+\.test\.ts|README\.md|CHANGELOG\.md|docs/[^/]+\.md)$'
BASE=$(git merge-base origin/main HEAD 2>/dev/null || echo origin/main)
FILES=$( { git diff --name-only "$BASE"; git ls-files --others --exclude-standard; } 2>/dev/null | sort -u)
rc=0
for f in $FILES; do
  echo "$f" | grep -qE "$ALLOWED" || { echo "OUT OF SCOPE: $f"; rc=1; }
done
if grep -rniwE 'omp|opencode|codex|claude|cursor' src/core >/dev/null 2>&1; then
  echo "host-neutral-scope: src/core names a harness:"; grep -rniwE 'omp|opencode|codex|claude|cursor' src/core | head -5; rc=1
fi
if grep -rnE "from \"(\.\./)+(adapters|cli)/" src/core >/dev/null 2>&1; then
  echo "host-neutral-scope: src/core imports src/adapters or src/cli"; rc=1
fi
for d in src/adapters/*/; do
  [ "$d" = "src/adapters/omp/" ] || { echo "host-neutral-scope: no new adapter folder in this plan: $d"; rc=1; }
done
[ $rc -eq 0 ] && echo "host-neutral-scope: clean"
exit $rc
