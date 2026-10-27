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
ALLOWED='^(src/core/(wip-[a-z-]+|config|main-start|init|doctor|incidents|notify|ui-setup)\.ts|src/cli/[^/]+\.ts|templates/config\.yml|templates/systemd/neurastream-wip-[a-z]+\.(service|timer)|templates/launchd/[^/]+\.plist|templates/help/wip-[a-z]+\.txt|tests/[^/]+\.test\.ts|tests/golden/ports\.test\.ts|README\.md|CHANGELOG\.md|docs/[^/]+\.md|package\.json)$'
BASE=$(git merge-base origin/main HEAD 2>/dev/null || echo origin/main)
FILES=$( { git diff --name-only "$BASE"; git ls-files --others --exclude-standard; } 2>/dev/null | sort -u)
rc=0
for f in $FILES; do echo "$f" | grep -qE "$ALLOWED" || { echo "OUT OF SCOPE: $f"; rc=1; }; done
for f in src/core/wip-*.ts; do
  [ -f "$f" ] || continue
  if grep -niwE 'omp|opencode|codex|claude|cursor' "$f"; then echo "wip-harden-scope: $f names a harness"; rc=1; fi
done
# Fail closed: wip-backup must call the privacy check before any push.
if [ -f src/core/wip-backup.ts ] && grep -q '"push"' src/core/wip-backup.ts && ! grep -q 'backupVisibility' src/core/wip-backup.ts; then
  echo "wip-harden-scope: wip-backup pushes without backupVisibility"; rc=1
fi
# Never weaken the secret scan.
if [ -f src/core/wip-backup.ts ] && ! grep -q 'secret_gate' src/core/wip-backup.ts; then
  echo "wip-harden-scope: wip-backup no longer runs the secret gate"; rc=1
fi
# Tests must not hit the real home or network.
if grep -lE 'homedir\(\)|github\.com/umiddey' tests/wip-*.test.ts 2>/dev/null; then echo "wip-harden-scope: a wip test touches the real home or GitHub"; rc=1; fi
[ $rc -eq 0 ] && echo "wip-harden-scope: clean"
exit $rc
