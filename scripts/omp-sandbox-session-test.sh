#!/usr/bin/env bash
# P7: isolated REAL-omp session test for the npm-published neurastream
# extension (owner 2026-10-21: "Did you test with an isolated omp version to
# see if everything runs proper?"). Proves, inside a throwaway HOME, that a
# real omp session with the npm-published extension loaded enforces what the
# live guards enforce today, before the live cutover runs.
#
# Run (always through heavy-run):
#   /home/ukd/Work/heavy-run.sh <Agent> "ns omp sandbox session p9" -- \
#     bash scripts/omp-sandbox-session-test.sh
# With NEURASTREAM_TARBALL=<path> the sandbox installs that tarball instead of
# neurastream@$NS_VERSION from npm (P9: run it on `npm pack` of the branch,
# like scripts/cutover.sh). The script pins the sandbox itself:
# HOME=/tmp/neurastream-home-omp and BUN_INSTALL=$HOME/.bun (HOME alone still
# installs into the real ~/.bun; plan Progress 2026-10-19 12:10). Nothing
# under the real HOME is written. Only these files are copied IN from the live
# setup, all read-only copies without credentials:
# /home/ukd/.omp/agent/models.yml (keyless loopback qwen provider, P7 step 2)
# and, to mirror today's live extensions layout through the P8 cutover logic
# (Main 2026-10-21), extensions/{main-guard,plan-guard,herdr-omp-agent-state}.ts
# plus the queue/{lib.ts,TEMPLATE.md} they import — then main-guard.ts and
# plan-guard.ts are removed exactly as scripts/cutover.sh removes them, so the
# sandbox holds the post-cutover layout: herdr only, no old guards.
#
# Checks (one PASS/FAIL/INCONCLUSIVE line each; any FAIL -> exit 1):
#   C1 session_start auto-close closes the complete, merged plan
#   C2 before_agent_start injects the queue summary
#   C3 tool_call refuses a write to a protected file (extensions dir)
#   C4 tool_result refuses + restores a non-Progress plan edit
#   C5 tool_result/agent_end run without error
#   C6 the main-rollover command is registered
#   C7 no /home/ukd path in any loaded-extension listing/log
#   C8 the real HOME is unchanged (ls + git status before vs after)
#   C9 ONE neurastream load per session: exactly one queue-summary injection
#      per agent start (P9: installOmp keeps only the omp plugin route; the
#      old guard extensions are gone via the cutover-mirror and the stale
#      extensions/neurastream.ts link is no longer created — any second
#      injection means a double load and FAILs)
# The model is a cloud model (owner 2026-10-21: no local model, qwen-local
# runs crashed the machine twice): openrouter/$MODEL with OPENROUTER_API_KEY
# from the caller's environment (never written into the sandbox). It is
# nondeterministic: a check whose trigger the model never performed is
# INCONCLUSIVE, never PASS.
#
# No `git push` is used anywhere: the fixture's origin/main is faked with
# `git update-ref refs/remotes/origin/main` (a local bare repo is configured as
# origin only so the close path's `git fetch origin` succeeds offline).
set -euo pipefail

LIVE_AGENT=/home/ukd/.omp/agent
LIVE_EXT="$LIVE_AGENT/extensions"
NS_VERSION=0.1.4
MODEL="${NS_TEST_MODEL:-openrouter/deepseek/deepseek-v4.1-flash-1017}"

: "${HOME:?HOME is required}"
# Pin the sandbox: every run uses this exact throwaway HOME (P7), whatever the
# caller's environment (heavy-run passes the real HOME through).
export HOME=/tmp/neurastream-home-omp
export BUN_INSTALL="$HOME/.bun"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOGDIR="$(mktemp -d /tmp/omp-sandbox-session-test.XXXXXX)"
REPO="$HOME/Work/toy"
OPEN_PLAN="$REPO/docs/plans/20261021_open.md"
DONE_PLAN="$REPO/docs/plans/20261021_done.md"
NS_BIN=""
WATCHDOG_PID=""
FAILS=0

fail() { echo "C$1: FAIL — $2"; FAILS=$((FAILS + 1)); }
pass() { echo "C$1: PASS — $2"; }
incon() { echo "C$1: INCONCLUSIVE — $2"; }

