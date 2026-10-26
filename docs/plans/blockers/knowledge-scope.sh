#!/usr/bin/env bash
# knowledge-scope.sh: phase-0 blocker for plan 20261026_0930_knowledge_base.
# The knowledge tab is a read-only view over docs/knowledge/*.html; core stays host-neutral.
set -uo pipefail
if [ ! -t 0 ]; then
  CALL=$(timeout 2 cat 2>/dev/null || true)
  if [ -n "$CALL" ]; then
    if grep -qiE "rm[[:space:]]|git (push|reset|revert|checkout --)" <<<"$CALL"; then
      echo "knowledge-scope: destructive call blocked"; exit 1
    fi
  fi
fi
WT=/home/ukd/Work/neurastream-knowledge
cd "$WT" 2>/dev/null || { echo "knowledge-scope: worktree $WT missing"; exit 1; }
rc=0
# 1. Core stays host-neutral: no harness names in src/core or src/cli knowledge paths.
if grep -rniE '\b(omp|codex|claude|cursor|opencode)\b' src/core/knowledge.ts >/dev/null 2>&1; then
  echo "knowledge-scope: harness name in src/core/knowledge.ts"; rc=1
fi
# 2. No hardcoded home: config defaults carry the $HOME placeholder, never /home/ukd.
if grep -rn "/home/ukd" src/ templates/ >/dev/null 2>&1; then
  echo "knowledge-scope: hardcoded /home/ukd in src/ or templates/"; rc=1
fi
# 3. Read-only: the tab serves files; it must not add write/upload/delete routes for topics.
if grep -nE "action=\"/knowledge[^\"]*\"|method=\"post\"[^>]*knowledge" src/core/owner-ui.ts >/dev/null 2>&1; then
  echo "knowledge-scope: knowledge POST route in owner-ui.ts (read-only)"; rc=1
fi
if grep -nE "(writeFile|rm|unlink|renameSync)\(" src/core/knowledge.ts >/dev/null 2>&1; then
  echo "knowledge-scope: src/core/knowledge.ts writes/deletes files"; rc=1
fi
# 4. Only docs/knowledge is scanned; no other doc dir enters the manifest.
if grep -nE "docs/(plans|memory|architecture)" src/core/knowledge.ts >/dev/null 2>&1; then
  echo "knowledge-scope: knowledge scan reads outside docs/knowledge"; rc=1
fi
[ $rc -eq 0 ] && echo "knowledge-scope: clean"
exit $rc
