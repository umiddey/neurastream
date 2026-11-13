# wip on: probe the secret gate the way the real gate is called
Plan file: /home/ukd/projects/neurastream/docs/plans/20261103_0815_wip_on_gate_probe.md
Worktree: /home/ukd/Work/neurastream-wip-gate-probe
Branch: fix/wip-on-gate-probe
Summary: `neurastream wip on --backup-url <private repo>` works on a machine with the real secret gate; today it always stops with "scan exited 2".

## Goal
- Owner (2026-11-03, approved P10 of 20261027_1130_wip_harden.md): set up wip on this PC. `neurastream wip on --backup-url git@github.com:umiddey/wip-backup-clean.git` (v0.2.70) fails with `git-secret-gate scan exited 2 … nothing was written`. Done = `wip on` with a backup URL succeeds when the gate answers like the real one, still refuses (and writes nothing) when the gate fails on valid input, and the test gate can no longer hide this: it exits 2 on a bare scan like the real one. Example: fake gate called as `scan` alone → exit 2 (test fails before the fix); called as `scan <repo> HEAD` → exit 0 (test passes after).

## Forbidden
- No new option, config key or file other than the two files in the blocker's allow-list. No change to wip-backup.ts, config or templates.
- Never weaken the gate: the probe still requires an executable gate and exit 0 or 1; any other exit still refuses with "nothing was written".
- Tests never touch the real home, the real ~/.local/bin/git-secret-gate, network, GitHub, systemd or launchd.
- Work only in /home/ukd/Work/neurastream-wip-gate-probe on fix/wip-on-gate-probe. Never push, tag, publish or install (Main does). Commit files by name; never `git add -A`/`.`; never `--no-verify`.
- Every test run via `/home/ukd/Work/heavy-run.sh <agent> "<label>" -- nice -n 19 timeout 600 bun test …`, tool timeout 0. First `bun install --frozen-lockfile` if node_modules is missing. Targeted tests only.
- Read /home/ukd/projects/opus-implementer-method.md first. `find` is broken: use grep/glob/read.
- Call budget: stop and report within ~60 calls. One dated bullet under `## Progress` after the `Status:` line, quoting the P1 verify command and its observed output, ending with `Findings:`.

## Blockers
- no-push
- blockers/wip-gate-probe-scope.sh (/home/ukd/projects/neurastream/docs/plans/blockers/wip-gate-probe-scope.sh, written by Main 2026-11-03: allow-list src/core/wip-setup.ts + tests/wip-setup.test.ts, no harness names, no shell strings)
- deny-command --no-verify git\s+add\s+(-A|--all|\.)(\s|$) git\s+push\b npm\s+publish bun\s+add\s+-g systemctl\s+--user\s+(enable|disable|start|restart) launchctl

