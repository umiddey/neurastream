#!/usr/bin/env bash
# wip-broken-repos-scope.sh: phase-0 blocker for plan 20261103_0930_wip_broken_repos.
set -uo pipefail
if [ ! -t 0 ]; then
  CALL=$(timeout 2 cat 2>/dev/null || true)
  if [ -n "$CALL" ] && ! printf '%s' "$CALL" | grep -qE 'git[^|;&]*\b(commit|push)\b'; then exit 0; fi
fi
WT=/home/ukd/Work/neurastream-wip-exit
[ -d "$WT" ] || { echo "wip-broken-repos-scope: no worktree"; exit 0; }
cd "$WT" || exit 1
ALLOWED='^(src/core/wip-snapshot\.ts|src/core/wip-backup\.ts|src/core/wip-roots\.ts|src/core/wip-fail\.ts|tests/wip-broken-repos\.test\.ts|CHANGELOG\.md)$'
BASE=$(git merge-base origin/main HEAD 2>/dev/null || echo origin/main)
FILES=$( { git diff --name-only "$BASE"; git ls-files --others --exclude-standard; } 2>/dev/null | sort -u)
rc=0
for f in $FILES; do echo "$f" | grep -qE "$ALLOWED" || { echo "OUT OF SCOPE: $f"; rc=1; }; done
for f in src/core/wip-snapshot.ts src/core/wip-backup.ts src/core/wip-roots.ts src/core/wip-fail.ts; do
  if grep -niwE 'omp|opencode|codex|claude|cursor' "$f"; then echo "wip-broken-repos-scope: $f names a harness"; rc=1; fi
  if grep -nE 'shell:\s*true|execSync\(|--no-verify' "$f"; then echo "wip-broken-repos-scope: $f runs a shell string or bypasses hooks"; rc=1; fi
done
[ $rc -eq 0 ] && echo "wip-broken-repos-scope: clean"
exit $rc
