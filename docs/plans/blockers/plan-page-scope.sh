#!/usr/bin/env bash
# plan-page-scope.sh: phase-0 blocker for plan 20261031_0917_plan_page_drilldown.
set -uo pipefail
if [ ! -t 0 ]; then
  CALL=$(timeout 2 cat 2>/dev/null || true)
  if [ -n "$CALL" ] && ! printf '%s' "$CALL" | grep -qE 'git[^|;&]*\b(commit|push)\b'; then exit 0; fi
fi
WT=/home/ukd/Work/neurastream-plan-page
[ -d "$WT" ] || { echo "plan-page-scope: no worktree"; exit 0; }
cd "$WT" || exit 1
ALLOWED='^(src/core/pages-setup\.ts|src/core/page-notes\.ts|src/core/pages\.ts|src/core/owner-ui\.ts|src/adapters/omp/index\.ts|src/adapters/omp/doctor\.ts|src/cli/pages\.ts|tests/plan-page-template\.test\.ts|tests/pages-server\.test\.ts|tests/owner-ui\.test\.ts|tests/doctor\.test\.ts|tests/diagram-check\.test\.ts|tests/plan-approval\.test\.ts|tests/fixtures/[^ ]+|templates/AGENTS\.md|templates/skills/architecture-drilldown/SKILL\.md|CHANGELOG\.md)$'
BASE=$(git merge-base origin/main HEAD 2>/dev/null || echo origin/main)
FILES=$( { git diff --name-only "$BASE"; git ls-files --others --exclude-standard; } 2>/dev/null | sort -u)
rc=0
for f in $FILES; do echo "$f" | grep -qE "$ALLOWED" || { echo "OUT OF SCOPE: $f"; rc=1; }; done
# The template is the one source: it must not change, and no opt-out may appear.
git diff --quiet "$BASE" -- templates/skills/architecture-drilldown/template.html || { echo "plan-page-scope: template.html must not change"; rc=1; }
if git diff "$BASE" -- src | grep -nE '^\+.*(no-template|NO_TEMPLATE|skipTemplate|skip_template)'; then echo "plan-page-scope: opt-out is forbidden"; rc=1; fi
[ $rc -eq 0 ] && echo "plan-page-scope: clean"
exit $rc
