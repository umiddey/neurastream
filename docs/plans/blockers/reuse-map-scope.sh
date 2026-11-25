#!/usr/bin/env bash
# reuse-map-scope.sh: phase-0 blocker for plan 20261122_1828_reuse_map.
# Only the files named in P1-P5 change; src/core stays harness-free; a test never runs
# `uv tool install` without a sandbox UV_TOOL_DIR in the same file.
set -uo pipefail
if [ ! -t 0 ]; then
  CALL=$(timeout 2 cat 2>/dev/null || true)
  if [ -n "$CALL" ] && ! printf '%s' "$CALL" | grep -qE 'git[^|;&]*\b(commit|push)\b'; then exit 0; fi
fi
WT=/home/ukd/Work/neurastream-reuse-map
[ -d "$WT" ] || { echo "reuse-map-scope: no worktree"; exit 0; }
cd "$WT" || exit 1
ALLOWED='^(src/core/(reuse-map|config|setup-detect|uninstall)\.ts|src/core/queue/lib\.ts|src/core/guards/(plan-edit|spawn|planner)\.ts|src/cli/(reuse|dispatch|setup)\.ts|src/adapters/omp/doctor\.ts|templates/config\.yml|templates/help/[^/]+\.txt|tests/[^/]+\.test\.ts|tests/fixtures/graphify/.*|README\.md|CHANGELOG\.md|docs/(config|guards)\.md)$'
BASE=$(git merge-base origin/main HEAD 2>/dev/null || echo origin/main)
FILES=$( { git diff --name-only "$BASE"; git ls-files --others --exclude-standard; } 2>/dev/null | sort -u)
rc=0
for f in $FILES; do echo "$f" | grep -qE "$ALLOWED" || { echo "OUT OF SCOPE: $f"; rc=1; }; done
for f in $FILES; do
  [ -f "$f" ] || continue
  if [ -n "$(git ls-files --others --exclude-standard -- "$f")" ]; then ADDED=$(cat "$f"); else ADDED=$(git diff "$BASE" -- "$f" | grep -E '^\+[^+]' || true); fi
  case "$f" in
    src/core/*) if printf '%s\n' "$ADDED" | grep -nE '\bomp\b|\.omp/|adapters/'; then echo "reuse-map-scope: $f names a harness; src/core stays harness-free"; rc=1; fi ;;
    tests/*.test.ts) if printf '%s\n' "$ADDED" | grep -qE 'uv[^a-z]+tool[^a-z]+install|"tool",\s*"install"' && ! grep -q 'UV_TOOL_DIR' "$f"; then echo "reuse-map-scope: $f runs uv tool install without a sandbox UV_TOOL_DIR"; rc=1; fi ;;
  esac
done
[ $rc -eq 0 ] && echo "reuse-map-scope: clean"
exit $rc
