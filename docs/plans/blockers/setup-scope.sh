#!/usr/bin/env bash
# setup-scope.sh: phase-0 blocker for plan 20261028_2356_setup_wizard.
# In /home/ukd/Work/neurastream-setup, files changed vs origin/main (incl. untracked) stay inside the
# plan's scope, src/core/ gains no harness name, package.json gains no dependency, and no source runs sudo.
set -uo pipefail
# Only commits/pushes are judged when called by plan-guard with a tool call on stdin (I-20261025-70).
if [ ! -t 0 ]; then
  CALL=$(timeout 2 cat 2>/dev/null || true)
  if [ -n "$CALL" ] && ! printf '%s' "$CALL" | grep -qE 'git[^|;&]*\b(commit|push)\b'; then exit 0; fi
fi
WT=/home/ukd/Work/neurastream-setup
[ -d "$WT" ] || { echo "setup-scope: no worktree"; exit 0; }
cd "$WT" || exit 1
HARNESS='\b(omp|claude|codex|opencode|anthropic|openrouter|zai|glm|openai|gemini|deepseek)\b'
ALLOWED='^(src/core/config-edit\.ts|src/core/ui-setup\.ts|src/core/pages-setup\.ts|src/core/tailscale\.ts|src/core/setup-detect\.ts|src/core/adapter\.ts|src/core/help\.ts|src/adapters/[a-z-]+/index\.ts|src/cli/setup\.ts|src/cli/init\.ts|src/cli/dispatch\.ts|src/cli/config-set\.ts|src/adapters/omp/doctor\.ts|templates/config\.yml|docs/config\.md|README\.md|CHANGELOG\.md|tests/config-edit\.test\.ts|tests/config-set\.test\.ts|tests/ui-on-off\.test\.ts|tests/owner-ui\.test\.ts|tests/finding-taps\.test\.ts|tests/pages[a-z-]*\.test\.ts|tests/tailscale[a-z-]*\.test\.ts|tests/setup[a-z-]*\.test\.ts|tests/fixtures/setup/.*)$'
# Owner unlock 2026-10-31 08:35: files the P2-P4 commits touched (Main-committed 29d7291, 5df5904, ed263cd).
ALLOWED="^(src/cli/ui\.ts|src/adapters/index\.ts|src/adapters/omp/(adapter|install)\.ts|tests/(diagram-check|page-notes|plan-approval)\.test\.ts)\$|$ALLOWED"
BASE=$(git merge-base origin/main HEAD 2>/dev/null || echo origin/main)
FILES=$( { git diff --name-only "$BASE"; git ls-files --others --exclude-standard; } 2>/dev/null | sort -u)
rc=0
for f in $FILES; do
  if ! echo "$f" | grep -qE "$ALLOWED"; then echo "OUT OF SCOPE: $f"; rc=1; fi
done
for f in $(echo "$FILES" | grep -E '^src/core/.*\.ts$' || true); do
  [ -f "$f" ] || continue
  h=$(git diff -U0 "$BASE" -- "$f" | grep -E '^\+' | grep -vE '^\+\+\+ ' | cut -c2- | grep -iE "$HARNESS" | grep -vE '^\s*(//|\*)' || true)
  [ -n "$h" ] && { echo "HARNESS NAME in core ($f):"; echo "$h" | cut -c1-160; rc=1; }
done
if git diff "$BASE" -- package.json 2>/dev/null | grep -qE '^\+\s*"[^"]+":\s*"[\^~]?[0-9]'; then
  echo "FORBIDDEN: new dependency in package.json"; rc=1
fi
if [ -d src ] && grep -rnE "(spawn|exec|execFile|spawnSync|execSync|Bun\.spawn)[A-Za-z]*\(\s*\[?\s*[\"'\`]sudo\b" src; then
  echo "FORBIDDEN: source runs sudo"; rc=1
fi
[ $rc -eq 0 ] && echo "setup-scope: clean"
exit $rc
