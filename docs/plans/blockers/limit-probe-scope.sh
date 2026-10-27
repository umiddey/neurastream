#!/usr/bin/env bash
# limit-probe-scope.sh: phase-0 blocker for plan 20261027_1500_limit_probe.
set -uo pipefail
if [ ! -t 0 ]; then
  CALL=$(timeout 2 cat 2>/dev/null || true)
  if [ -n "$CALL" ] && ! printf '%s' "$CALL" | grep -qE 'git[^|;&]*\b(commit|push)\b'; then exit 0; fi
fi
WT=/home/ukd/Work/neurastream-limit-probe
[ -d "$WT" ] || { echo "limit-probe-scope: no worktree"; exit 0; }
cd "$WT" || exit 1
ALLOWED='^(src/core/(rate-limit|limit-probe|reset-time|provider-state|config|metrics|report|notify)\.ts|src/adapters/omp/[^/]+\.ts|src/cli/[^/]+\.ts|templates/config\.yml|templates/help/[a-z-]+\.txt|tests/[^/]+\.test\.ts|tests/fixtures/[^ ]+|README\.md|CHANGELOG\.md|docs/[^/]+\.md)$'
BASE=$(git merge-base origin/main HEAD 2>/dev/null || echo origin/main)
FILES=$( { git diff --name-only "$BASE"; git ls-files --others --exclude-standard; } 2>/dev/null | sort -u)
rc=0
for f in $FILES; do echo "$f" | grep -qE "$ALLOWED" || { echo "OUT OF SCOPE: $f"; rc=1; }; done
for f in src/core/rate-limit.ts src/core/limit-probe.ts; do
  [ -f "$f" ] || continue
  if grep -niwE 'omp|opencode|codex|claude|cursor' "$f" | grep -viE 'codex/cursor dates|// .*(codex|cursor)'; then echo "limit-probe-scope: $f names a harness"; rc=1; fi
done
# The probe must not load neurastream's own extension or save a session.
if grep -rn 'probe_cmd' templates/config.yml src/adapters/omp 2>/dev/null | grep -q 'omp -p' && ! grep -rn 'probe_cmd' templates/config.yml src/adapters/omp | grep 'omp -p' | grep -q -- '--no-extensions.*--no-session\|--no-session.*--no-extensions'; then
  echo "limit-probe-scope: omp probe_cmd lacks --no-extensions/--no-session"; rc=1
fi
# No exponential backoff left once the probe loop (P2) exists.
if [ -f src/core/limit-probe.ts ] && [ -f src/core/rate-limit.ts ] && grep -n 'baseMs \*= 2' src/core/rate-limit.ts; then echo "limit-probe-scope: doubling still in rate-limit.ts"; rc=1; fi
# Tests must not call real providers or omp.
if grep -lE 'Bun\.spawn(Sync)?\(\[?"omp"|api\.anthropic|discord\.com/api' tests/limit-probe.test.ts tests/rate-limit.test.ts 2>/dev/null; then
  echo "limit-probe-scope: a test calls a real provider/omp/Discord"; rc=1
fi
[ $rc -eq 0 ] && echo "limit-probe-scope: clean"
exit $rc
