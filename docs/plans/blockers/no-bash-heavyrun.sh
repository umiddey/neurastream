#!/usr/bin/env bash
# Phase-0 blocker for 20261023_1835: no NEW retired-name or shell-invoked heavy-run refs.
# Guard semantics: only files BOTH changed vs origin/main AND in the scan set are checked
# (green on a pristine tree; the strict whole-tree grep lives in the plan's Done check).
set -u
cd "$(dirname "$0")/../../.." || exit 1
changed=$( { git diff --name-only origin/main 2>/dev/null; git ls-files --others --exclude-standard; } | sort -u)
scan_re='^(src|bin|templates|blockers)/|^(README\.md|docs/config\.md)$|^docs/visual/'
bad=0
while IFS= read -r f; do
  [ -z "$f" ] && continue
  echo "$f" | grep -Eq "$scan_re" || continue
  [ -f "$f" ] || continue
  if grep -nEq 'heavy-run\.sh|bash +[^ ]*heavy-run' "$f"; then
    echo "no-bash-heavyrun: retired/shell heavy-run ref in CHANGED file $f" >&2
    bad=1
  fi
done <<< "$changed"
[ "$bad" -eq 0 ] && echo "no-bash-heavyrun: clean (changed ∩ scan set)"
exit "$bad"
