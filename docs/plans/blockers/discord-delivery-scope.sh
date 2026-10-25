#!/usr/bin/env bash
# discord-delivery-scope.sh: phase-0 blocker for plan 20261025_1435_discord_delivery.
# In /home/ukd/Work/neurastream-discord-delivery, files changed vs origin/main (incl. untracked) must stay
# inside the plan's scope, and no added line may print a webhook URL.
set -uo pipefail
# Called by plan-guard with one tool call on stdin: the tree scan only judges commits/pushes, so a
# red tree never refuses the reads and edits that clean it. Run with no stdin it scans unconditionally.
if [ ! -t 0 ]; then
  CALL=$(timeout 2 cat 2>/dev/null || true)
  if [ -n "$CALL" ] && ! printf '%s' "$CALL" | grep -qE 'git[^|;&]*\b(commit|push)\b'; then exit 0; fi
fi
WT=/home/ukd/Work/neurastream-discord-delivery
[ -d "$WT" ] || { echo "discord-delivery-scope: no worktree"; exit 0; }
cd "$WT" || exit 1
ALLOWED='^(src/core/notify\.ts|src/adapters/omp/index\.ts|README\.md|CHANGELOG\.md|tests/[^/]+\.test\.ts|tests/fixtures/[^ ]+)$'
BASE=$(git merge-base origin/main HEAD 2>/dev/null || echo origin/main)
FILES=$( { git diff --name-only "$BASE"; git ls-files --others --exclude-standard; } 2>/dev/null | sort -u)
rc=0
for f in $FILES; do
  if ! echo "$f" | grep -qE "$ALLOWED"; then echo "OUT OF SCOPE: $f"; rc=1; fi
done
leak=$(git diff -U0 "$BASE" -- src | grep -E '^\+' | grep -E 'discord(app)?\.com/api/webhooks/[0-9]' || true)
[ -n "$leak" ] && { echo "WEBHOOK URL in source:"; echo "$leak" | cut -c1-120; rc=1; }
[ $rc -eq 0 ] && echo "discord-delivery-scope: clean"
exit $rc
