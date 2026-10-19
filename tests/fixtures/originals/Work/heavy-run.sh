#!/usr/bin/env bash
# Shared machine lock for HEAVY runs (full test suites, full E2E runs).
# Every agent on this machine wraps its heavy runs in this script, so two
# heavy runs never overlap. Whoever comes second waits (and says for whom).
#
# Usage:   /home/ukd/Work/heavy-run.sh "<who>" "<what>" -- <command> [args...]
# Example: /home/ukd/Work/heavy-run.sh "gateforge-orchestrator" "gateforge npm test" -- npm test -- --retry=0
# Status:  /home/ukd/Work/heavy-run.sh --status
# Notes to the other agent: append a line to /home/ukd/Work/AGENT-MAILBOX.md
set -uo pipefail
LOCK=/home/ukd/Work/.heavy-run.lock
OWNER=/home/ukd/Work/.heavy-run.owner
LOG=/home/ukd/Work/.heavy-run.log

if [ "${1:-}" = "--status" ]; then
  if flock -n "$LOCK" true 2>/dev/null; then echo "free"; else echo "busy: $(cat "$OWNER" 2>/dev/null)"; fi
  exit 0
fi
[ $# -ge 4 ] && [ "$3" = "--" ] || { echo "usage: $0 <who> <what> -- <command...>" >&2; exit 2; }
WHO=$1; WHAT=$2; shift 3

exec 9>"$LOCK"
if ! flock -n 9; then
  echo "[heavy-run] waiting — busy: $(cat "$OWNER" 2>/dev/null)" >&2
  flock 9
fi
echo "$WHO | $WHAT | since $(date '+%F %T') | pid $$" > "$OWNER"
echo "$(date '+%F %T') START $WHO | $WHAT" >> "$LOG"
"$@"; rc=$?
echo "$(date '+%F %T') END   $WHO | $WHAT | exit $rc" >> "$LOG"
: > "$OWNER"
exit $rc
