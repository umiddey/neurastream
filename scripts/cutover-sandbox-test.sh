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
			\( -path ./.local/state/neurastream -o -path ./.npm \) -prune -o \
			-type f -printf 'f %p ' -exec sha256sum {} \; \
			-o -type l -printf 'l %p -> ' -exec readlink {} \; \
			-o -type d -printf 'd %p/\n' | LC_ALL=C sort | sha256sum | cut -d' ' -f1
	)
}

build_home() {
	cd /
	rm -rf "$HOME"
	mkdir -p "$HOME"
	OLD="$HOME/opt/neurastream-old"
	mkdir -p "$OLD" "$HOME/.local/bin" "$HOME/projects" "$HOME/Work/toy/docs/plans"
	cp -r "$ROOT/src" "$ROOT/bin" "$ROOT/templates" "$OLD/"
	cp "$ROOT/package.json" "$OLD/package.json"
	# Today's live bins are links into the installed copy; same shape here.
	for f in "$OLD"/bin/*; do
		ln -s "$f" "$HOME/.local/bin/$(basename "$f")"
	done
	# omp-side live files as today's layout has them.
	mkdir -p "$HOME/.omp/agent/extensions" "$HOME/.omp/agent/queue" "$HOME/.omp/agent/agents" "$HOME/.omp/agent/sessions"
	cp "$OLD/src/adapters/omp/index.ts" "$HOME/.omp/agent/extensions/neurastream.ts"
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
