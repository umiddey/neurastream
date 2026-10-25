#!/usr/bin/env bash
# pages-expiry-scope.sh: phase-0 blocker for plan 20261025_1900_pages_expiry.
# In /home/ukd/Work/neurastream-pages-expiry, files changed vs origin/main (incl. untracked) must stay
# inside the plan's scope; the skill's template.html engine and the server's auth lines stay untouched.
set -uo pipefail
# Called by plan-guard with one tool call on stdin: the tree scan only judges commits/pushes.
if [ ! -t 0 ]; then
  CALL=$(timeout 2 cat 2>/dev/null || true)
  if [ -n "$CALL" ] && ! printf '%s' "$CALL" | grep -qE 'git[^|;&]*\b(commit|push)\b'; then exit 0; fi
fi
WT=/home/ukd/Work/neurastream-pages-expiry
[ -d "$WT" ] || { echo "pages-expiry-scope: no worktree"; exit 0; }
cd "$WT" || exit 1
ALLOWED='^(src/core/pages\.ts|src/core/pages-setup\.ts|src/core/pages-expiry\.ts|src/cli/pages\.ts|src/core/config\.ts|templates/config\.yml|templates/skills/architecture-drilldown/SKILL\.md|README\.md|CHANGELOG\.md|docs/config\.md|tests/[^/]+\.test\.ts)$'
BASE=$(git merge-base origin/main HEAD 2>/dev/null || echo origin/main)
FILES=$( { git diff --name-only "$BASE"; git ls-files --others --exclude-standard; } 2>/dev/null | sort -u)
rc=0
for f in $FILES; do
  if ! echo "$f" | grep -qE "$ALLOWED"; then echo "OUT OF SCOPE: $f"; rc=1; fi
done
auth=$(git diff -U0 "$BASE" -- src/core/pages.ts | grep -E '^[-+]' | grep -vE '^(\+\+\+|---)' | grep -E 'isLoopback|isTailnet|whois|owner_login|forbidden' || true)
[ -n "$auth" ] && { echo "AUTH LINES CHANGED in src/core/pages.ts:"; echo "$auth" | cut -c1-120; rc=1; }
[ $rc -eq 0 ] && echo "pages-expiry-scope: clean"
exit $rc
