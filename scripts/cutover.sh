#!/usr/bin/env bash
# Replace this HOME's live orchestration files with the installed neurastream
# package, then prove the swap changed nothing observable: capture queue-check,
# agent-ledger --cap, brief-lint on an open plan and main-start before and
# after. Any output or exit mismatch, or any install failure, rolls back
# automatically from the backup tar via rollback.sh. The tar and its file
# listing are kept under ~/.local/state/neurastream/ and printed on success.
#
# Test only under HOME=/tmp/neurastream-home-* (scripts/cutover-sandbox-test.sh);
# the real cutover is Main's, run from a checkout of this repo after the npm
# version to install exists on the registry. NEURASTREAM_TARBALL installs a
# local tarball instead of neurastream@VERSION (sandbox tests); the
# NEURASTREAM_CUTOVER_BREAK=1 hook breaks queue-check after the install to
# prove the rollback path (sandbox tests only).
#
# bun add -g follows BUN_INSTALL, not HOME. A parent shell often has
# BUN_INSTALL pointing at the real ~/.bun; this script overrides it so the
# global bin dir is whatever `bun pm bin -g` prints under this HOME.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOME_DIR="${HOME:?HOME is required}"
VERSION="$(bun -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version)' "$ROOT/package.json")"
STATE="$HOME_DIR/.local/state/neurastream"
STAMP="$(date +%Y%m%d-%H%M%S)"
TAR="$STATE/cutover-$STAMP.tar"
PRE="$STATE/cutover-$STAMP.pre"
mkdir -p "$STATE"
export BUN_INSTALL="$HOME_DIR/.bun"
export PATH="$HOME_DIR/.local/bin:${PATH:-/usr/bin:/bin}"

# Volatile machine numbers, stripped the same way the golden tests strip them
# before comparing oracle and port: timestamps, load average, memory and disk
# sizes. Both captures pass through this, so only behaviour survives the diff.
normalize() {
	sed -E \
		-e 's/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.,][0-9]+)?(Z|[+-][0-9]{2}:?[0-9]{2})?/TS/g' \
		-e 's/^[0-9]{2}:[0-9]{2}:[0-9]{2} /TS /' \
		-e 's/^[0-9.]+ [0-9.]+ [0-9.]+ [0-9]+\/[0-9]+ [0-9]+$/LOADAVG/' \
		-e 's/load=[0-9.]+ [0-9.]+ [0-9.]+/load=L L L/g' \
		-e 's/avail=[0-9]+MB swapfree=[0-9]+MB home_free=[0-9]+G/avail=AMB swapfree=SM home_free=HG/g' \
		-e 's/load [0-9.]+ > [0-9]+/load N > N/g' \
		-e 's/MemAvailable [0-9]+MB < [0-9]+MB/MemAvailable NMB < NMB/g' \
		-e 's|/home free [0-9]+G < [0-9]+G|/home free NG < NG|g' \
		-e 's|/tmp \(RAM tmpfs\) [0-9]+MB > [0-9]+MB|/tmp (RAM tmpfs) NMB > NMB|g'
}

capture() {
	local out="$1"
	local plan cap="$STATE/cap"
	mkdir -p "$cap"
	plan="$(find "$HOME_DIR/Work" "$HOME_DIR/projects" -path '*/docs/plans/*.md' -type f 2>/dev/null | head -1 || true)"
	{
		echo "=== queue-check exit=$(queue-check >"$cap/qc.out" 2>"$cap/qc.err"; echo $?)"
		normalize <"$cap/qc.out"
		echo "=== agent-ledger exit=$(agent-ledger --cap >"$cap/al.out" 2>"$cap/al.err"; echo $?)"
		normalize <"$cap/al.out"
		if [ -n "$plan" ]; then
			echo "=== brief-lint exit=$(brief-lint "$plan" >"$cap/bl.out" 2>"$cap/bl.err"; echo $?)"
			normalize <"$cap/bl.out"
		else
			echo "=== brief-lint exit=missing"
		fi
		echo "=== main-start exit=$(main-start >"$cap/ms.out" 2>"$cap/ms.err"; echo $?)"
		# The doctor section names install paths that legitimately change with the
		# package root, and the registry check needs the network; dropped on both
		# sides, like every other capture-specific constant.
		sed '/^=== doctor$/,$d' "$cap/ms.out" | normalize
	} >"$out"
}

strip_tmp() {
	rm -rf "$STATE/cap"
}

rollback() {
	bash "$ROOT/scripts/rollback.sh" "$TAR"
}

