#!/usr/bin/env bash
# Exercise scripts/cutover.sh and scripts/rollback.sh in a throwaway HOME built
# to look like today's live layout: bins under .local/bin, the omp extension,
# queue lib and template, agent pins, config, notes, blockers, an INDEX with one
# toy repo and one open plan for brief-lint. No secrets and no sessions are
# copied: the "old install" is a plain copy of this checkout, which is the same
# code the live scripts ported. Two cases:
#   1. cutover succeeds and the before/after captures match;
#   2. a deliberately broken bin forces the automatic rollback; afterwards the
#      tree hash equals the pre-cutover hash (excluding the kept backup dir
#      ~/.local/state/neurastream and npm's ~/.npm cache).
# Run with HOME=/tmp/neurastream-home-<name>; the whole HOME is scratch and is
# rebuilt between the cases.
set -euo pipefail
: "${HOME:?HOME is required}"
case "$HOME" in
/tmp/neurastream-home-*) ;;
*)
	echo "refusing: run with HOME=/tmp/neurastream-home-<name>" >&2
	exit 2
	;;
esac
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# The frozen copies of today's three live extension files (P8): the sandbox
# seeds their NAMES from here, and case 2 proves rollback restores them
# byte-identically against them.
FIX_EXT="$ROOT/tests/fixtures/originals/agent/extensions"
# Logs stay out of HOME: the case-2 hash is the tree before cutover, and a log
# created by this script is not part of that tree.
LOGDIR="$(mktemp -d)"
trap 'rm -rf "$LOGDIR"' EXIT

# Content + structure hash of the fake HOME; directory entries count, mtimes do
# not (same rule as src/cli/init.ts treeHash). The kept backup dir and npm's
# cache are excluded: the backup stays by design, the cache is npm's.
tree_hash() {
	(
		cd "$1" && find . -mindepth 1 \
			\( -path ./.local/state/neurastream -o -path ./.npm -o ! -readable \) -prune -o \
			-type f -printf 'f %p ' -exec sha256sum {} \; \
			-o -type l -printf 'l %p -> ' -exec readlink {} \; \
			-o -type d -printf 'd %p/\n' | LC_ALL=C sort | sha256sum | cut -d' ' -f1
	)
}

