#!/usr/bin/env bash
# recall-scope.sh: phase-0 blocker for plan 20261109_2335_neurastream_zoom_pointers.
# The owner log is written with appendFileSync only; no direct network or model call; the model is reached only through the adapter's complete.
set -uo pipefail
if [ ! -t 0 ]; then
  CALL=$(timeout 2 cat 2>/dev/null || true)
  if [ -n "$CALL" ] && ! printf '%s' "$CALL" | grep -qE 'git[^|;&]*\b(commit|push)\b'; then exit 0; fi
fi
WT=/home/ukd/Work/neurastream-recall
[ -d "$WT" ] || { echo "recall-scope: no worktree"; exit 0; }
cd "$WT" || exit 1
ALLOWED='^(src/core/(owner-log|owner-topics|guards|adapter|config)\.ts|src/adapters/index\.ts|src/adapters/omp/(index|sessions|adapter|launch)\.ts|src/cli/(recall|dispatch)\.ts|templates/(AGENTS\.md|config\.yml|help/recall\.txt)|tests/[^/]+\.test\.ts|tests/fixtures/recall/.*|README\.md|CHANGELOG\.md|docs/(adapter|config)\.md)$'
BASE=$(git merge-base origin/main HEAD 2>/dev/null || echo origin/main)
FILES=$( { git diff --name-only "$BASE"; git ls-files --others --exclude-standard; } 2>/dev/null | sort -u)
rc=0
for f in $FILES; do echo "$f" | grep -qE "$ALLOWED" || { echo "OUT OF SCOPE: $f"; rc=1; }; done
for f in src/core/owner-log.ts src/core/owner-topics.ts src/cli/recall.ts; do
  [ -f "$f" ] || continue
  if git diff "$BASE" -- "$f" | grep -nE '^\+.*(writeFileSync|renameSync|truncate|rmSync|unlinkSync|\bfetch\()'; then echo "recall-scope: $f must append only, no model or network call"; rc=1; fi
  if [ -z "$(git diff "$BASE" -- "$f")" ] && [ -n "$(git ls-files --others --exclude-standard -- "$f")" ] && grep -nE 'writeFileSync|renameSync|truncate|rmSync|unlinkSync|\bfetch\(' "$f"; then echo "recall-scope: $f must append only, no model or network call"; rc=1; fi
done
[ $rc -eq 0 ] && echo "recall-scope: clean"
exit $rc
