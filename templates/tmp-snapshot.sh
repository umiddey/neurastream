#!/usr/bin/env bash
set -uo pipefail

SNAP=${SNAP_DEST:?}
GF=${SNAP_GIT_REPO:-}
GFB=${SNAP_GIT_BACKUP:-}
mkdir -p "$SNAP/tmp"
chmod 700 "$SNAP"

# The snapshot lock is held by tmp-snapshot.ts (file-lock) for the whole run.

EXCLUDES=(${SNAP_EXCLUDES:-})
rsync_args=(-a --ignore-errors --delete-after)
for x in ${EXCLUDES[@]+"${EXCLUDES[@]}"}; do rsync_args+=(--exclude "$x"); done

ionice_cmd=""
if command -v ionice >/dev/null 2>&1; then ionice_cmd="ionice -c3"; fi
nice -n 10 $ionice_cmd rsync "${rsync_args[@]}" /tmp/ "$SNAP/tmp/"
rc=$?
if [[ $rc -ne 0 && $rc -ne 23 && $rc -ne 24 ]]; then
  echo "rsync /tmp failed with $rc" >&2
fi

# Git patch backup is opt-in: set snapshot.git_repo + snapshot.git_backup.
if [[ -n $GF && -n $GFB ]] && git -C "$GF" rev-parse --git-dir >/dev/null 2>&1; then
  mkdir -p "$GFB"
  chmod 700 "$GFB" "$(dirname "$GFB")"
  tmpb=$(mktemp -d "$GFB.new.XXXXXX")
  fail=0
  while IFS= read -r wt; do
    [[ -d "$wt" ]] || continue
    out="$tmpb/$(basename "$wt")"
    mkdir -p "$out"
    (
      cd "$wt" &&
        git diff --cached --binary >"$out/staged.patch" &&
        git diff --binary >"$out/unstaged.patch" &&
        git status --short >"$out/status.txt" &&
        git rev-parse HEAD >"$out/HEAD" &&
        { git branch --show-current >"$out/BRANCH"; true; } &&
        { git ls-files -o --exclude-standard -z | xargs -0 -r tar czf "$out/untracked.tgz"; } &&
        { [[ ! -d docs ]] || tar czf "$out/docs.tgz" docs; }
    ) || { echo "repo backup failed for $wt" >&2; fail=1; }
  done < <(git -C "$GF" worktree list --porcelain | awk '/^worktree /{wt=substr($0,10)} /^bare$/{wt=""} /^$/{if(wt!="")print wt; wt=""} END{if(wt!="")print wt}')
  if (( fail == 0 )); then rm -rf "$GFB" && mv "$tmpb" "$GFB"; else rm -rf "$tmpb"; fi
fi

if [[ $(uname -s) == Darwin ]]; then
  stamp=$(date +%Y-%m-%dT%H:%M:%S%z)
  stamp="${stamp%??}:${stamp: -2}"
else
  stamp=$(date -Is)
fi
echo "$stamp" >"$SNAP/LAST_SNAPSHOT"
echo "snapshot done $(cat "$SNAP/LAST_SNAPSHOT")"