build_home() {
	cd /
	[ -d "$HOME" ] && chmod -R u+rwx "$HOME" 2>/dev/null
	rm -rf "$HOME"
	mkdir -p "$HOME"
	OLD="$HOME/opt/neurastream-old"
	mkdir -p "$OLD" "$HOME/.local/bin" "$HOME/projects" "$HOME/Work/toy/docs/plans"
	# A real HOME holds dirs its owner cannot read (rootless podman storage owned by a
	# subuid); the 2026-10-21 live cutover aborted on find's "Permission denied" there.
	mkdir -p "$HOME/.local/share/containers/storage/overlay/x/diff/home/runner"
	chmod 000 "$HOME/.local/share/containers/storage/overlay/x/diff/home"
	cp -r "$ROOT/src" "$ROOT/bin" "$ROOT/templates" "$OLD/"
	cp "$ROOT/package.json" "$OLD/package.json"
	# Today's live bins are links into the installed copy; same shape here.
	for f in "$OLD"/bin/*; do
		ln -s "$f" "$HOME/.local/bin/$(basename "$f")"
	done
	# omp-side live files as today's real layout has them (P8): main-guard.ts,
	# plan-guard.ts, herdr-omp-agent-state.ts — content from the frozen fixture
	# — and NO neurastream.ts (the cutover's install creates that, today's live
	# dir does not hold it).
	mkdir -p "$HOME/.omp/agent/extensions" "$HOME/.omp/agent/queue" "$HOME/.omp/agent/agents" "$HOME/.omp/agent/sessions"
	for f in main-guard.ts plan-guard.ts herdr-omp-agent-state.ts; do
		cp "$FIX_EXT/$f" "$HOME/.omp/agent/extensions/$f"
	done
	cp "$OLD/src/core/queue/lib.ts" "$HOME/.omp/agent/queue/lib.ts"
	cp "$OLD/templates/queue/TEMPLATE.md" "$HOME/.omp/agent/queue/TEMPLATE.md"
	cp "$OLD"/templates/agents/*.md "$HOME/.omp/agent/agents/"
	# Config-side state via the old package's own init, then the queue index.
	HOME="$HOME" bun "$OLD/src/cli/main.ts" init >/dev/null
	# A real indexed repo so queue-check exits 0. The kept marker is the repo
	# path: a bare "keep-index" line is parsed as a missing repo and the
	# restored-bin check would fail for the fixture, not the rollback.
	mkdir -p "$HOME/Work/keep-index/docs/plans"
	cat >"$HOME/Work/keep-index/docs/plans/keep.md" <<'PLAN'
# Keep
Worktree: -
Branch: -

## Goal
- keep

## Forbidden
- none

## Blockers
- no-push

## Phases
- [ ] P1 step — difficulty: 1 — verify: `true`

## Done check
`true`

## Progress
Status: open
PLAN
	printf '%s\n' "$HOME/Work/keep-index/docs/plans/keep.md" >"$HOME/Work/keep-index/INDEX.md"
	printf '%s\n' "$HOME/Work/keep-index" >"$HOME/.config/neurastream/INDEX.md"
	printf '\n%s\n' 'keep-note' >>"$HOME/.config/neurastream/notes/lessons.md"
	printf '\n%s\n' '# keep-config' >>"$HOME/.config/neurastream/config.yml"
	mkdir -p "$HOME/.local/state/queue"
	printf '%s\n' 'keep-queue' >"$HOME/.local/state/queue/keep-state"
	# The same lint-clean open-plan fixture the golden tests use.
	cat >"$HOME/Work/toy/docs/plans/20261019_toy.md" <<PLAN
Read $HOME/projects/opus-implementer-method.md first
# Acceptance
never push
find is broken
stop within 40 calls
PLAN
	# Nothing is on npm yet: the cutover installs the tarball packed from this
	# checkout, exactly what the publish workflow would ship.
	mkdir -p "$HOME/pkg"
	( cd "$ROOT" && npm pack --silent --pack-destination "$HOME/pkg" >/dev/null )
	local tarball
	tarball="$(ls "$HOME"/pkg/neurastream-*.tgz)"
	test -f "$tarball"
	export NEURASTREAM_TARBALL="$tarball"
}

kept() {
	grep -qx "$HOME/Work/keep-index" "$HOME/.config/neurastream/INDEX.md"
	grep -qx 'keep-note' "$HOME/.config/neurastream/notes/lessons.md"
	grep -qx '# keep-config' "$HOME/.config/neurastream/config.yml"
	grep -qx 'keep-queue' "$HOME/.local/state/queue/keep-state"
}

echo "== case 1: cutover succeeds, captures match"
build_home
log="$LOGDIR/case1.log"
if ! bash "$ROOT/scripts/cutover.sh" >"$log" 2>&1; then
	echo "cutover-sandbox-test: case 1 cutover failed:" >&2
	cat "$log" >&2
	exit 1
fi
grep -q "^cutover: outputs match$" "$log" || {
	echo "cutover-sandbox-test: case 1 missing success line:" >&2
	cat "$log" >&2
	exit 1
}
if grep -q "rolling back" "$log"; then
	echo "cutover-sandbox-test: case 1 rolled back unexpectedly:" >&2
	cat "$log" >&2
	exit 1
fi
target="$(readlink -f "$HOME/.local/bin/queue-check")"
case "$target" in
"$HOME"/.bun/install/global/node_modules/neurastream/*) ;;
*)
	echo "cutover-sandbox-test: case 1 bin not from the installed package: $target" >&2
	exit 1
	;;
esac
ls "$HOME"/.local/state/neurastream/cutover-*.tar >/dev/null
gbin="$(HOME="$HOME" BUN_INSTALL="$HOME/.bun" bun pm bin -g)"
case "$gbin" in
"$HOME"/*) ;;
*)
	echo "cutover-sandbox-test: global bin not under HOME: $gbin" >&2
	exit 1
	;;
esac
test -x "$gbin/neurastream"
HOME="$HOME" BUN_INSTALL="$HOME/.bun" "$gbin/neurastream" doctor >/dev/null
# P8: exactly one guard set survives the cutover. The old standalone guard
# extensions are backed up and removed (the package's adapter replaces them,
# docs/inventory.md), herdr's file stays (herdr owns it; the adapter never
# touches it), and the package's own extension is present.
for f in main-guard.ts plan-guard.ts; do
	[ ! -e "$HOME/.omp/agent/extensions/$f" ] || { echo "cutover-sandbox-test: $f survived the cutover; both guard sets would load" >&2; exit 1; }
done
test -f "$HOME/.omp/agent/extensions/herdr-omp-agent-state.ts" || {
	echo "cutover-sandbox-test: herdr-omp-agent-state.ts removed though the package does not replace it" >&2
	exit 1
}
[ -e "$HOME/.omp/agent/extensions/neurastream.ts" ] || [ -e "$HOME/.omp/plugins/node_modules/neurastream" ] || {
	echo "cutover-sandbox-test: no package extension after the cutover" >&2
	exit 1
}
kept || {
	echo "cutover-sandbox-test: case 1 dropped INDEX, notes, config or queue state" >&2
	exit 1
}


echo "== case 2: broken bin forces rollback; tree hash equals pre-cutover"
build_home
pre2="$(tree_hash "$HOME")"
log2="$LOGDIR/case2.log"
if NEURASTREAM_CUTOVER_BREAK=1 bash "$ROOT/scripts/cutover.sh" >"$log2" 2>&1; then
	echo "cutover-sandbox-test: case 2 cutover should have failed:" >&2
	cat "$log2" >&2
	exit 1
fi
grep -q "rolling back" "$log2" || {
	echo "cutover-sandbox-test: case 2 did not roll back:" >&2
	cat "$log2" >&2
	exit 1
}
post="$(tree_hash "$HOME")"
# P8: the three live extension files are back byte-identical from the tar.
for f in main-guard.ts plan-guard.ts herdr-omp-agent-state.ts; do
	cmp -s "$FIX_EXT/$f" "$HOME/.omp/agent/extensions/$f" || {
		echo "cutover-sandbox-test: case 2 did not restore $f byte-identical" >&2
		exit 1
	}
done
if [ "$pre2" != "$post" ]; then
	echo "cutover-sandbox-test: case 2 tree hash differs after rollback" >&2
	echo "pre:  $pre2" >&2
	echo "post: $post" >&2
	exit 1
fi
kept || {
	echo "cutover-sandbox-test: case 2 rollback dropped kept state" >&2
	exit 1
}

ls "$HOME"/.local/state/neurastream/cutover-*.tar >/dev/null
if ! HOME="$HOME" "$HOME/.local/bin/queue-check" >/dev/null; then
	echo "cutover-sandbox-test: case 2 restored queue-check failed" >&2
	HOME="$HOME" "$HOME/.local/bin/queue-check" >&2
	exit 1
fi
echo "cutover-sandbox-test: PASS"
