#!/usr/bin/env bash
# rollover-scope.sh — blocker for plan 20261101_1945_rollover_path_skew (I-20261101-47)
# Refuses writes outside the plan's file allow-list. Run from any cwd; scans staged + unstaged
# changes (and the worktree dirty set) of THIS repo.
set -u
cd "$(git rev-parse --show-toplevel 2>/dev/null || { echo 'blocker: not a git repo'; exit 1; })"

ALLOW_RE='^(src/adapters/omp/launch\.ts|src/core/rollover\.ts|tests/launch\.test\.ts|tests/rollover[^/]*\.test\.ts|CHANGELOG\.md|README\.md|docs/.*)$'
BAD=0
while IFS= read -r f; do
  [ -z "$f" ] && continue
  if ! printf '%s' "$f" | grep -Eq "$ALLOW_RE"; then
    echo "blocker: out-of-scope path for rollover_path_skew: $f"
    BAD=1
  fi
done < <( { git diff --name-only HEAD; git diff --name-only --cached; git ls-files -mo --exclude-standard; } | sort -u )

if [ "$BAD" -ne 0 ]; then
  echo "blocker: only launch.ts, rollover.ts, their tests, CHANGELOG, README and docs/ may change for this plan"
  exit 1
fi
echo "rollover-scope: ok"
exit 0
