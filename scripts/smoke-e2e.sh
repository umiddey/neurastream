#!/usr/bin/env bash
# P6 sandbox smoke. Never touches the real HOME. Transcript: docs/smoke.md
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOME_DIR=/tmp/neurastream-home-e2e
TRANSCRIPT="$ROOT/docs/smoke.md"
LOG="$(mktemp)"
exec > >(tee "$LOG") 2>&1

fail() {
	echo "SMOKE FAIL: $*"
	cp "$LOG" "$TRANSCRIPT"
	exit 1
}

echo "# neurastream P6 sandbox smoke"
echo
echo "date: $(date -Is)"
echo "HOME=$HOME_DIR"
echo

rm -rf "$HOME_DIR"
mkdir -p "$HOME_DIR"
PACK="$(mktemp -d)"

echo "## bun pm pack"
(cd "$ROOT" && bun pm pack --destination "$PACK") || fail "bun pm pack"
TARBALL="$(find "$PACK" -name 'neurastream-*.tgz' -print -quit)"
test -n "$TARBALL" || fail "no tarball"
echo "tarball=$TARBALL"
tar -tzf "$TARBALL" | grep -q 'src/cli/main.ts' || fail "tarball missing the CLI"
tar -tzf "$TARBALL" | grep -q 'templates/queue/TEMPLATE.md' || fail "tarball missing the queue template"
tar -tzf "$TARBALL" | grep -q 'blockers/no-push' || fail "tarball missing blockers"

echo
echo "## install tarball under HOME=$HOME_DIR"
export HOME="$HOME_DIR"
export BUN_INSTALL="$HOME_DIR/.bun"
mkdir -p "$BUN_INSTALL/bin"
export PATH="$BUN_INSTALL/bin:/home/ukd/.bun/bin:/usr/bin:/bin"
env -u QUEUE_AGENT -u QUEUE_INDEX -u QUEUE_BLOCKERS -u QUEUE_STATE -u QUEUE_SUBAGENTS -u QUEUE_CANCELLED -u QUEUE_UNLOCK \
	bun add -g "$TARBALL" || fail "bun add -g"
command -v neurastream || fail "neurastream not on PATH"
echo "neurastream=$(command -v neurastream)"

run() {
	env -u QUEUE_AGENT -u QUEUE_INDEX -u QUEUE_BLOCKERS -u QUEUE_STATE -u QUEUE_SUBAGENTS -u QUEUE_CANCELLED -u QUEUE_UNLOCK \
		"$@"
}

echo
echo "## neurastream init"
run neurastream init || fail "init"
echo
echo "## tree hash before second init"
hash_tree() {
	find "$HOME_DIR" \( -type f -o -type l -o -type d \) ! -path "$HOME_DIR" -print0 |
		sort -z |
		while IFS= read -r -d '' p; do
			rel="${p#"$HOME_DIR"/}"
			if [ -L "$p" ]; then
				printf 'link %s -> %s\n' "$rel" "$(readlink "$p")"
			elif [ -d "$p" ]; then
				printf 'dir %s/\n' "$rel"
			else
				printf 'file %s %s\n' "$rel" "$(sha256sum "$p" | awk '{print $1}')"
			fi
		done |
		sha256sum |
		awk '{print $1}'
}
HASH1="$(hash_tree)"
echo "hash=$HASH1"
echo
echo "## neurastream init (second run)"
run neurastream init || fail "second init"
HASH2="$(hash_tree)"
echo "hash=$HASH2"
test "$HASH1" = "$HASH2" || fail "second init changed the tree ($HASH1 vs $HASH2)"
echo "idempotent: tree hash unchanged"

echo
echo "## neurastream adapter install omp"
run neurastream adapter install omp || fail "adapter install"
test -L "$HOME_DIR/.omp/agent/extensions/neurastream.ts" || fail "extension link missing"
test -L "$HOME_DIR/.omp/plugins/node_modules/neurastream" || fail "plugin link missing"
echo "extension -> $(readlink "$HOME_DIR/.omp/agent/extensions/neurastream.ts")"
echo "plugin -> $(readlink "$HOME_DIR/.omp/plugins/node_modules/neurastream")"
run neurastream config --json | grep -q '"name": "omp"' || fail "overlay not loaded"

