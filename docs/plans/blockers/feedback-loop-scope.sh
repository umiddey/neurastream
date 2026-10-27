#!/usr/bin/env bash
# feedback-loop-scope.sh: phase-0 blocker for plan 20261027_1430_feedback_loop.
set -uo pipefail
if [ ! -t 0 ]; then
  CALL=$(timeout 2 cat 2>/dev/null || true)
  if [ -n "$CALL" ] && ! printf '%s' "$CALL" | grep -qE 'git[^|;&]*\b(commit|push)\b'; then exit 0; fi
fi
WT=/home/ukd/Work/neurastream-feedback-loop
[ -d "$WT" ] || { echo "feedback-loop-scope: no worktree"; exit 0; }
cd "$WT" || exit 1
ALLOWED='^(src/core/(heartbeat|watch|incident-detectors|incidents|notify|metrics|report|main-start|config|init|doctor|ui-setup|service-manager|wip-[a-z-]+)\.ts|src/adapters/omp/index\.ts|src/cli/[^/]+\.ts|templates/config\.yml|templates/systemd/neurastream-watch\.(service|timer)|templates/launchd/[^/]+\.plist|templates/help/[a-z-]+\.txt|tests/[^/]+\.test\.ts|tests/fixtures/[^ ]+|README\.md|CHANGELOG\.md|docs/[^/]+\.md)$'
BASE=$(git merge-base origin/main HEAD 2>/dev/null || echo origin/main)
FILES=$( { git diff --name-only "$BASE"; git ls-files --others --exclude-standard; } 2>/dev/null | sort -u)
rc=0
for f in $FILES; do echo "$f" | grep -qE "$ALLOWED" || { echo "OUT OF SCOPE: $f"; rc=1; }; done
for f in src/core/heartbeat.ts src/core/watch.ts; do
  [ -f "$f" ] || continue
  if grep -niwE 'omp|opencode|codex|claude|cursor' "$f"; then echo "feedback-loop-scope: $f names a harness"; rc=1; fi
done
# The watcher reports; it never restarts services or edits plans/guards.
if [ -f src/core/watch.ts ] && grep -nE 'systemctl[^"]*(restart|start|enable)|writeFileSync\([^)]*(plans|INDEX|guard)' src/core/watch.ts; then
  echo "feedback-loop-scope: watch.ts acts instead of reporting"; rc=1
fi
# No duplicate posts: watch must check the dedup flag before notifying.
if [ -f src/core/watch.ts ] && grep -q 'postReply' src/core/watch.ts && ! grep -q 'deduped' src/core/watch.ts; then
  echo "feedback-loop-scope: watch posts without checking deduped"; rc=1
fi
# Tests must not hit the real home, network or service manager.
if grep -lE 'homedir\(\)|discord\.com/api|systemctl --user' tests/heartbeat.test.ts tests/watch*.test.ts 2>/dev/null; then
  echo "feedback-loop-scope: a test touches the real home, Discord or systemd"; rc=1
fi
[ $rc -eq 0 ] && echo "feedback-loop-scope: clean"
exit $rc
