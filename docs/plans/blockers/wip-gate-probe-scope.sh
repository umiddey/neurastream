#!/usr/bin/env bash
# wip-gate-probe-scope.sh: phase-0 blocker for plan 20261103_0815_wip_on_gate_probe.
set -uo pipefail
if [ ! -t 0 ]; then
  CALL=$(timeout 2 cat 2>/dev/null || true)
  if [ -n "$CALL" ] && ! printf '%s' "$CALL" | grep -qE 'git[^|;&]*\b(commit|push)\b'; then exit 0; fi
fi
WT=/home/ukd/Work/neurastream-wip-gate-probe
[ -d "$WT" ] || { echo "wip-gate-probe-scope: no worktree"; exit 0; }
cd "$WT" || exit 1
ALLOWED='^(src/core/wip-setup\.ts|tests/wip-setup\.test\.ts)$'
BASE=$(git merge-base origin/main HEAD 2>/dev/null || echo origin/main)
FILES=$( { git diff --name-only "$BASE"; git ls-files --others --exclude-standard; } 2>/dev/null | sort -u)
rc=0
for f in $FILES; do echo "$f" | grep -qE "$ALLOWED" || { echo "OUT OF SCOPE: $f"; rc=1; }; done
if grep -niwE 'omp|opencode|codex|claude|cursor' src/core/wip-setup.ts; then echo "wip-gate-probe-scope: src/core/wip-setup.ts names a harness"; rc=1; fi
if grep -nE 'shell:\s*true|execSync\(' src/core/wip-setup.ts; then echo "wip-gate-probe-scope: src/core/wip-setup.ts runs a shell string; use argv arrays"; rc=1; fi
[ $rc -eq 0 ] && echo "wip-gate-probe-scope: clean"
exit $rc
