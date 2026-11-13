#!/usr/bin/env bash
# ui-rebind-scope.sh: phase-0 blocker for plan 20261107_1250_ui_pages_follow_tailnet_ip.
# Keeps the fix to the self-exit watcher: no guard change, no wider bind, no unit restarts from code.
set -uo pipefail
if [ ! -t 0 ]; then
  CALL=$(timeout 2 cat 2>/dev/null || true)
  if [ -n "$CALL" ] && ! printf '%s' "$CALL" | grep -qE 'git[^|;&]*\b(commit|push)\b'; then exit 0; fi
fi
WT=/home/ukd/Work/neurastream-ui-rebind
[ -d "$WT" ] || { echo "ui-rebind-scope: no worktree"; exit 0; }
cd "$WT" || exit 1
ALLOWED='^(src/core/tailscale\.ts|src/cli/(ui|pages)\.ts|tests/[^/]+\.test\.ts|README\.md|CHANGELOG\.md)$'
BASE=$(git merge-base origin/main HEAD 2>/dev/null || echo origin/main)
FILES=$( { git diff --name-only "$BASE"; git ls-files --others --exclude-standard; } 2>/dev/null | sort -u)
rc=0
for f in $FILES; do echo "$f" | grep -qE "$ALLOWED" || { echo "OUT OF SCOPE: $f"; rc=1; }; done
for f in src/core/tailscale.ts src/cli/ui.ts src/cli/pages.ts; do
  [ -f "$f" ] || continue
  if git diff "$BASE" -- "$f" | grep -nE '^\+.*(0\.0\.0\.0|hostname:\s*"::"|systemctl|reusePort)'; then echo "ui-rebind-scope: $f must not widen the bind or call systemctl"; rc=1; fi
done
if git diff "$BASE" -- src/core/tailscale.ts | grep -niwE '^\+.*\b(omp|opencode|codex|claude|cursor)\b'; then echo "ui-rebind-scope: core names a harness"; rc=1; fi
[ $rc -eq 0 ] && echo "ui-rebind-scope: clean"
exit $rc
