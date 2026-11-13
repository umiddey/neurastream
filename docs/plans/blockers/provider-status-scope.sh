#!/usr/bin/env bash
# provider-status-scope.sh: phase-0 blocker for plan 20261103_0955_provider_status.
# Scope allow-list; core stays harness-free; the harness reader opens agent.db read-only, never
# selects the secret `data` column and never writes; no new dependency; tests never read the real home.
set -uo pipefail
if [ ! -t 0 ]; then
  CALL=$(timeout 2 cat 2>/dev/null || true)
  if [ -n "$CALL" ] && ! printf '%s' "$CALL" | grep -qE 'git[^|;&]*\b(commit|push)\b'; then exit 0; fi
fi
WT=/home/ukd/Work/neurastream-provider-status
[ -d "$WT" ] || { echo "provider-status-scope: no worktree"; exit 0; }
cd "$WT" || exit 1
ALLOWED='^(src/core/(provider-state|main-start)\.ts|src/adapters/index\.ts|src/adapters/omp/(adapter|providers|doctor|index|launch)\.ts|src/cli/commands\.ts|tests/(provider-status|omp-providers|main-start)\.test\.ts|tests/golden/ports-p4\.test\.ts|README\.md|CHANGELOG\.md|docs/adapter\.md|package\.json)$'
# while merging origin/main in, the branch's own change is the diff against origin/main itself
if [ -f "$(git rev-parse --git-dir)/MERGE_HEAD" ]; then BASE=origin/main; else BASE=$(git merge-base origin/main HEAD 2>/dev/null || echo origin/main); fi
FILES=$( { git diff --name-only "$BASE"; git ls-files --others --exclude-standard; } 2>/dev/null | sort -u)
rc=0
for f in $FILES; do echo "$f" | grep -qE "$ALLOWED" || { echo "OUT OF SCOPE: $f"; rc=1; }; done
if grep -rniwE 'omp|opencode|codex|claude|cursor' src/core >/dev/null 2>&1; then
  echo "provider-status-scope: src/core names a harness:"; grep -rniwE 'omp|opencode|codex|claude|cursor' src/core | head -5; rc=1
fi
if grep -rnE "from \"(\.\./)+(adapters|cli)/" src/core >/dev/null 2>&1; then
  echo "provider-status-scope: src/core imports src/adapters or src/cli"; rc=1
fi
P=src/adapters/omp/providers.ts
if [ -f "$P" ]; then
  grep -q 'readonly: true' "$P" || { echo "provider-status-scope: $P must open agent.db with { readonly: true }"; rc=1; }
  if grep -nE 'SELECT[^;]*\bdata\b' "$P"; then echo "provider-status-scope: $P selects the secret data column"; rc=1; fi
  if grep -nE '\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|PRAGMA)\b' "$P"; then echo "provider-status-scope: $P writes to the harness store"; rc=1; fi
fi
if git diff "$BASE" -- package.json 2>/dev/null | grep -E '^\+' | grep -vE '^\+\+\+|"version"' | grep -q .; then
  echo "provider-status-scope: package.json changes beyond the version (no new dependency)"; rc=1
fi
for t in tests/provider-status.test.ts tests/omp-providers.test.ts; do
  [ -f "$t" ] || continue
  if grep -nE 'homedir\(\)|/home/ukd|process\.env\.HOME' "$t"; then echo "provider-status-scope: $t reads the real home"; rc=1; fi
done
[ $rc -eq 0 ] && echo "provider-status-scope: clean"
exit $rc
