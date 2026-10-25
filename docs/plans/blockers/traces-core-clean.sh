#!/usr/bin/env bash
# traces-core-clean.sh: phase-0 blocker for the 6 trace plans (20261024_03xx_traces_*).
# For every worktree /home/ukd/Work/neurastream-traces-*: files CHANGED vs origin/main
# (incl. untracked) under src/core/ must not name a harness/provider and must not
# reference secret files; no shipped file may carry a personal marker.
set -uo pipefail
# Called by plan-guard with one tool call on stdin: the tree scan only judges commits/pushes, so a
# red tree never refuses the reads and edits that clean it (I-20261025-70 deadlock). Run with no
# stdin (terminal, Done check) it scans unconditionally.
if [ ! -t 0 ]; then
  CALL=$(timeout 2 cat 2>/dev/null || true)
  if [ -n "$CALL" ] && ! printf '%s' "$CALL" | grep -qE 'git[^|;&]*\b(commit|push)\b'; then exit 0; fi
fi
HARNESS='\b(omp|claude|codex|opencode|anthropic|openrouter|zai|glm|openai|gemini|deepseek)\b'
SECRET='mcp\.json|(^|[^A-Za-z0-9_])\.env\b|keys[^ ]*\.txt|keyring|\.config/gateforge'
MARKER='ukd|umiddey|/home/|aetherios|estatemind|clanky|oi-agent|pm-counts'
rc=0
shopt -s nullglob
# Only what this branch adds: changed lines of tracked files, whole untracked files. Lines that
# were already on origin/main (e.g. the legacy "glm:" config migration) are not the agent's.
added() {
  if git ls-files --error-unmatch "$1" >/dev/null 2>&1; then
    git diff -U0 "$BASE" -- "$1" | grep -E '^\+' | grep -vE '^\+\+\+ ' | cut -c2-
  else
    cat "$1"
  fi
}
for WT in /home/ukd/Work/neurastream-traces-*; do
  [ -d "$WT/.git" ] || [ -f "$WT/.git" ] || continue
  cd "$WT" || continue
  BASE=$(git merge-base origin/main HEAD 2>/dev/null || echo origin/main)
  FILES=$( { git diff --name-only "$BASE"; git ls-files --others --exclude-standard; } 2>/dev/null | sort -u)
  CORE=$(echo "$FILES" | grep -E '^src/core/.*\.ts$' || true)
  SHIP=$(echo "$FILES" | grep -E '^(src/|bin/|templates/|README\.md)' || true)
  for f in $CORE; do
    [ -f "$f" ] || continue
    h=$(added "$f" | grep -iE "$HARNESS" | grep -vE '^\s*//' || true)
    [ -n "$h" ] && { echo "HARNESS NAME in core ($WT/$f):"; echo "$h" | cut -c1-160; rc=1; }
    s=$(added "$f" | grep -iE "$SECRET" || true)
    [ -n "$s" ] && { echo "SECRET PATH in core ($WT/$f):"; echo "$s" | cut -c1-160; rc=1; }
  done
  for f in $SHIP; do
    [ -f "$f" ] || continue
    m=$(added "$f" | grep -iE "$MARKER" || true)
    [ -n "$m" ] && { echo "PERSONAL MARKER ($WT/$f):"; echo "$m" | cut -c1-160; rc=1; }
  done
done
[ $rc -eq 0 ] && echo "traces-core-clean: clean"
exit $rc
