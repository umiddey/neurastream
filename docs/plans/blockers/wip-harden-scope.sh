#!/usr/bin/env bash
# wip-harden-scope.sh: phase-0 blocker for plan 20261027_1130_wip_harden.
set -uo pipefail
if [ ! -t 0 ]; then
  CALL=$(timeout 2 cat 2>/dev/null || true)
  if [ -n "$CALL" ] && ! printf '%s' "$CALL" | grep -qE 'git[^|;&]*\b(commit|push)\b'; then exit 0; fi
fi
WT=/home/ukd/Work/neurastream-wip-harden
[ -d "$WT" ] || { echo "wip-harden-scope: no worktree"; exit 0; }
cd "$WT" || exit 1
ALLOWED='^(src/core/(wip-[a-z-]+|config|config-edit|ui-setup|pages-setup|main-start|incidents|notify|proc|paths)\.ts|src/adapters/omp/doctor\.ts|src/cli/[^/]+\.ts|templates/config\.yml|templates/systemd/neurastream-wip-[a-z]+\.(service|timer)|templates/launchd/[^/]+\.plist|templates/help/wip-[^/]+\.txt|tests/[^/]+\.test\.ts|tests/golden/ports\.test\.ts|README\.md|CHANGELOG\.md|docs/[^/]+\.md)$'
BASE=$(git merge-base origin/main HEAD 2>/dev/null || echo origin/main)
FILES=$( { git diff --name-only "$BASE"; git ls-files --others --exclude-standard; } 2>/dev/null | sort -u)
rc=0
for f in $FILES; do echo "$f" | grep -qE "$ALLOWED" || { echo "OUT OF SCOPE: $f"; rc=1; }; done
for f in src/core/wip-*.ts; do
  [ -f "$f" ] || continue
  if grep -niwE 'omp|opencode|codex|claude|cursor' "$f"; then echo "wip-harden-scope: $f names a harness"; rc=1; fi
  if grep -nE 'shell:\s*true|execSync\(|\$\{[^}]*url[^}]*\}[^`]*`\s*\)' "$f"; then echo "wip-harden-scope: $f runs a shell string; use argv arrays"; rc=1; fi
  if grep -nE 'core\.hooksPath' "$f" | grep -v 'backup_hook_off\|hookOff\|noHooks'; then echo "wip-harden-scope: $f bypasses hooks outside wip.backup_hook_off"; rc=1; fi
done
if [ -f src/core/wip-private.ts ] && grep -nE '"internal"\s*\)?\s*return\s*"private"|=== "internal"[^;]*"private"' src/core/wip-private.ts; then echo "wip-harden-scope: internal visibility is not private"; rc=1; fi
[ $rc -eq 0 ] && echo "wip-harden-scope: clean"
exit $rc
