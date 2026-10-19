#!/usr/bin/env bash
# Keeps ONE rolling snapshot of work in /tmp (tmpfs: wiped on crash/reboot)
# plus the uncommitted Gateforge work, overwriting the previous snapshot.
#
# Targets (single copy each, overwritten every run):
#   /home/ukd/Work/tmp-snapshot/tmp/      mirror of /tmp minus caches/system dirs
#   /home/ukd/Work/gf-backups/latest/     gateforge staged/unstaged patches,
#                                         untracked files, docs/, HEAD
# Run by tmp-snapshot.timer (systemd --user). Safe to run by hand.
set -uo pipefail

SNAP=/home/ukd/Work/tmp-snapshot
GF=/home/ukd/Work/gateforge
GFB=/home/ukd/Work/gf-backups/latest
LOCK=/home/ukd/.cache/tmp-snapshot.lock
mkdir -p "$SNAP/tmp" "$GFB" "$(dirname "$LOCK")"
chmod 700 "$SNAP" /home/ukd/Work/gf-backups

exec 9>"$LOCK"
flock -n 9 || { echo "snapshot already running"; exit 0; }

# 1. /tmp mirror WITH --delete-after (owner 2026-10-09): files deleted from /tmp are also
# removed from the snapshot, so it stays the size of /tmp instead of growing forever (it
# reached 35 GB without --delete). One copy, overwritten in place. Caches and
# system/runtime dirs are skipped (and never deleted from the snapshot, since excluded);
# unreadable (root-owned) files are skipped instead of failing the whole run
# (rsync exit 23/24 = partial, accepted).
nice -n 10 ionice -c3 rsync -a --ignore-errors --delete-after \
  --exclude 'playwright-transform-cache-*' \
  --exclude 'pytest-of-*' \
  --exclude 'systemd-private-*' \
  --exclude '.X11-unix' --exclude '.ICE-unix' --exclude '.XIM-unix' --exclude '.font-unix' \
  --exclude 'snap-private-tmp' \
  --exclude 'gf-luna' \
  --exclude '*.sock' \
  /tmp/ "$SNAP/tmp/"
rc=$?
if [[ $rc -ne 0 && $rc -ne 23 && $rc -ne 24 ]]; then
  echo "rsync /tmp failed with $rc" >&2
fi

# 2. Uncommitted Gateforge work. $GF is a BARE repo (since ~2026-10-04); the work lives in
# its worktrees, so back up each non-bare worktree into $GFB/<worktree name>/ (the old
# single-repo backup ran `git diff` in the bare repo and failed every run from 10-04 to 10-09).
if git -C "$GF" rev-parse --git-dir >/dev/null 2>&1; then
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
    ) || { echo "gateforge backup failed for $wt" >&2; fail=1; }
  done < <(git -C "$GF" worktree list --porcelain | awk '/^worktree /{wt=substr($0,10)} /^bare$/{wt=""} /^$/{if(wt!="")print wt; wt=""} END{if(wt!="")print wt}')
  if (( fail == 0 )); then rm -rf "$GFB" && mv "$tmpb" "$GFB"; else rm -rf "$tmpb"; fi
fi

date -Is >"$SNAP/LAST_SNAPSHOT"
echo "snapshot done $(cat "$SNAP/LAST_SNAPSHOT")"
