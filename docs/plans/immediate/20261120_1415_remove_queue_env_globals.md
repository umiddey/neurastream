# Remove `process.env.QUEUE_*` and Mutable Global Path State from `queue/lib.ts`

**Status**: COMPLETE
**Created**: 2026-11-20

## Context & Thought Process
During a full review of the `neurastream` codebase, we identified a legacy script-porting seam in `src/core/queue/env.ts` and `src/core/queue/lib.ts`:
- Instead of passing `cfg.paths` directly into queue functions, callers invoke `applyQueueEnv(cfg)` (`src/core/queue/env.ts`), which mutates 7 `process.env.QUEUE_*` variables (`QUEUE_AGENT`, `QUEUE_INDEX`, `QUEUE_BLOCKERS`, `QUEUE_STATE`, `QUEUE_SUBAGENTS`, `QUEUE_CANCELLED`, `QUEUE_UNLOCK`) and calls `refreshQueuePaths()`.
- `refreshQueuePaths()` in `src/core/queue/lib.ts` reassigns 8 exported mutable `let` bindings (`INDEX`, `BLOCKERS_DIR`, `STATE_DIR`, `UNLOCK`, `PROTECTED`, `SUBAGENTS_MD`, `GLOBAL_CANCELLED`, `CANCEL_PENDING`).
- This causes three concrete failure modes:
  1. **Silent wrong-path bugs** if any caller forgets `applyQueueEnv(cfg)` before calling into `queue/lib.ts` or `guards.ts` (already worked around ad-hoc in `writeIndex(..., file)` for `owner-ui.ts`).
  2. **Config hot-reload desync**: `reloadingConfig()` returns a fresh `cfg` when `config.yml` changes, while `createOmpAdapter()` only calls `applyQueueEnv(cfg)` once at startup, leaving `q.STATE_DIR` / `process.env.QUEUE_*` stale.
  3. **Test and child-process leakage**: mutating `process.env` leaks across tests in the same Bun process and into child processes spawned with `env: process.env`.

`Config["paths"]` in `src/core/config.ts` already contains all 7 path keys (`agent_dir`, `queue_index`, `blockers`, `queue_state`, `subagents`, `cancelled`, `unlock`). Passing `cfg.paths` (typed as `QueuePaths`) directly removes the entire global mutation layer cleanly.

## Goal
Eliminate `src/core/queue/env.ts`, `refreshQueuePaths()`, all `process.env.QUEUE_*` reads/writes, and all 8 mutable exported path globals in `src/core/queue/lib.ts`, replacing them with explicit `QueuePaths` (`cfg.paths`) parameters across `src/` and `tests/`.

## Phases

### Phase 1: Define `QueuePaths` and refactor `src/core/queue/lib.ts`
**Status**: COMPLETE
**Why**: Establish the single explicit path contract (`QueuePaths`, structurally satisfied by `Config["paths"]`) at the foundation so all callers can pass `cfg.paths` directly without global state.
- Add `export interface QueuePaths` to `src/core/queue/lib.ts` with `agent_dir`, `queue_index`, `blockers`, `queue_state`, `subagents`, `cancelled`, `unlock`.
- Update all path-dependent helpers in `src/core/queue/lib.ts` to take `paths: QueuePaths` (or explicit file path arguments where already used):
  - `finishedPath(paths)`, `cancelPendingPath(paths)`, `closeLog(file, paths)`, `lastCloseResult(file, paths)`, `awaitingMerge(p, paths)`, `lastCloseFailed(file, paths)`
  - `protectedPaths(paths)`, `protectedHit(targetPaths, paths)`, `unlocked(paths, unlockMinutes?)`, `chatUnlock(text, cfg, ...)`
  - `readGlobalCancelled(paths)`, `cancelledMatches(plan, paths)`, `cancelledProblem(plan, c, paths)`, `cancelPending(paths)`
  - `activePlans(paths, reviewAgents?)`, `queueProblems(paths, reviewAgents?)`, `queueSummary(paths, reviewAgents?, staleOrClaims?, cap?)`
  - `writeTargets(toolName, input, cwd, paths?)` (eliminate `subagentsPath()` env lookup on `subOp`)
- Remove `agentDir()`, `indexPath()`, `blockersDirPath()`, `stateDirPath()`, `unlockPath()`, `subagentsPath()`, `globalCancelledPath()`, `refreshQueuePaths()`, and the 8 mutable `export let` globals (`INDEX`, `BLOCKERS_DIR`, `STATE_DIR`, `UNLOCK`, `PROTECTED`, `SUBAGENTS_MD`, `GLOBAL_CANCELLED`, `CANCEL_PENDING`).
- Delete `src/core/queue/env.ts`.

