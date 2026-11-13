#!/usr/bin/env bash
# release-verdict-noise-scope.sh: phase-0 blocker for plan 20261103_1105_release_watcher_noise.
# Allow-list: src/core/watch.ts, tests/watch.test.ts, docs/config.md, CHANGELOG.md.
# The deny checks of the usual deny-command line live here too (no --no-verify, no shell
# strings in core), so a call that never names this plan's worktree is left alone — that
# covers plan-file Progress appends in the main checkout without a git-pattern stdin probe.
set -uo pipefail
WT=/home/ukd/Work/neurastream-release-watcher
[ -d "$WT" ] || { echo "release-verdict-noise-scope: no worktree"; exit 0; }
if [ ! -t 0 ]; then
  CALL=$(timeout 2 cat 2>/dev/null || true)
  if [ -n "$CALL" ] && ! printf '%s' "$CALL" | grep -qF "$WT"; then exit 0; fi
fi
cd "$WT" || exit 1
ALLOWED='^(src/core/watch\.ts|tests/watch\.test\.ts|docs/config\.md|CHANGELOG\.md)$'
BASE=$(git merge-base origin/main HEAD 2>/dev/null || echo origin/main)
FILES=$( { git diff --name-only "$BASE"; git ls-files --others --exclude-standard; } 2>/dev/null | sort -u)
rc=0
for f in $FILES; do echo "$f" | grep -qE "$ALLOWED" || { echo "OUT OF SCOPE: $f"; rc=1; }; done
if grep -niwE 'omp|opencode|codex|claude|cursor' src/core/watch.ts; then echo "release-verdict-noise-scope: watch.ts names a harness"; rc=1; fi
if grep -nE 'shell:\s*true|execSync\(|--no-verify' src/core/watch.ts; then echo "release-verdict-noise-scope: watch.ts runs a shell string or bypasses hooks"; rc=1; fi
[ $rc -eq 0 ] && echo "release-verdict-noise-scope: clean"
exit $rc