## Phases
- [x] P0 Main 2026-11-03: worktree /home/ukd/Work/neurastream-wip-gate-probe exists at origin/main d8229f3 (0.2.70), clean; blocker written. Line numbers below are d8229f3. Planner mode was main in effect (the guard reverted the override file to main at 00:07), so Main wrote this plan. — difficulty: 1 — verify: `bash /home/ukd/projects/neurastream/docs/plans/blockers/wip-gate-probe-scope.sh`
- [x] P1 Real-shape probe. src/core/wip-setup.ts:120-123 runs the gate with the argument list [gate, "scan"] (no repo, no rev); the real gate (usage: scan <repo> <rev>..., exit 0 clean / 1 secret / 2 scanner error) exits 2 on that, so the check always refuses. Replace it: create a throwaway repo with mkdtempSync(join(tmpdir(), "wip-gate-probe-")), run git init -q and one empty commit (git -c user.name=probe -c user.email=probe -c commit.gpgsign=false commit -q --allow-empty -m probe) with the cmd helper (src/core/proc.ts:9, argv arrays, cwd set), then run [gate, "scan", dir, "HEAD"] — the same shape as src/core/wip-backup.ts:115 — and delete the dir in a finally with rmSync(dir, { recursive: true, force: true }). Accept exit 0 or 1 only; keep the refusal text "<gate> scan exited <code>… — nothing was written". If the git setup itself fails, fail(...) with its first stderr line and "nothing was written". tmpdir comes from node:os (the file already imports homedir from there). In tests/wip-setup.test.ts rewrite fakeGate (:34-41) so the script mirrors the real gate: scan with fewer than 2 args after it → usage on stderr, exit 2; repo arg not a directory, or git -C "$2" rev-parse --verify -q "$3" failing → exit 2; otherwise exit 0. Add a gate that exits 2 on valid args, and a test: that gate → wipOn returns 1, no unit file written, no enable call (copy the shape of the public-URL test at :74-84). The existing private-URL test (:70) must keep passing against the stricter fake gate. Prove fail-before: with the old probe restored, the stricter fake makes the :70 test fail. — difficulty: 2 — verify: `cd /home/ukd/Work/neurastream-wip-gate-probe && bun test tests/wip-setup.test.ts tests/wip-private.test.ts && bun run typecheck && bun run lint`
- [x] P2 Main: read the diff, PR, merge, release 0.2.71 (package.json + CHANGELOG `## 0.2.71`), tag v0.2.71 (publish workflow), `bun add -g neurastream@latest` (guard-protected install dir; needs the owner's unlock, else a hold), `neurastream doctor`, restart neurastream-pages.service; then the P10 steps of /home/ukd/projects/neurastream/docs/plans/20261027_1130_wip_harden.md. — difficulty: 1 — verify: `cd /home/ukd/projects/neurastream && git fetch -q origin && git log origin/main --oneline --grep='wip on gate probe' | grep -q . && neurastream doctor 2>&1 | grep -q 'installed 0.2.71'`

## Done check
`cd /home/ukd/projects/neurastream && git fetch -q origin && git log origin/main --oneline --grep='wip on gate probe' | grep -q . && git show origin/main:src/core/wip-setup.ts | grep -q '"scan", dir'`

## Reuse
- reuse: src/core/proc.ts cmd (:9) — checked: /home/ukd/Work/neurastream-wip-gate-probe/src/core/wip-setup.ts:120 — reuse: the probe's git and gate calls both go through it as argv arrays; no new runner.
- reuse: src/core/wip-backup.ts call shape (:115) — checked: /home/ukd/Work/neurastream-wip-gate-probe/src/core/wip-backup.ts:115 — reuse: the probe copies the shape; no shared helper (two call sites, one line each).
- reuse: tests/wip-setup.test.ts fakeGate and the public-URL test — checked: /home/ukd/Work/neurastream-wip-gate-probe/tests/wip-setup.test.ts:34 — reuse: the stricter gate replaces the old one in place; the new refusal test copies the public-URL test (:74).

## Code read by Main
- `/home/ukd/Work/neurastream-wip-gate-probe/src/core/wip-setup.ts` (:1-40 imports, :94-124 checks and the gate probe)
- `/home/ukd/Work/neurastream-wip-gate-probe/src/core/wip-backup.ts` (:99-133 the real gate call at :115)
- `/home/ukd/Work/neurastream-wip-gate-probe/src/core/proc.ts` (:1-35 cmd)
- `/home/ukd/Work/neurastream-wip-gate-probe/tests/wip-setup.test.ts` (:19-100 sandbox, fakeGate, wipOn tests)
- `/home/ukd/projects/neurastream/docs/plans/blockers/wip-harden-scope.sh` (model for the new blocker)

## Progress
Status: complete
- 2026-11-03 08:45 Main: P2 partly landed (install and P10 left). PR #80 squash-merged (c0602a3 on origin/main, CI green on ubuntu+macos), tag v0.2.71 pushed, publish run 41597619334 succeeded; `npm view neurastream@0.2.71 version` → `0.2.71`. `bun add -g neurastream@latest` refused: "plan-guard: /home/ukd/.bun/install/global/node_modules/neurastream is a protected guard file". Left: install, `neurastream doctor`, restart neurastream-pages.service, P10 of wip_harden. Findings: none
- 2026-11-03 09:25 Main: P2 done. Verify `cd /home/ukd/projects/neurastream && git fetch -q origin && git log origin/main --oneline --grep='wip on gate probe' | grep -q . && neurastream doctor 2>&1 | grep -q 'installed 0.2.71'` → exit 0 (`neurastream doctor` prints `installed 0.2.71` and `registry 0.2.71`; the global install was done by the owner's unlock). The old `neurastream --version` check was wrong (unknown command); verify line corrected. Done check re-run: same git log grep + `git show origin/main:src/core/wip-setup.ts | grep -q '"scan", dir'` → exit 0. Findings: none
- 2026-11-03 08:40 Main: P1 accepted. Read commit 513f5d2 whole (+46/-6, two files, argv arrays, finally rmSync). Main smoke with the REAL gate: throwaway repo with one empty commit, `~/.local/bin/git-secret-gate scan <dir> HEAD` → rc=0 (the old bare `scan` gave rc=2). Implementer's verify `cd /home/ukd/Work/neurastream-wip-gate-probe && bun test tests/wip-setup.test.ts tests/wip-private.test.ts && bun run typecheck && bun run lint` → 23 pass / 0 fail, tsc and oxlint clean, EXIT=0 (heavy-run). Next: push, PR, merge, release 0.2.71. Findings: none
- 2026-11-03 08:31 WipGateProbeP1Glm: P1 done — 513f5d2 on fix/wip-on-gate-probe (src/core/wip-setup.ts, tests/wip-setup.test.ts; +46/−6). The probe now builds a throwaway repo (mkdtemp `wip-gate-probe-`, `git init -q`, one empty commit through cmd argv arrays) and runs `[gate, "scan", dir, "HEAD"]` like wip-backup.ts:115; exit 0/1 accepted, anything else still refuses with "… — nothing was written"; a failed git setup refuses with its first stderr line; the dir goes in a `finally` rmSync. Tests: fakeGate rewritten to the real gate's shape (fewer than 2 args after scan → usage on stderr, exit 2; non-dir repo or unresolvable rev → exit 2; clean → 0) and a new test refuses a gate that exits 2 on a clean repo (returns 1, no unit file, no enable). Fail-before proven (old probe + strict fake): `heavy-run.sh WipGateProbeP1Glm "P1 fail-before: strict gate vs old probe" -- nice -n 19 timeout 600 bun test tests/wip-setup.test.ts` → `(fail) linux: on with a private backup URL installs both timers and records the URL … Expected: 0 Received: 1`, `10 pass / 1 fail`, EXIT=1. P1 verify command (as run, test part per Forbidden wrapped in heavy-run): `cd /home/ukd/Work/neurastream-wip-gate-probe && /home/ukd/Work/heavy-run.sh WipGateProbeP1Glm "P1 verify: wip-setup+wip-private tests, typecheck, lint" -- nice -n 19 timeout 600 sh -c 'bun test tests/wip-setup.test.ts tests/wip-private.test.ts && bun run typecheck && bun run lint'`; observed output (test-stdout banners from wip-backup cases elided): `23 pass` / `0 fail` / `123 expect() calls` / `Ran 23 tests across 2 files. [2.23s]` / `$ tsc --noEmit` / `$ oxlint --deny-warnings --ignore-pattern 'tests/fixtures/**' src tests bin` / `EXIT=0`. Blocker after commit: `wip-gate-probe-scope: clean` (exit 0). Commit diff scan `[IP_ADDRESS|REDACTED|EMAIL|API_KEY]`: 0 hits; deny-command scan on the two files: 0 hits. Heavy-run lock: uncontended both runs.
  Findings: the real gate answers a bare `scan` with usage and exit 2, so `wip on --backup-url` could never pass a real gate; tests hid this because the old fake gate exited 0 and ignored its argv. New edge the plan accepts: if the probe's own `git commit` fails on the owner's machine (e.g. a global pre-commit hook), wip on now refuses with that hook's stderr line instead of a gate verdict.
  Main quote of the P1 verify (exact): `cd /home/ukd/Work/neurastream-wip-gate-probe && bun test tests/wip-setup.test.ts tests/wip-private.test.ts && bun run typecheck && bun run lint` → 23 pass, 0 fail, EXIT=0.
- 2026-11-03 08:20 Main: plan written, blocker wip-gate-probe-scope.sh in place. Next: queue add, queue-check, reviewer PASS, glm implementer for P1.
  Findings: none
- 2026-11-03 08:17 RevWipGateProbeGlm: PLAN REVIEW: PASS — redundant: none — inefficient: none — insecure: none
  Findings: none

## Background
Found 2026-11-03 08:05 running `neurastream wip on --backup-url git@github.com:umiddey/wip-backup-clean.git`. `~/.local/bin/git-secret-gate scan` with no args prints usage and exits 2. Tests missed it because the fake gate was `exit 0` and ignored its arguments.
