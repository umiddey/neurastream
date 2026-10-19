#!/usr/bin/env bash
# Restore replaced files from the cutover tar byte-for-byte and delete the
# paths the cutover created (deepest first), except the backup directory
# ~/.local/state/neurastream, whose tar and .pre listing are kept.
# Usage: rollback.sh <cutover-tar>
set -euo pipefail
TAR="${1:?usage: rollback.sh <cutover-tar>}"
PRE="${TAR%.tar}.pre"
test -f "$TAR"
test -f "$PRE"
HOME_DIR="${HOME:?HOME is required}"
cd "$HOME_DIR"
tar -xf "$TAR"
current="$(mktemp)"
find . -mindepth 1 -print | sed 's|^\./||' | LC_ALL=C sort >"$current"
LC_ALL=C comm -13 "$PRE" "$current" | LC_ALL=C sort -r | while IFS= read -r path; do
	case "$path" in
	.local/state/neurastream | .local/state/neurastream/*) continue ;;
	esac
	if [ -e "$path" ] || [ -L "$path" ]; then
		rm -rf "$path"
	fi
done
rm -f "$current"
echo "rollback: restored $TAR"
