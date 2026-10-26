#!/usr/bin/env bash
# results-scope.sh: phase-0 blocker for plan 20261025_2148_feature_results.
# In /home/ukd/Work/neurastream-results, files changed vs origin/main (incl. untracked) must stay
# inside the plan's scope, and lines added under src/core/ must not name a harness/provider.
set -uo pipefail
# Only commits/pushes are judged when called by plan-guard with a tool call on stdin (I-20261025-70).
if [ ! -t 0 ]; then
  CALL=$(timeout 2 cat 2>/dev/null || true)
  if [ -n "$CALL" ] && ! printf '%s' "$CALL" | grep -qE 'git[^|;&]*\b(commit|push)\b'; then exit 0; fi
fi
WT=/home/ukd/Work/neurastream-results
[ -d "$WT" ] || { echo "results-scope: no worktree"; exit 0; }
cd "$WT" || exit 1
HARNESS='\b(omp|claude|codex|opencode|anthropic|openrouter|zai|glm|openai|gemini|deepseek)\b'
ALLOWED='^(src/core/adapter\.ts|src/adapters/omp/sessions\.ts|src/core/results\.ts|src/core/metrics\.ts|src/cli/metrics\.ts|src/core/owner-ui\.ts|src/core/config\.ts|src/core/help\.ts|scripts/ui-preview\.ts|templates/config\.yml|docs/config\.md|README\.md|CHANGELOG\.md|tests/results[a-z-]*\.test\.ts|tests/owner-ui\.test\.ts|tests/metrics\.test\.ts|tests/fixtures/results/.*|docs/plans/20261025_2148_feature_results\.md)$'
BASE=$(git merge-base origin/main HEAD 2>/dev/null || echo origin/main)
FILES=$( { git diff --name-only "$BASE"; git ls-files --others --exclude-standard; } 2>/dev/null | sort -u)
rc=0
for f in $FILES; do
  if ! echo "$f" | grep -qE "$ALLOWED"; then echo "OUT OF SCOPE: $f"; rc=1; fi
done
for f in $(echo "$FILES" | grep -E '^src/core/.*\.ts$' || true); do
  [ -f "$f" ] || continue
  h=$(git diff -U0 "$BASE" -- "$f" | grep -E '^\+' | grep -vE '^\+\+\+ ' | cut -c2- | grep -iE "$HARNESS" | grep -vE '^\s*(//|\*)' || true)
  [ -n "$h" ] && { echo "HARNESS NAME in core ($f):"; echo "$h" | cut -c1-160; rc=1; }
done
[ $rc -eq 0 ] && echo "results-scope: clean"
exit $rc
