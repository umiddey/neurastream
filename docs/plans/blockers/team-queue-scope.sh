#!/usr/bin/env bash
# team-queue-scope.sh: phase-0 blocker.
set -uo pipefail
if [ ! -t 0 ]; then
  CALL=$(timeout 2 cat 2>/dev/null || true)
  if [ -n "$CALL" ] && ! printf '%s' "$CALL" | grep -qE 'git[^|;&]*\b(commit|push)\b'; then exit 0; fi
fi
WT=/home/ukd/Work/neurastream-team-queue
[ -d "$WT" ] || { echo "team-queue-scope: no worktree"; exit 0; }
cd "$WT" || exit 1
ALLOWED='^(src/core/(team-[a-z-]+|claims|guards|config|main-start|owner-ui|owner-inbox|tailscale|doctor)\.ts|src/core/queue/lib\.ts|src/adapters/omp/(index|doctor)\.ts|src/cli/[^/]+\.ts|templates/config\.yml|templates/systemd/neurastream-team\.service|templates/launchd/[^/]+\.plist|templates/help/[^/]+\.txt|tests/[^/]+\.test\.ts|README\.md|CHANGELOG\.md|docs/[^/]+\.md|package\.json)$'
BASE=$(git merge-base origin/main HEAD 2>/dev/null || echo origin/main)
FILES=$( { git diff --name-only "$BASE"; git ls-files --others --exclude-standard; } 2>/dev/null | sort -u)
rc=0
for f in $FILES; do echo "$f" | grep -qE "$ALLOWED" || { echo "OUT OF SCOPE: $f"; rc=1; }; done
for f in $(echo "$FILES" | grep -E '^src/core/.*\.ts$'); do
  [ -f "$f" ] || continue
  if grep -niwE 'omp|opencode|codex|claude|cursor' "$f"; then echo "team-queue-scope: $f names a harness"; rc=1; fi
done
if echo "$FILES" | grep -E '^tests/' | xargs -r grep -lE 'homedir\(\)|/home/ukd' 2>/dev/null; then echo "team-queue-scope: a test touches the real home"; rc=1; fi
# Never bind all interfaces; never shell out with request data.
if grep -nE '0\.0\.0\.0|hostname:\s*"::"' src/core/team-*.ts 2>/dev/null; then echo "team-queue-scope: server binds all interfaces"; rc=1; fi
if grep -nE 'spawnSync|execSync|Bun\.\$' src/core/team-server.ts 2>/dev/null; then echo "team-queue-scope: team-server shells out"; rc=1; fi
[ $rc -eq 0 ] && echo "team-queue-scope: clean"
exit $rc
