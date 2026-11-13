#!/usr/bin/env bash
# rule-tuning-scope.sh: phase-0 blocker for plan 20261110_1746_rule_tuning.
set -uo pipefail
if [ ! -t 0 ]; then
  CALL=$(timeout 2 cat 2>/dev/null || true)
  if [ -n "$CALL" ] && ! printf '%s' "$CALL" | grep -qE 'git[^|;&]*\b(commit|push)\b'; then exit 0; fi
fi
WT=/home/ukd/Work/neurastream-rule-tuning
[ -d "$WT" ] || { echo "rule-tuning-scope: no worktree"; exit 0; }
cd "$WT" || exit 1
ALLOWED='^(src/core/(rule-levels|rule-tuning|guards|incident-detectors|incidents|report|watch|metrics|config)\.ts|src/cli/(dispatch|rules)\.ts|templates/config\.yml|tests/[^/]+\.test\.ts|README\.md|CHANGELOG\.md|docs/[^/]+\.md)$'
BASE=$(git merge-base origin/main HEAD 2>/dev/null || echo origin/main)
FILES=$( { git diff --name-only "$BASE"; git ls-files --others --exclude-standard; } 2>/dev/null | sort -u)
rc=0
for f in $FILES; do echo "$f" | grep -qE "$ALLOWED" || { echo "OUT OF SCOPE: $f"; rc=1; }; done
for f in src/core/rule-levels.ts src/core/rule-tuning.ts; do
  [ -f "$f" ] || continue
  if grep -niwE 'omp|opencode|codex|claude|cursor' "$f"; then echo "rule-tuning-scope: $f names a harness"; rc=1; fi
  # The tuner turns existing rules down and up; it never writes plans, indexes, guard code or runs commands.
  if grep -nE 'spawnSync|execSync|Bun\.\$|INDEX|docs/plans|guards\.ts' "$f"; then echo "rule-tuning-scope: $f acts outside the levels file"; rc=1; fi
done
if echo "$FILES" | grep -E '^tests/' | xargs -r grep -lE 'homedir\(\)|/home/ukd' 2>/dev/null; then echo "rule-tuning-scope: a test touches the real home"; rc=1; fi
[ $rc -eq 0 ] && echo "rule-tuning-scope: clean"
exit $rc