echo
echo "## toy repo + plan"
TOY="$HOME_DIR/projects/toy"
ORIGIN="$HOME_DIR/origin.git"
mkdir -p "$TOY" "$ORIGIN"
git init --bare -b main "$ORIGIN"
git -C "$ORIGIN" symbolic-ref HEAD refs/heads/main
git -C "$TOY" init -b main
git -C "$TOY" config user.email "smoke@example.com"
git -C "$TOY" config user.name "smoke"
git -C "$TOY" remote add origin "$ORIGIN"
printf '/INDEX.md\n' > "$TOY/.gitignore"
printf 'hello\n' > "$TOY/README"
git -C "$TOY" add .gitignore README
git -C "$TOY" commit -m "init"
git -C "$TOY" push -u origin main
git -C "$TOY" checkout -b feat/toy
printf 'toy\n' > "$TOY/TOY"
git -C "$TOY" add TOY
git -C "$TOY" commit -m "toy"
SHA="$(git -C "$TOY" rev-parse HEAD)"
git -C "$TOY" checkout main
git -C "$TOY" merge --ff-only feat/toy
git -C "$TOY" push origin main
git -C "$TOY" fetch origin
git -C "$TOY" remote set-head origin main
mkdir -p "$TOY/docs/plans"
PLAN="$TOY/docs/plans/toy.md"
cat > "$PLAN" <<EOF
# Toy
Worktree: -
Branch: feat/toy
PRIORITY-ID:

## Goal
- land a toy file

## Forbidden
- do not push

## Blockers
- no-push
- deny-command git\\s+push

## Phases
- [ ] P1 toy file — difficulty: 3 — verify: \`test -f README\`

## Done check
\`test -f README\`

## Progress
Status: open
- smoke started
EOF
printf '%s\n' "docs/plans/toy.md" > "$TOY/INDEX.md"
printf '%s\n' "$TOY" > "$HOME_DIR/.config/neurastream/INDEX.md"
git -C "$TOY" add docs/plans/toy.md
git -C "$TOY" commit -m "add toy plan"
echo "plan=$PLAN"
echo "commit=$SHA"

echo
echo "## queue-check"
set +e
QC_OUT="$(run queue-check 2>&1)"
QC=$?
set -e
printf '%s\n' "$QC_OUT"
echo "queue-check exit $QC"
test "$QC" = 0 || fail "queue-check exit $QC"
printf '%s\n' "$QC_OUT" | grep -q '^Queue ' || fail "queue-check did not print a queue summary"

echo
echo "## agent-score accept"
run agent-score accept grok --plan "$PLAN" --phase P1 --commits "$SHA" --repo "$TOY" --branch feat/toy || fail "agent-score accept"
echo
echo "## agent-score board"
run agent-score board || fail "agent-score board"
test -s "$HOME_DIR/.config/neurastream/notes/subagent-ranking.md" || fail "ranking board missing"

echo
echo "## blocker refusal"
set +e
run neurastream guard pre-tool --json <<EOF
{"tool":"bash","input":{"command":"git push origin feat/toy"},"cwd":"$TOY","agent":"sub","agentId":"smoke","calls":1,"paths":["$TOY/README"],"writes":[],"command":"git push origin feat/toy"}
EOF
BR=$?
set -e
echo "guard pre-tool exit $BR"
test "$BR" = 2 || fail "blocker did not refuse (exit $BR)"

echo
echo "## queue-close on merged feat/toy"
python3 - "$PLAN" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1])
text = p.read_text()
text = text.replace("Status: open", "Status: complete", 1)
p.write_text(text)
PY
set +e
run queue-close "$PLAN"
CLOSE=$?
set -e
echo "queue-close exit $CLOSE"
test "$CLOSE" = 0 || fail "queue-close exit $CLOSE"
test ! -f "$PLAN" || fail "plan still indexed in place"
echo
echo "SMOKE PASS"
cp "$LOG" "$TRANSCRIPT"
rm -rf "$PACK"
exit 0