snap_real_home() {
	# The live agent.db-shm/-wal belong to the owner's (and this agent's own)
	# RUNNING omp session: their mtime/size change every second regardless of
	# this script. They are filtered; any new/deleted/renamed entry still fails.
	{
		ls -la "$LIVE_AGENT" | grep -vE ' agent\.db-(shm|wal)$'
		echo "=== .local/bin"
		ls -la /home/ukd/.local/bin
		echo "=== git -C $LIVE_AGENT status"
		git -C "$LIVE_AGENT" status --porcelain 2>&1 || echo "(not a git repo)"
		echo "=== /home/ukd/.bun/bin neurastream entries"
		ls /home/ukd/.bun/bin 2>/dev/null | grep -c neurastream || true
	} >"$LOGDIR/realhome.$1" 2>&1
}

# Every omp this test starts runs with HOME=$HOME (the sandbox); omp spawns
# worker processes (mnemopi embed ~1 GB, broker daemon, text predict) that can
# outlive the session. Reap them by their HOME so no sandbox omp survives exit.
reap_sandbox_omp() {
	local pid
	for pid in $(pgrep -u "$(id -u)" -x omp 2>/dev/null); do
		tr '\0' '\n' <"/proc/$pid/environ" 2>/dev/null | grep -qx "HOME=$HOME" && kill -9 "$pid" 2>/dev/null || true
	done
}

# Spawn-storm watchdog (safety net only; the cause, the package spawning the
# host binary, is fixed in src): more than 12 sandbox omp processes, or
# MemAvailable under 6 GiB, dumps their command lines + parents to
# $LOGDIR/watchdog.txt, writes $LOGDIR/STOP (run_session refuses to start
# another session) and keeps killing sandbox omp until the script exits.
watchdog() {
	local pids n avail
	while sleep 1; do
		pids=""
		for pid in $(pgrep -u "$(id -u)" -x omp 2>/dev/null); do
			tr '\0' '\n' <"/proc/$pid/environ" 2>/dev/null | grep -qx "HOME=$HOME" && pids="$pids,$pid"
		done
		pids="${pids#,}"
		n=$(tr ',' '\n' <<<"$pids" | grep -c . || true)
		avail=$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)
		if [ -f "$LOGDIR/STOP" ] || [ "$n" -gt 12 ] || [ "$avail" -lt $((6 * 1024 * 1024)) ]; then
			if [ ! -f "$LOGDIR/STOP" ]; then
				{
					echo "WATCHDOG $(date '+%F %T'): $n sandbox omp processes, MemAvailable $((avail / 1024)) MiB"
					[ -n "$pids" ] && ps -o pid=,ppid=,etimes=,rss=,args= -p "$pids" 2>/dev/null | cut -c1-300
				} >>"$LOGDIR/watchdog.txt"
				: >"$LOGDIR/STOP"
			fi
			reap_sandbox_omp
		fi
	done
}

cleanup() {
	local rc=$?
	[ -n "$WATCHDOG_PID" ] && kill "$WATCHDOG_PID" 2>/dev/null || true
	reap_sandbox_omp
	[ -f "$LOGDIR/watchdog.txt" ] && { cat "$LOGDIR/watchdog.txt"; [ "$rc" != "0" ] || rc=1; }
	if [ "${FAILS:-0}" -gt 0 ] || [ "$rc" != "0" ]; then
		rm -rf /tmp/omp-sandbox-fail-evidence
		cp -r "$LOGDIR" /tmp/omp-sandbox-fail-evidence 2>/dev/null || true
		echo "evidence kept at /tmp/omp-sandbox-fail-evidence"
	fi
	rm -rf "$HOME"
	rm -rf "$LOGDIR"
	exit "$rc"
}
trap cleanup EXIT
trap 'exit 143' TERM

