#!/usr/bin/env bash
# rate-limit-scope.sh: phase-0 blocker for plan 20261025_0640_rate_limit_resume.
# In /home/ukd/projects/neurastream-rate-limit, files changed vs origin/main (incl. untracked) must stay
# inside the plan's scope, and lines added under src/core/ must not name a harness/provider.
set -uo pipefail
# Called by plan-guard with one tool call on stdin: the tree scan only judges commits/pushes, so a
# red tree never refuses the reads and edits that clean it (I-20261025-70 deadlock). Run with no
# stdin (terminal, Done check) it scans unconditionally.
if [ ! -t 0 ]; then
  CALL=$(timeout 2 cat 2>/dev/null || true)
  if [ -n "$CALL" ] && ! printf '%s' "$CALL" | grep -qE 'git[^|;&]*\b(commit|push)\b'; then exit 0; fi
fi
WT=/home/ukd/projects/neurastream-rate-limit
[ -d "$WT" ] || { echo "rate-limit-scope: no worktree"; exit 0; }
cd "$WT" || exit 1
HARNESS='\b(omp|claude|codex|opencode|anthropic|openrouter|zai|glm|openai|gemini|deepseek)\b'
ALLOWED='^(src/core/rate-limit\.ts|src/core/config\.ts|src/core/guards\.ts|src/adapters/omp/index\.ts|templates/config\.yml|docs/config\.md|README\.md|CHANGELOG\.md|tests/[^/]+\.test\.ts|tests/fixtures/rate-limit/.*|scripts/rate-limit-smoke\.ts)$'
BASE=$(git merge-base origin/main HEAD 2>/dev/null || echo origin/main)
FILES=$( { git diff --name-only "$BASE"; git ls-files --others --exclude-standard; } 2>/dev/null | sort -u)
rc=0
for f in $FILES; do
  if ! echo "$f" | grep -qE "$ALLOWED"; then echo "OUT OF SCOPE: $f"; rc=1; fi
done
added() {
  if git ls-files --error-unmatch "$1" >/dev/null 2>&1; then
    git diff -U0 "$BASE" -- "$1" | grep -E '^\+' | grep -vE '^\+\+\+ ' | cut -c2-
  else
    cat "$1"
  fi
}
for f in $(echo "$FILES" | grep -E '^src/core/.*\.ts$' || true); do
  [ -f "$f" ] || continue
  h=$(added "$f" | grep -iE "$HARNESS" | grep -vE '^\s*(//|\*)' || true)
  [ -n "$h" ] && { echo "HARNESS NAME in core ($f):"; echo "$h" | cut -c1-160; rc=1; }
done
[ $rc -eq 0 ] && echo "rate-limit-scope: clean"
exit $rc