### Phase 2: Migrate all `src/core/` callers to explicit `cfg.paths`
**Status**: COMPLETE
**Why**: Every core module already receives `cfg: Config` (or can receive `cfg.paths`), so threading `cfg.paths` eliminates hidden coupling in guards, queue CLIs, owner UI, incidents, notify, rollover, watch, and MR sweep.
- Update `src/core/guards.ts`, `src/core/queue-check.ts`, `src/core/queue-close.ts`, `src/core/queue-cancel.ts`, `src/core/queue-finished.ts`, `src/core/queue-trim.ts`, `src/core/queue-migrate.ts`, `src/core/owner-ui.ts`, `src/core/incidents.ts`, `src/core/notify.ts`, `src/core/rollover.ts`, `src/core/mr-sweep.ts`, `src/core/watch.ts`, and any other `src/core/*.ts` files referencing `applyQueueEnv` or removed `queue/lib.ts` globals/getters.
- Specifically thread `cfg` / `QueuePaths` through these transitive callers found during code inspection:
  - `src/core/incidents.ts`: `ownerMessagesFile()`, `readOwnerMessages()`, `readOwnerAnswers()`, `writeOwnerStore()`, `appendOwnerAnswer()` (read `q.STATE_DIR`)
  - `src/core/notify.ts`: `ownerAnswerStatePath()`, `readOwnerAnswerState()`, `writeOwnerAnswerState()`, `ownerAnswerHandback()` (read `stateDirPath()`)
  - `src/core/rollover.ts`: `notePath()`, `relaunchPath()` (default `stateDir = mainStateDir()`)
  - `src/core/owner-ui.ts`: `inboxPath()`, `ownerMessagesDir()`, `resultsCachePath()`, `sweepOwnerMessages()`, `recentOwnerMessages()`, `appendAnswer()`, `storeOwnerMessage()`, `handleMessageImage()`, `lockMinutesLeft()` (read `stateDirPath()` / `unlockPath()`)
  - `src/core/mr-sweep.ts`: `mrSweep(opts)` (calls `activePlans(opts.index)`)
  - `src/core/watch.ts`: `timerStaffedPlans()` (calls `readStaffingEntries()` -> `q.STATE_DIR`)
  - `src/core/guards.ts`: `mainStateDir()`, `readWindow()`, `writeWindow()`, `resetMainCalls()`, `recordSpawns()`, `rekeySpawnFile()`, `readBudgets()`, `recordBudgets()`, `readStaffing()`, `readStaffingEntries()`, `recordMainResult()`, `openQueue()`, `plannerSpawnPlan()`, `planGate()`, `priorityProblem()`, `windowFile()`, `mrCacheFile()`, `planReviewsFile()`
- Preserve all existing CLI behavior, exit codes, and refusal messages.

### Phase 3: Migrate `src/cli/` and `src/adapters/` callers
**Status**: COMPLETE
**Why**: Remove the remaining `applyQueueEnv` calls at CLI and adapter entry points so config hot-reloads in `createOmpAdapter()` always use the active `cfg.paths` with zero stale state.
- Update `src/cli/dispatch.ts`, `src/cli/guard.ts`, `src/adapters/omp/index.ts`, and any other files under `src/cli/` or `src/adapters/`.
- Remove any comments referencing `applyQueueEnv` or `process.env.QUEUE_*` requirements.

### Phase 4: Update tests, add isolation tests, and verify green build
**Status**: COMPLETE
**Why**: Ensure zero regressions across the full test suite and explicitly lock in the bug fix (no `process.env` mutation, no cross-config state bleed, hot-reload path propagation, and non-default CLI child path propagation).
- Updated all existing tests under `tests/` to pass explicit `QueuePaths` / `cfg.paths` / `mainStateDir(cfg)` instead of `applyQueueEnv`, `refreshQueuePaths`, mutable globals, or `process.env.QUEUE_*`.
- Added targeted regression tests in `tests/queue-paths-isolation.test.ts`:
  1. Two distinct `Config` / `QueuePaths` instances evaluated interleaved in the same process without interfering across queue helpers, unlock state, protected paths, edit windows, autonomy tiers, and guard checks.
  2. Asserts calling queue, guard, and autonomy helpers never mutates `process.env` with `QUEUE_*` keys.
  3. Config hot-reload test (`reloadingConfig` + `createOmpAdapter`) proving updated `paths.queue_index` and `paths.queue_state` take effect on the next guarded event.
  4. Sandbox E2E test with non-default `paths.queue_index` and `paths.queue_state` across spawned CLI children (`guard inject --json`, `queue-cancel` -> `queue-close`), asserting nothing is written to `$HOME/.local/state/queue`.
- Verified zero remaining references to `applyQueueEnv`, `refreshQueuePaths`, mutable exported path globals, or `process.env.QUEUE_*` reads/writes in `src/` (only `config.ts` `ENV_MAP` config-loader keys and child-process `spawn` env objects in `autoClose` / `queueCancel` remain, with zero mutation of `process.env`).

## Verification
- `bun run typecheck` (`tsc --noEmit`) -> exit 0
- `bun run lint` (`oxlint --deny-warnings --ignore-pattern 'tests/fixtures/**' src tests bin`) -> exit 0 (`Found 0 warnings and 0 errors. Finished in 51ms on 322 files with 96 rules using 16 threads.`)
- `bun test --timeout 15000` -> exit 0 (`2074 pass, 3 skip, 0 fail, 7952 expect() calls, Ran 2077 tests across 188 files. [236.74s]`; note: 3 unrelated `wip-broken-repos`/`wip-roots` tests hit bun's 5s default timeout under full-suite CPU load and pass cleanly with `--timeout 15000`)
- `bun test tests/queue-paths-isolation.test.ts` -> exit 0 (`4 pass, 0 fail, 45 expect() calls`)
- `bun x oxlint --deny-warnings scripts/rate-limit-smoke.ts` -> exit 0 (after fixing stale `applyQueueEnv` import/call caught by independent reviewer)
- `rg -n "applyQueueEnv|refreshQueuePaths|QUEUE_(AGENT|INDEX|BLOCKERS|STATE|SUBAGENTS|CANCELLED|UNLOCK)|export let (INDEX|BLOCKERS_DIR|STATE_DIR|UNLOCK|PROTECTED|SUBAGENTS_MD|GLOBAL_CANCELLED|CANCEL_PENDING)\b" src/ bin/ scripts/` -> zero code references to `applyQueueEnv` / `refreshQueuePaths`; only `src/core/config.ts` `ENV_MAP`, `src/adapters/omp/index.ts` + `src/core/queue-cancel.ts` child-process `spawn` env maps (no `process.env` mutation), `scripts/smoke-e2e.sh` `env -u`, and a comment in `src/core/autonomy.ts`.
