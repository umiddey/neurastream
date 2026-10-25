#!/usr/bin/env bash
# secret-redact-scope.sh: phase-0 blocker for plan 20261025_2204_secret_redact.
# Files changed vs origin/main must stay in scope; no real-looking secret may be committed;
# the implementer never reads the owner's real secret files.
set -uo pipefail
if [ ! -t 0 ]; then
  CALL=$(timeout 2 cat 2>/dev/null || true)
  # Refuse direct reads of the owner's real secret files in any tool call.
  if printf '%s' "$CALL" | grep -qE '/home/ukd/(\.npmrc|\.config/gateforge|\.omp/agent/mcp\.json)|(^|[ /"])\.env[^ "]*' && ! printf '%s' "$CALL" | grep -q '/tmp/neurastream-home-'; then
    echo "secret-redact-scope: do not read real secret files; use a sandbox HOME=/tmp/neurastream-home-* with fake values"; exit 1
  fi
  if [ -n "$CALL" ] && ! printf '%s' "$CALL" | grep -qE 'git[^|;&]*\b(commit|push)\b'; then exit 0; fi
fi
WT=/home/ukd/Work/neurastream-secret-redact
[ -d "$WT" ] || { echo "secret-redact-scope: no worktree"; exit 0; }
cd "$WT" || exit 1
ALLOWED='^(src/core/secret-redact\.ts|src/core/config\.ts|src/core/notify\.ts|src/core/owner-ui\.ts|src/adapters/omp/(index|launch|doctor)\.ts|src/cli/[^/]+\.ts|templates/config\.yml|README\.md|CHANGELOG\.md|docs/config\.md|tests/[^/]+\.test\.ts)$'
BASE=$(git merge-base origin/main HEAD 2>/dev/null || echo origin/main)
FILES=$( { git diff --name-only "$BASE"; git ls-files --others --exclude-standard; } 2>/dev/null | sort -u)
rc=0
for f in $FILES; do
  echo "$f" | grep -qE "$ALLOWED" || { echo "OUT OF SCOPE: $f"; rc=1; }
done
# Real-looking secrets in the diff: shapes whose body is not a run of one repeated filler char.
leak=$(git diff "$BASE" -- . ; git ls-files --others --exclude-standard -z | xargs -0 -r cat 2>/dev/null) 
hits=$(printf '%s' "$leak" | grep -oE 'npm_[A-Za-z0-9]{36}|gh[pousr]_[A-Za-z0-9]{36}|sk-(ant-|or-)?[A-Za-z0-9_-]{30,}|AKIA[A-Z0-9]{16}|xox[abpr]-[A-Za-z0-9-]{20,}' | grep -vE '^(npm_|gh[pousr]_|sk-(ant-|or-)?|AKIA|xox[abpr]-)(.)\2+$' | grep -vE '(A{12,}|X{12,}|0{12,}|x{12,})' || true)
[ -n "$hits" ] && { echo "REAL-LOOKING SECRET IN DIFF (use repeated filler like AAAA…):"; echo "$hits" | sed -E 's/(.{8}).*/\1…/'; rc=1; }
[ $rc -eq 0 ] && echo "secret-redact-scope: clean"
exit $rc
