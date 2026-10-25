#!/usr/bin/env bash
# autonomy-tiers-scope.sh: phase-0 blocker for plan 20261025_1940_autonomy_tiers.
# In /home/ukd/Work/neurastream-autonomy-tiers, files changed vs origin/main (incl. untracked) must stay
# inside the plan's scope, and the owner-only rules (protected files, owner page start, notify
# secrets, unlock) are never touched: no tier may loosen them.
set -uo pipefail
# Called by plan-guard with one tool call on stdin: the tree scan only judges commits/pushes.
if [ ! -t 0 ]; then
  CALL=$(timeout 2 cat 2>/dev/null || true)
  if [ -n "$CALL" ] && ! printf '%s' "$CALL" | grep -qE 'git[^|;&]*\b(commit|push)\b'; then exit 0; fi
fi
WT=/home/ukd/Work/neurastream-autonomy-tiers
[ -d "$WT" ] || { echo "autonomy-tiers-scope: no worktree"; exit 0; }
cd "$WT" || exit 1
ALLOWED='^(src/core/autonomy\.ts|src/core/guards\.ts|src/core/config\.ts|src/core/owner-ui\.ts|src/adapters/omp/index\.ts|templates/config\.yml|templates/AGENTS\.md|README\.md|CHANGELOG\.md|docs/config\.md|tests/[^/]+\.test\.ts)$'
BASE=$(git merge-base origin/main HEAD 2>/dev/null || echo origin/main)
FILES=$( { git diff --name-only "$BASE"; git ls-files --others --exclude-standard; } 2>/dev/null | sort -u)
rc=0
for f in $FILES; do
  if ! echo "$f" | grep -qE "$ALLOWED"; then echo "OUT OF SCOPE: $f"; rc=1; fi
done
owner=$(git diff -U0 "$BASE" -- src/core/guards.ts src/core/owner-ui.ts | grep -E '^[-+]' | grep -vE '^(\+\+\+|---)' | grep -E '^-.*(startsOwnerUi|protectedHit|notifySecretReadHit|unlocked\(|isLoopback|isTailnet|whois|owner_login)' || true)
[ -n "$owner" ] && { echo "OWNER-ONLY RULE LINES REMOVED/CHANGED:"; echo "$owner" | cut -c1-140; rc=1; }
[ $rc -eq 0 ] && echo "autonomy-tiers-scope: clean"
exit $rc
