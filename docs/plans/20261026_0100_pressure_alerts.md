# Pressure alerts: the PC tells Main when it is choking and when it has room again
Worktree: /home/ukd/Work/neurastream-pressure
Branch: feat/pressure-alerts

## Goal
- Owner (2026-10-26 ~00:50): "if … a PC like mine suddenly the CPU usage or memory usage … is in the zone where it might start hanging, it gives the agent … some message … when it goes down you know that there is more resources and you can add more". Main found no tool that tells an agent (earlyoom / systemd-oomd / nohang kill processes; agent-usage-manager is a dashboard for humans). Owner picked option (a), 2026-10-26 ~00:55: "it should only tell you and you should then do the rest".
- Today: `resource-alerts` (templates/resource-alerts.sh, a 30 s user timer) only shows a desktop popup to the owner; `machine-guard` runs only when Main calls it. Main never hears about pressure by itself.
- Done = while Main's session runs, a RED message reaches Main's chat when memory or CPU pressure stays high, and one GREEN message when it has stayed low again; neurastream never pauses, kills or renices anything (owner's choice a). Main decides.

## Forbidden
- Host-neutral (owner 2026-10-26): logic and types in src/core name no harness (omp/opencode/codex/claude/cursor); harness-specific reads/writes live under src/adapters/<harness>/ (docs/adapter.md).
- Never stop, kill, pause or renice a process, and never refuse a spawn because of pressure: tell Main only (owner's choice a).
- Work only in /home/ukd/Work/neurastream-pressure on feat/pressure-alerts. Never push, tag, publish or install (Main does). Commit files by name; never `git add -A`/`.`; never `--no-verify`.
- Tests never read the real /proc: the reader takes the file text (or a root dir) as input; fixtures in the test.
- Every test run via `/home/ukd/Work/heavy-run.sh <agent> "<label>" -- nice -n 19 timeout 600 bun test …`, tool timeout 0. First run `bun install --frozen-lockfile` if node_modules is missing.
- Read /home/ukd/projects/opus-implementer-method.md first.
- Call budget: stop and report within ~100 calls. One dated bullet under `## Progress` after the `Status:` line, ending with `Findings:`.

## Blockers
- no-push
- blockers/pressure-scope.sh
- deny-command --no-verify git\s+add\s+(-A|--all|\.)(\s|$) git\s+push\b npm\s+publish bun\s+add\s+-g

## Phases
- [ ] P1 Core, pure. New src/core/pressure.ts: `parsePsi(text): { someAvg10, fullAvg10 }` for /proc/pressure/{memory,cpu,io} lines; `readPressure(root = "/")` → `{ memSome, memFull, cpuSome, ioFull, availMb, swapFreeMb }` (PSI files + /proc/meminfo; a missing file = null fields, never a throw, so macOS just reports nothing); `pressureLevel(sample, cfg)` → "red" | "green" | "amber" with thresholds from a new config block `machine.pressure` (defaults: red when memSome avg10 ≥ 20 or memFull ≥ 5 or cpuSome ≥ 60 or availMb < machine.avail_min_mb; green when all below half of those and availMb ≥ avail_min_mb × 1.5; else amber); `pressureTransition(state, level, nowSec, cfg)` → `{ state, message | null }`: RED fires after the level is red for `red_after_sec` (default 30), GREEN fires once after it is green for `green_after_sec` (default 120) following a RED, at most one RED per `repeat_sec` (default 600) while it stays red, nothing for amber. Message text: `machine: RED — memory stall 34% (10 s), cpu 71%, 1.2 GB free; heavy-run lock held by <label> for 12 min` and `machine: GREEN — memory stall 1%, cpu 8%, 9.8 GB free; room again`. The heavy-run holder comes from `cfg.paths.heavy_lock` (src/core/heavy-run.ts). Config keys documented in docs/config.md next to `machine:`, defaults in templates/config.yml. Tests: parse real-shaped PSI text; each threshold alone trips red; hysteresis (red→amber→red does not re-fire within repeat_sec; green needs green_after_sec; no GREEN without a prior RED) — difficulty: 3 — verify: `cd /home/ukd/Work/neurastream-pressure && /home/ukd/Work/heavy-run.sh pressure "p1" -- nice -n 19 timeout 600 sh -c 'bun run typecheck && bun test tests/pressure.test.ts'`
- [ ] P2 omp delivery. In src/adapters/omp/index.ts, next to the owner-inbox poll in the main-session `session_start` handler (:671-676), add a timer every `machine.pressure.sample_sec` (default 10) that reads, runs `pressureTransition` with state kept in memory and in a small state file under the queue state dir (so a reloaded session does not re-fire), and on a message calls `pi.sendUserMessage(message)` exactly like `deliverOwnerInbox` (:478-497). unref the timer like the others. Hook test in tests/guards-omp.test.ts style with an injected reader: red for 30 s → one RED message; then green 120 s → one GREEN; amber → nothing — difficulty: 2 — verify: `cd /home/ukd/Work/neurastream-pressure && /home/ukd/Work/heavy-run.sh pressure "p2" -- nice -n 19 timeout 600 sh -c 'bun run typecheck && bun test tests/pressure.test.ts tests/guards-omp.test.ts'`
- [ ] P3 Also on demand + docs. `neurastream pressure` prints the current sample, level and the last message (for Main and for a hook-only harness, same text); README section "Pressure alerts" (what fires, thresholds, that it never acts on its own); CHANGELOG Unreleased → Added; full suite — difficulty: 1 — verify: `cd /home/ukd/Work/neurastream-pressure && /home/ukd/Work/heavy-run.sh pressure "full" -- nice -n 19 timeout 600 sh -c 'bun run typecheck && bun test'`
- [ ] P4 Main: review, merge, release, install, `neurastream doctor` exit 0; live check: `stress-ng --vm 2 --vm-bytes 80% --timeout 60s` (or a memory hog) under `nice -n 19` → a RED message lands in Main's chat within ~40 s, GREEN ~2 min after it ends — difficulty: 1 — verify: `neurastream doctor`

## Done check
`cd /home/ukd/Work/neurastream-pressure && git merge-base --is-ancestor HEAD origin/main && bun test tests/pressure.test.ts`

## Code read by Main
- `templates/resource-alerts.sh` (:1-25, PSI memory some avg10 and io full avg10, notify-send only)
- `templates/machine-guard.sh` (:20-33 load/mem/swap readers, :77-92 snapshot)
- `templates/config.yml` (:168-178 machine block)
- `src/core/config.ts` (:167-178 machine type)
- `src/core/guards.ts` (:867-894 checkSpawn; untouched by this plan)
- `src/core/heavy-run.ts` (:4-28 lock via cfg.paths.heavy_lock)
- `src/adapters/omp/index.ts` (:478-497 deliverOwnerInbox, :659-677 session_start timers)
- `docs/config.md` (:183 machine section)

## Progress
Status: open
- 2026-10-26 01:00 Main: plan written after the owner picked option (a) "only tell you". Live PSI read on this PC: memory some avg10 0.02, cpu some 0.00; earlyoom and systemd-oomd inactive. Findings: templates/resource-alerts.sh:16 pressure alerts reach only the owner's desktop (notify-send), never Main
