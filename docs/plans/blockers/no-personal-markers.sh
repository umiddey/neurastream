#!/usr/bin/env bash
# no-personal-markers.sh: fail ONLY if a file CHANGED in the scrub worktree
# (vs origin/main, incl. untracked) AND part of the npm shipped set
# (src, bin, templates, blockers, README.md) reintroduces a personal marker.
# tests/, docs/, CHANGELOG etc. are not shipped (the guard test itself must
# hold the marker literals), so they are out of scope here.
set -uo pipefail
WT="/home/ukd/Work/neurastream-scrub"
cd "$WT" || { echo "no-personal-markers: worktree missing"; exit 1; }
MARKER='ukd|umiddey|/home/|~/Work|Work/|gf-testbed|gateforge|pm-counts|aetherios|EstateMind|estatemind|contractor|clanky|oi-agent|sabuj|amiiir|100\.70|sessions/-|gf-luna|pm/pr01'
git fetch -q origin 2>/dev/null || true
BASE=$(git merge-base origin/main HEAD 2>/dev/null || echo origin/main)
FILES=$( { git diff --name-only "$BASE"; git ls-files --others --exclude-standard; } 2>/dev/null \
  | sort -u | grep -E '^(src/|bin/|templates/|blockers/|README\.md)' || true)
[ -z "$FILES" ] && { echo "no-personal-markers: clean (no changed shipped files)"; exit 0; }
HITS=$(grep -niE "$MARKER" $FILES 2>/dev/null)
if [ -n "$HITS" ]; then
  echo "PERSONAL MARKERS in shipped files changed by this work:"
  echo "$HITS" | cut -c1-200
  exit 1
fi
echo "no-personal-markers: clean"