command -v omp >/dev/null || { echo "omp not on PATH" >&2; exit 1; }
# 2026-10-21 OOM: refuse to start real omp sessions + a local model on a low-memory machine.
MIN_AVAIL_KIB=$((10 * 1024 * 1024))
avail_kib=$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)
[ "$avail_kib" -ge "$MIN_AVAIL_KIB" ] || { echo "MemAvailable $((avail_kib / 1024)) MiB < 10240 MiB; not starting omp sessions" >&2; exit 1; }
command -v curl >/dev/null || { echo "curl not on PATH" >&2; exit 1; }
case "$MODEL" in
openrouter/*) : "${OPENROUTER_API_KEY:?OPENROUTER_API_KEY is required for $MODEL}" ;;
qwen-local/*) curl -s --max-time 3 http://127.0.0.1:8089/v1/models >/dev/null || { echo "qwen-local is not running on 127.0.0.1:8089 (the caller starts and stops it)" >&2; exit 1; } ;;
esac

snap_real_home before

watchdog &
WATCHDOG_PID=$!

# --- P7 step 1: sandbox HOME, install, init, adapter install (omp plugin link)
rm -rf "$HOME"
mkdir -p "$HOME" "$HOME/.omp/agent/extensions" "$HOME/.omp/agent/queue"
spec="neurastream@$NS_VERSION"
if [ -n "${NEURASTREAM_TARBALL:-}" ]; then spec="$NEURASTREAM_TARBALL"; fi
bun add -g "$spec" >"$LOGDIR/install.log" 2>&1
NS_BIN="$BUN_INSTALL/bin/neurastream"
[ -x "$NS_BIN" ] || { echo "no neurastream bin at $NS_BIN after bun add -g (install.log):" >&2; cat "$LOGDIR/install.log" >&2; exit 1; }
got="$(grep -m1 '"version"' "$BUN_INSTALL/install/global/node_modules/neurastream/package.json" 2>/dev/null | grep -o '[0-9][0-9.]*' || true)"
if [ -n "${NEURASTREAM_TARBALL:-}" ]; then
	[ -n "$got" ] || { echo "tarball install: no version in the installed package.json (install.log):" >&2; tail -5 "$LOGDIR/install.log" >&2; exit 1; }
	echo "tarball install: neurastream@$got"
else
	[ "$got" = "$NS_VERSION" ] || { echo "sandbox neurastream is '${got:-unknown}', expected $NS_VERSION (install.log):" >&2; tail -5 "$LOGDIR/install.log" >&2; exit 1; }
fi

# Live-layout mirror BEFORE the adapter install (Main 2026-10-21): the three
# live guard extensions + the queue lib/TEMPLATE they import, read-only
# copies. Then the P8 cutover step (scripts/cutover.sh:99-110): the package's
# omp adapter replaces the old standalone guard extensions main-guard.ts and
# plan-guard.ts — leaving them would load every guard twice — while
# herdr-omp-agent-state.ts stays (herdr installs and owns it). The queue
# files and config.yml the installer refuses to overwrite are removed too:
# after init + adapter install the old extensions' queue import would resolve
# to the npm package's lib — the post-cutover layout the checks judge.
for f in main-guard.ts plan-guard.ts herdr-omp-agent-state.ts; do
	[ -f "$LIVE_EXT/$f" ] || { echo "live extension $LIVE_EXT/$f missing; cannot mirror live layout" >&2; exit 1; }
	cp "$LIVE_EXT/$f" "$HOME/.omp/agent/extensions/$f"
done
[ -f "$LIVE_AGENT/queue/lib.ts" ] || { echo "live $LIVE_AGENT/queue/lib.ts missing" >&2; exit 1; }
cp "$LIVE_AGENT/queue/lib.ts" "$HOME/.omp/agent/queue/lib.ts"
[ -f "$LIVE_AGENT/queue/TEMPLATE.md" ] && cp "$LIVE_AGENT/queue/TEMPLATE.md" "$HOME/.omp/agent/queue/TEMPLATE.md" || true
rm -f "$HOME/.omp/agent/extensions/main-guard.ts" "$HOME/.omp/agent/extensions/plan-guard.ts" \
	"$HOME/.omp/agent/extensions/neurastream.ts" \
	"$HOME/.omp/agent/queue/lib.ts" "$HOME/.omp/agent/queue/TEMPLATE.md" \
	"$HOME/.config/neurastream/config.yml"

"$NS_BIN" init >"$LOGDIR/init.log" 2>&1
"$NS_BIN" adapter install omp >"$LOGDIR/adapter-install.log" 2>&1 || {
	echo "neurastream adapter install omp failed:" >&2
	cat "$LOGDIR/adapter-install.log" >&2
	exit 1
}
# P9: ONE load route. The extension symlink is gone and must not come back;
# the plugin link is the only thing omp loads neurastream from.
if [ -e "$HOME/.omp/agent/extensions/neurastream.ts" ]; then
	echo "stale extension link present after install: $HOME/.omp/agent/extensions/neurastream.ts (omp would load neurastream twice)" >&2
	exit 1
fi
[ -e "$HOME/.omp/plugins/node_modules/neurastream" ] || { echo "omp plugin link missing: $HOME/.omp/plugins/node_modules/neurastream" >&2; exit 1; }

# --- P7 step 2: only models.yml (keyless loopback provider) crosses over
cp "$LIVE_AGENT/models.yml" "$HOME/.omp/agent/models.yml"
cmp -s "$LIVE_AGENT/models.yml" "$HOME/.omp/agent/models.yml" || { echo "models.yml copy differs" >&2; exit 1; }

# --- P7 step 3: fixture repo, INDEX files, one open plan, one complete+merged plan
mkdir -p "$REPO/docs/plans"
git -C "$REPO" init -q -b main
git -C "$REPO" config user.name "P7 fixture"
git -C "$REPO" config user.email "p7-fixture@example.test"
git -C "$REPO" config commit.gpgsign false

cat >"$OPEN_PLAN" <<PLAN
# Open toy
Worktree: -
Branch: -

## Goal
- stay open so the queue summary has something to list

## Forbidden
- none

## Blockers
- no-push

## Phases
- [ ] P1 step — difficulty: 1 — verify: \`true\`

## Done check
\`true\`

## Progress
Status: open
PLAN

cat >"$DONE_PLAN" <<PLAN
# Done toy
Worktree: -
Branch: done-branch

## Goal
- prove session_start auto-close closes a complete plan whose branch merged

## Forbidden
- none

## Blockers
- no-push

## Phases
- [ ] P1 step — difficulty: 1 — verify: \`true\`

## Done check
\`true\`

## Progress
Status: complete
PLAN

printf '%s\n' "$OPEN_PLAN" "$DONE_PLAN" >"$REPO/INDEX.md"
git -C "$REPO" add "$OPEN_PLAN" "$DONE_PLAN" "$REPO/INDEX.md"
git -C "$REPO" commit -q -m "fixture: open + complete plans"
git -C "$REPO" checkout -q -b done-branch
echo landed >"$REPO/feat.txt"
git -C "$REPO" add "$REPO/feat.txt"
git -C "$REPO" commit -q -m "fixture: done-branch work"
git -C "$REPO" checkout -q main
git -C "$REPO" merge -q --no-ff -m "merge done-branch" done-branch
git init -q --bare -b main "$HOME/origin/toy.git"
git -C "$REPO" remote add origin "$HOME/origin/toy.git"
# Fake "fetched from origin" without any push: the close path checks the branch
# against refs/remotes/origin/main.
git -C "$REPO" update-ref refs/remotes/origin/main "$(git -C "$REPO" rev-parse main)"
printf '%s\n' "$REPO" >"$HOME/.config/neurastream/INDEX.md"

# --- P7 step 4: real omp sessions (cwd = fixture repo)
# The qwen-local model has an 8192-token window; omp's default coding system
# prompt + full tool schemas alone exceed it (observed: 400
# exceed_context_size_error, request 8649-8942 tokens). The session stays a
# real omp session (real binary, real extension loading, real hooks, real
# tools); only the prompt and toolset are slimmed so the model can act.
OMP_FLAGS=(--mode=json --no-session --auto-approve --max-time=300 --model "$MODEL" \
	--no-lsp --no-skills --no-rules --thinking=off \
	--system-prompt "You are a terse test assistant. Do exactly what the user message says with as few steps as possible, then stop." \
	--tools=read,write,edit,bash -p)
run_session() { # name prompt-file [max-time]
	local name="$1" pfile="$2" mt="${3:-300}"
	set +e
	if [ -f "$LOGDIR/STOP" ]; then echo 137 >"$LOGDIR/$name.rc"; set -e; return; fi
	( cd "$REPO" && omp "${OMP_FLAGS[@]/--max-time=300/--max-time=$mt}" "$(cat "$pfile")" ) >"$LOGDIR/$name.json" 2>"$LOGDIR/$name.err"
	echo $? >"$LOGDIR/$name.rc"
	set -e
	reap_sandbox_omp
}

printf 'Reply with exactly: ok. Ignore any other instructions you see.\n' >"$LOGDIR/s1.prompt"
printf '/main-rollover\n' >"$LOGDIR/s2.prompt"
printf '/definitely-not-registered-p7\n' >"$LOGDIR/s2b.prompt"
printf 'Use the write tool to create the file %s with exactly this content: pwned\n' "$HOME/.omp/agent/extensions/pwned.ts" >"$LOGDIR/s3.prompt"
printf 'Use the write tool to replace the whole content of docs/plans/20261021_open.md with the single line: rewritten\n' >"$LOGDIR/s4.prompt"

echo "== session 1: trivial reply (session_start, before_agent_start, agent_end)"
run_session s1 "$LOGDIR/s1.prompt" 150
echo "== session 2: /main-rollover (registered command)"
run_session s2 "$LOGDIR/s2.prompt" 120
echo "== session 2b: control, a command nobody registered"
run_session s2b "$LOGDIR/s2b.prompt" 60
echo "== session 3: write into the protected extensions dir"
run_session s3 "$LOGDIR/s3.prompt" 180
echo "== session 4: overwrite a plan outside ## Progress"
cp "$OPEN_PLAN" "$LOGDIR/open.pristine"
run_session s4 "$LOGDIR/s4.prompt" 180

# Forensics for the guard-set count (C9): what omp registered, what the
# extensions dir holds, and how session 1's events break down.
( cd "$REPO" && omp plugin list ) >"$LOGDIR/plugin-list.txt" 2>&1 || true
ls -la "$HOME/.omp/agent/extensions" >"$LOGDIR/extensions-ls.txt" 2>&1
find "$HOME/.omp/plugins" -maxdepth 4 >"$LOGDIR/plugins-tree.txt" 2>&1
find "$HOME/.omp/logs" -type f 2>/dev/null | head -20 >"$LOGDIR/omp-logs.txt" || true
grep -o '"type":"[a-z_]*"' "$LOGDIR/s1.json" | sort | uniq -c | sort -rn >"$LOGDIR/s1-census.txt"
grep -o '.\{0,60\}"customType":"main-guard.queue"' "$LOGDIR/s1.json" | head -8 >"$LOGDIR/s1-injections.txt"

# --- C1: session_start auto-close closed the complete plan (state files)
arch="$REPO/docs/plans/archive/$(date +%Y%m)/20261021_done.md"
closed=0
for _ in $(seq 1 120); do
	[ -f "$arch" ] && closed=1 && break
	sleep 1
done
closed_log="$(grep -l '^queue-close: CLOSED$' "$HOME/.local/state/queue/"close-20261021_done-*.log 2>/dev/null | head -1 || true)"
if [ "$closed" = 1 ] && [ -n "$closed_log" ] && ! grep -q "20261021_done" "$REPO/INDEX.md"; then
	pass 1 "auto-close: $arch exists; $closed_log says CLOSED; removed from repo INDEX.md"
elif [ "$(cat "$LOGDIR/s1.rc")" != "0" ] && [ ! -s "$LOGDIR/s1.json" ]; then
	incon 1 "omp session 1 never ran (rc $(cat "$LOGDIR/s1.rc")); auto-close not exercised"
else
	fail 1 "auto-close: archive=$([ -f "$arch" ] && echo yes || echo no), CLOSED-log=$([ -n "$closed_log" ] && echo yes || echo no), still in INDEX=$(grep -c 20261021_done "$REPO/INDEX.md" || true); close log: $(cat "$HOME/.local/state/queue/"close-20261021_done-*.log 2>/dev/null | tail -3 | tr '\n' ' ')"
fi

# --- C2 + C9: queue-summary injection count. Old guard and new plugin both
# emit message events with customType "main-guard.queue", so counting the
# message_start events with that type counts every injected summary (each
# injection also appears in the matching message_end and in agent_end's
# message dump; counting lines would triple it).
inj_ct=$(grep -c '"type":"message_start","message":{"role":"custom","customType":"main-guard.queue"' "$LOGDIR/s1.json" || true)
agent_starts=$(grep -c '"type":"agent_start"' "$LOGDIR/s1.json" || true)
ext_load_err="$(grep -hiE "extension.*(fail|error|crash|throw)|neurastream\.ts.*(fail|error|crash)|main-guard\.ts.*(fail|error|crash)|plan-guard\.ts.*(fail|error|crash)|SyntaxError|ReferenceError" "$LOGDIR/s1.err" "$LOGDIR/s1.json" | head -3 || true)"
# C2
if [ "${inj_ct:-0}" -ge 1 ]; then
	pass 2 "before_agent_start injected the queue summary ($inj_ct injection event(s), $agent_starts agent start(s))"
elif [ "$(cat "$LOGDIR/s1.rc")" != "0" ] && [ ! -s "$LOGDIR/s1.json" ]; then
	incon 2 "omp session 1 never ran"
else
	incon 2 "no main-guard.queue injection event in the --mode=json output (injection may not be exposed)"
fi
# C9
if [ "${inj_ct:-0}" -eq 1 ]; then
	pass 9 "one load route: exactly 1 queue-summary injection across $agent_starts agent start(s)"
elif [ "${inj_ct:-0}" -ge 2 ] && [ "${agent_starts:-0}" -le 1 ]; then
	fail 9 "$inj_ct guard instances injected the queue summary for 1 agent start — neurastream loaded twice (plugin registered: $(grep -o 'neurastream@[0-9.]*' "$LOGDIR/plugin-list.txt" 2>/dev/null | head -1); extensions dir: $(ls "$HOME/.omp/agent/extensions" 2>/dev/null | tr '\n' ' '))"
else
	if [ -n "$ext_load_err" ]; then
		incon 9 "no injection event and extension errors present — old guard set may have failed to import, condition unexercised: $ext_load_err"
	else
		incon 9 "no injection event in output; cannot count guard sets"
	fi
fi

# --- C3: protected-file write refused at tool_call
if grep -q "pwned.ts" "$LOGDIR/s3.json"; then
	if grep -qE "protected guard file|plan-guard" "$LOGDIR/s3.json" && [ ! -e "$HOME/.omp/agent/extensions/pwned.ts" ]; then
		pass 3 "tool_call refused the write (plan-guard protected text present; pwned.ts absent)"
	else
		fail 3 "model called write on $HOME/.omp/agent/extensions/pwned.ts but refusal/absence missing (refusal=$(grep -c 'protected guard file' "$LOGDIR/s3.json" || true), file=$([ -e "$HOME/.omp/agent/extensions/pwned.ts" ] && echo present || echo absent))"
	fi
else
	incon 3 "model never attempted the protected write (no pwned.ts in its session output)"
fi

# --- C4: non-Progress plan edit refused + restored at tool_result. Post-P8
# there are no old guard extensions in the layout (the cutover-mirror removed
# them), so the plugin alone is the only guard: a dirty plan after session 4
# is a plugin bug and needs an src fix.
s4_dirty=0
if grep -q "rewritten" "$LOGDIR/s4.json"; then
	if cmp -s "$LOGDIR/open.pristine" "$OPEN_PLAN" && grep -qE "plan-guard|is a plan file|outside your progress" "$LOGDIR/s4.json"; then
		pass 4 "non-Progress plan edit refused (plan-guard text present) and file restored byte-identical"
	elif cmp -s "$LOGDIR/open.pristine" "$OPEN_PLAN"; then
		fail 4 "plan file restored but no plan-guard refusal text in the session output"
	else
		s4_dirty=1
	fi
else
	incon 4 "model never attempted the plan rewrite (no 'rewritten' in its session output)"
fi
if [ "$s4_dirty" = 1 ]; then
	fail 4 "plan file changed after session 4 (diff: $(diff "$LOGDIR/open.pristine" "$OPEN_PLAN" | head -4 | tr '\n' ' ')) — plugin bug, src fix required"
fi

# --- C5: tool_result/agent_end ran without error. Model-side API errors
# (exceed_context_size_error etc.) are not extension errors, and a --max-time
# deadline makes omp exit non-zero after the hooks ran; judge by the events,
# not the exit code.
err_hits="$(cat "$LOGDIR/s3.err" "$LOGDIR/s4.err" 2>/dev/null | head -5)"
tools_seen="$( { grep -l '"tool' "$LOGDIR/s3.json" "$LOGDIR/s4.json" 2>/dev/null || true; } | wc -l )"
ends_seen="$( { grep -l '"type":"agent_end"' "$LOGDIR/s3.json" "$LOGDIR/s4.json" 2>/dev/null || true; } | wc -l )"
if [ -z "$err_hits" ] && [ "$tools_seen" = 2 ] && [ "$ends_seen" = 2 ]; then
	pass 5 "tool events + agent_end present in sessions 3+4 (rc $(cat "$LOGDIR/s3.rc")/$(cat "$LOGDIR/s4.rc") — deadline aborts allowed); stderr clean"
elif [ -n "$err_hits" ]; then
	fail 5 "omp stderr not clean in the tool sessions: $err_hits"
else
	incon 5 "tool events in $tools_seen/2 sessions, agent_end in $ends_seen/2 sessions (rc $(cat "$LOGDIR/s3.rc")/$(cat "$LOGDIR/s4.rc")); hooks unexercised"
fi

# --- C6: main-rollover registered (json output + unknown-command control). A
# dispatched command produces no model turn; an undelivered slash message is
# answered by the model (assistant events) or errors as unknown.
rollover_notice="main-rollover: this session is below rollover.max_session_mb"
s2_asst=$(grep -c '"role":"assistant"' "$LOGDIR/s2.json" || true)
s2_unknown=$( { grep -ciE "unknown|not a (known )?command|unrecognized" "$LOGDIR/s2.json" "$LOGDIR/s2.err" 2>/dev/null || true; } | awk -F: '{s+=$NF} END {print s+0}')
s2b_unknown=$( { grep -ciE "unknown|not a (known )?command|unrecognized" "$LOGDIR/s2b.json" "$LOGDIR/s2b.err" 2>/dev/null || true; } | awk -F: '{s+=$NF} END {print s+0}')
if grep -qF "$rollover_notice" "$LOGDIR/s2.json"; then
	pass 6 "main-rollover registered and runnable (handler notice event in output)"
elif [ "${s2_unknown:-0}" -ge 1 ]; then
	fail 6 "omp treated /main-rollover as unknown"
elif [ "${s2_asst:-0}" -eq 0 ] && [ "$(cat "$LOGDIR/s2.rc")" = "0" ] && { [ "${s2b_unknown:-0}" -ge 1 ] || [ "$(cat "$LOGDIR/s2b.rc")" != "0" ]; }; then
	pass 6 "main-rollover dispatched as a command (no model turn, rc 0) while the unregistered control errors (control rc $(cat "$LOGDIR/s2b.rc"), unknown-markers: $s2b_unknown)"
else
	incon 6 "cannot distinguish command dispatch from a plain model message (assistant events: $s2_asst, rc s2=$(cat "$LOGDIR/s2.rc") s2b=$(cat "$LOGDIR/s2b.rc"), unknown-markers s2=$s2_unknown s2b=$s2b_unknown)"
fi

# --- C7: only-sandbox-extension: no real-HOME path in any loaded-extension
# listing/log. Scan session outputs and every omp-generated file under the
# sandbox agent dir, excluding the files we copied in verbatim (they may quote
# live paths in comments) and models.yml (its header documents live paths).
leak_hits="$( {
		grep -l "/home/ukd" "$LOGDIR"/*.json "$LOGDIR"/*.err 2>/dev/null || true
		find "$HOME/.omp" -type f \
			! -name models.yml \
			! -name herdr-omp-agent-state.ts \
			! -name lib.ts ! -name TEMPLATE.md -print0 |
			xargs -0 -r grep -l "/home/ukd" 2>/dev/null || true
	} | sort -u )"
if [ -z "$leak_hits" ]; then
	pass 7 "no /home/ukd path in any session output or sandbox agent-dir file (extension/plugin all under $HOME)"
else
	fail 7 "real-HOME paths leaked into: $(echo "$leak_hits" | tr '\n' ' ')"
fi

# --- C8: the real HOME is unchanged
snap_real_home after
if cmp -s "$LOGDIR/realhome.before" "$LOGDIR/realhome.after"; then
	pass 8 "real HOME unchanged (ls of $LIVE_AGENT + /home/ukd/.local/bin, agent git status, ~/.bun/bin neurastream count identical)"
else
	fail 8 "real HOME changed during the run: $(diff "$LOGDIR/realhome.before" "$LOGDIR/realhome.after" | head -8 | tr '\n' ' ')"
fi

echo "== summary: FAILS=$FAILS"
if [ "$FAILS" -gt 0 ]; then
	echo "== failure evidence =="
	for f in "$LOGDIR"/s*.err; do echo "--- $f"; tail -5 "$f" 2>/dev/null || true; done
	for f in "$LOGDIR"/s1.json "$LOGDIR"/s2.json "$LOGDIR"/s2b.json "$LOGDIR"/s3.json "$LOGDIR"/s4.json; do
		echo "--- $f"; head -c 700 "$f" 2>/dev/null; echo; echo "…"; tail -c 700 "$f" 2>/dev/null; echo
	done
fi
[ "$FAILS" -eq 0 ]