cd "$HOME_DIR"
# Pre-image before any capture. Captures write machine state (for example
# .cache/resource-alerts) that was not in the tree the caller hashed; rollback
# must delete those paths too, not only the install.
# Dirs the owner cannot read (rootless container storage owned by a subuid) are
# pruned: the cutover cannot create anything inside them, and find's
# "Permission denied" would abort the run under pipefail.
find . -mindepth 1 ! -readable -prune -o -print | sed 's|^\./||' | LC_ALL=C sort >"$PRE"
capture "$STATE/before-$STAMP.txt"

# Back up every live file this cutover replaces. Free only the slots the
# adapter installer refuses to overwrite (an existing file that is not its own
# link). config.yml is backed up so a failed overlay can be restored, but it
# is not removed: neurastream init leaves an existing config, INDEX, notes and
# queue state byte-for-byte alone, and today's values must survive.
# P8: the package's omp adapter replaces the old standalone guard extensions
# main-guard.ts and plan-guard.ts (both guards' rules ship inside the package
# extension, docs/inventory.md) — leaving them would load every guard twice.
# herdr-omp-agent-state.ts stays: herdr installs and owns it, the adapter
# never touches it (docs/inventory.md).
files=()
while IFS= read -r name; do
	files+=(".local/bin/$name")
done < <(bun -e 'const p = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); for (const n of Object.keys(p.bin ?? {})) console.log(n)' "$ROOT/package.json")
files+=(".omp/agent/extensions/neurastream.ts" ".omp/agent/extensions/main-guard.ts" ".omp/agent/extensions/plan-guard.ts" ".omp/agent/queue/lib.ts" ".omp/agent/queue/TEMPLATE.md" ".config/neurastream/config.yml")
exist=()
for f in "${files[@]}"; do
	if [ -e "$f" ] || [ -L "$f" ]; then exist+=("$f"); fi
done
if [ "${#exist[@]}" -gt 0 ]; then
	tar -cf "$TAR" "${exist[@]}"
else
	tar -cf "$TAR" --files-from /dev/null
fi
echo "$TAR"

for f in "${exist[@]}"; do
	case "$f" in
	.config/neurastream/config.yml) continue ;;
	esac
	rm -rf "$f"
done

spec="neurastream@$VERSION"
if [ -n "${NEURASTREAM_TARBALL:-}" ]; then spec="$NEURASTREAM_TARBALL"; fi
if ! HOME="$HOME_DIR" BUN_INSTALL="$BUN_INSTALL" bun add -g "$spec"; then
	echo "cutover: bun add -g failed; rolling back" >&2
	rollback
	strip_tmp
	exit 1
fi
if ! GLOBAL_BIN="$(bun pm bin -g)"; then
	echo "cutover: bun pm bin -g failed; rolling back" >&2
	rollback
	strip_tmp
	exit 1
fi
case "$GLOBAL_BIN" in
"$HOME_DIR"/*) ;;
*)
	echo "cutover: bun global bin is not under this HOME ($GLOBAL_BIN); rolling back" >&2
	rollback
	strip_tmp
	exit 1
	;;
esac
if [ ! -x "$GLOBAL_BIN/neurastream" ]; then
	echo "cutover: neurastream missing at $GLOBAL_BIN/neurastream; rolling back" >&2
	rollback
	strip_tmp
	exit 1
fi
export PATH="$GLOBAL_BIN:$PATH"
if ! HOME="$HOME_DIR" BUN_INSTALL="$BUN_INSTALL" "$GLOBAL_BIN/neurastream" init; then
	echo "cutover: neurastream init failed; rolling back" >&2
	rollback
	strip_tmp
	exit 1
fi
if ! HOME="$HOME_DIR" BUN_INSTALL="$BUN_INSTALL" "$GLOBAL_BIN/neurastream" adapter install omp; then
	echo "cutover: adapter install failed; rolling back" >&2
	rollback
	strip_tmp
	exit 1
fi

if [ "${NEURASTREAM_CUTOVER_BREAK:-}" = "1" ]; then
	rm -f "$HOME_DIR/.local/bin/queue-check"
	printf '%s\n' '#!/bin/sh' 'echo BROKEN' 'exit 9' >"$HOME_DIR/.local/bin/queue-check"
	chmod 755 "$HOME_DIR/.local/bin/queue-check"
fi

capture "$STATE/after-$STAMP.txt"
if ! diff -u "$STATE/before-$STAMP.txt" "$STATE/after-$STAMP.txt"; then
	echo "cutover: output diff; rolling back" >&2
	rollback
	strip_tmp
	exit 1
fi
strip_tmp
echo "cutover: outputs match"
