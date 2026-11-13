#!/usr/bin/env bash
# stop-dead-agent-scope.sh: phase-0 blocker for plan 20261103_2212_stop_guard_dead_agent.
# Scope allow-list; core stays harness-free (the boot-time helper lives in src/core/clock.ts and names no
# harness); no new dependency; the stop/valve/incident rules in checkStop keep their exact behavior; tests
# never read the real home.
set -uo pipefail
if [ ! -t 0 ]; then
  CALL=$(timeout 2 cat 2>/dev/null || true)
  if [ -n "$CALL" ] && ! printf '%s' "$CALL" | grep -qE 'git[^|;&]*\b(commit|push)\b'; then exit 0; fi
fi
WT=/home/ukd/Work/neurastream-stop-dead-agent
[ -d "$WT" ] || { echo "stop-dead-agent-scope: no worktree"; exit 0; }
cd "$WT" || exit 1
ALLOWED='^(src/core/(clock|guards)\.ts|src/adapters/omp/sessions\.ts|tests/(ledger-boot-dead|stop-live-agents)\.test\.ts|tests/golden/ports\.test\.ts|CHANGELOG\.md|package\.json)$'
BASE=$(git merge-base origin/main HEAD 2>/dev/null || echo origin/main)
FILES=$( { git diff --name-only "$BASE"; git ls-files --others --exclude-standard; } 2>/dev/null | sort -u)
rc=0
for f in $FILES; do echo "$f" | grep -qE "$ALLOWED" || { echo "OUT OF SCOPE: $f"; rc=1; }; done
if git diff "$BASE" -- src/core/clock.ts 2>/dev/null | grep -E '^\+' | grep -iwE 'omp|opencode|codex|claude|cursor' | grep -q .; then
  echo "stop-dead-agent-scope: src/core/clock.ts names a harness"; rc=1
fi
if git diff "$BASE" -- package.json 2>/dev/null | grep -E '^\+' | grep -vE '^\+\+\+|"version"' | grep -q .; then
  echo "stop-dead-agent-scope: package.json changes beyond the version (no new dependency)"; rc=1
fi
# checkStop's valves/blocks are not to be edited: no changed line may touch idleStops, cancelPending, openIncidentList or main_max_calls.
if git diff "$BASE" -U0 -- src/core/guards.ts 2>/dev/null | grep -E '^[+-]' | grep -vE '^(\+\+\+|---)' | grep -E 'idleStops|cancelPending|openIncidentList|main_max_calls|idle_stops'; then
  echo "stop-dead-agent-scope: guards.ts diff touches a stop valve/block (only the live-subagent log line may change)"; rc=1
fi
for t in tests/ledger-boot-dead.test.ts tests/stop-live-agents.test.ts; do
  [ -f "$t" ] || continue
  if grep -nE 'homedir\(\)|/home/ukd|process\.env\.HOME' "$t"; then echo "stop-dead-agent-scope: $t reads the real home"; rc=1; fi
done
[ $rc -eq 0 ] && echo "stop-dead-agent-scope: clean"
exit $rc
