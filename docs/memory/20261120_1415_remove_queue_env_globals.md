# 20261120_1415_remove_queue_env_globals
**Task**: Remove `process.env.QUEUE_*` mutation and mutable global path variables from `src/core/queue/lib.ts` and `src/core/queue/env.ts`
**Status**: COMPLETE

## WHAT
- Plan created and mapped 1:1 to this memory file ✓
- Transitive global-state callers across `src/core/` audited and added to plan ✓
- Phase 1 (`QueuePaths` + `src/core/queue/lib.ts` refactor + delete `src/core/queue/env.ts`) ✓
- Phase 2 (`src/core/` callers migrated — `tsc --noEmit` reports 0 errors in `src/core/`) ✓
- Phase 3 (`src/cli/` and `src/adapters/` callers migrated — 0 typecheck errors and 0 lint warnings/errors across `src/`) ✓
- Phase 4 (all tests updated, isolation + hot-reload + non-default CLI E2E tests added in `tests/queue-paths-isolation.test.ts`, full `typecheck` + `lint` + `test` green) ✓

## HOW
- Replaced `applyQueueEnv(cfg)` + `refreshQueuePaths()` + 8 mutable exported globals (`INDEX`, `BLOCKERS_DIR`, `STATE_DIR`, `UNLOCK`, `PROTECTED`, `SUBAGENTS_MD`, `GLOBAL_CANCELLED`, `CANCEL_PENDING`) with explicit `QueuePaths` (`cfg.paths`) parameters across `src/` and `tests/`.
- For spawned child CLI processes (`autoClose` in `src/adapters/omp/index.ts` and `queueCancel` -> `queue-close` in `src/core/queue-cancel.ts`), constructed an explicit `childEnv` passed to `spawn`/`spawnSync` without mutating `process.env`.
- Updated `runIncident` in `src/cli/incident.ts` to accept an optional `injected?: Config` parameter matching other CLI entrypoints (`claimCli`, `recallCli`).
- Updated `tests/golden/ports-p4.test.ts` `installQueueLib()` to copy the frozen oracle `tests/fixtures/originals/agent/queue/lib.ts` for the legacy `queue-cancel` oracle script.
- Added `tests/queue-paths-isolation.test.ts` covering two-config interleaved isolation, zero `process.env.QUEUE_*` mutation, `reloadingConfig` + `createOmpAdapter` hot-reload path updates, and non-default `queue_index`/`queue_state` CLI child E2E.

## WHY
- During codebase review of `neurastream`, we traced how `src/core/queue/env.ts` mutates `process.env.QUEUE_*` and calls `refreshQueuePaths()` to reassign module-level `export let` globals in `src/core/queue/lib.ts`.
- This created silent wrong-path bugs when a caller forgot `applyQueueEnv`, broke path updates during `reloadingConfig()` hot-reloads in `src/adapters/omp/index.ts`, and leaked env mutations across tests and child processes.
- `Config["paths"]` already has the exact 7 path keys needed, so passing `cfg.paths` explicitly removes the entire global-mutation seam cleanly.

## FILES MODIFIED
- `docs/plans/immediate/20261120_1415_remove_queue_env_globals.md`: marked Phases 1–4 and overall status COMPLETE with verification results
- `docs/memory/20261120_1415_remove_queue_env_globals.md`: updated 1:1 memory log to COMPLETE
- `src/core/queue/lib.ts`: added `QueuePaths`, refactored all path-dependent helpers to take explicit `paths`/file arguments, removed `refreshQueuePaths()`, env getters, and 8 mutable globals
- `src/core/queue/env.ts`: deleted
- `src/core/{guards,queue-check,queue-close,queue-cancel,queue-finished,queue-trim,queue-migrate,results,team-client,mr-sweep,main-start,autonomy,plan-approval,incidents,owner-log,owner-topics,pages,notify,rollover,watch,owner-ui}.ts`: migrated to explicit `cfg.paths` / `QueuePaths` parameters, removed all `applyQueueEnv` calls and mutable global reads (plus explicit `childEnv` for `queueCancel` -> `queue-close` spawn)
- `src/cli/{claim,dispatch,guard,incident,metrics,recall,results-build,workspace}.ts`: migrated to explicit `cfg.paths` / `QueuePaths` parameters, removed all `applyQueueEnv` calls
- `src/adapters/omp/{index,launch}.ts`: migrated to explicit `cfg.paths` / `QueuePaths` parameters (including hot-reload safe `waitingKeysFile`, `notePath`, `relaunchPath`, `ownerInboxMessage`, and explicit `childEnv` for `autoClose`), removed `applyQueueEnv`
- `tests/*.test.ts` + `tests/golden/ports-p4.test.ts`: migrated all affected tests to pass `cfg.paths` / `QueuePaths` / `mainStateDir(cfg)` explicitly and removed `applyQueueEnv` / `refreshQueuePaths`
- `tests/queue-paths-isolation.test.ts`: added 4 targeted tests (two-config isolation, zero `process.env.QUEUE_*` mutation, `reloadingConfig` + `createOmpAdapter` hot-reload, and non-default `queue_index`/`queue_state` CLI E2E)
- `scripts/rate-limit-smoke.ts`: removed stale `applyQueueEnv` import/call caught by independent code reviewer

## VERIFICATION
- `bun run typecheck`: exit 0 (`tsc --noEmit`)
- `bun run lint`: exit 0 (`oxlint --deny-warnings --ignore-pattern 'tests/fixtures/**' src tests bin` — `Found 0 warnings and 0 errors` on 322 files)
- `bun x oxlint --deny-warnings scripts/rate-limit-smoke.ts`: exit 0 (`Found 0 warnings and 0 errors`)
- `bun test tests/queue-paths-isolation.test.ts`: exit 0 (`4 pass, 0 fail, 45 expect() calls`)
- `bun test --timeout 15000`: exit 0 (`2074 pass, 3 skip, 0 fail, 7952 expect() calls` across 188 files in 236.74s)
- Independent reviewer audit: verified all core/CLI/adapter/test changes, sandbox `init`+`doctor` smoke passed, caught `scripts/rate-limit-smoke.ts` broken import (now fixed and re-verified)

## NEXT SESSION
- Optional follow-up: extract duplicated 9-line `childEnv` builder in `src/core/queue-cancel.ts` and `src/adapters/omp/index.ts` into a shared helper; commit when ready.

## REFERENCES
- Plan: `docs/plans/immediate/20261120_1415_remove_queue_env_globals.md`
- Key files: `src/core/queue/lib.ts`, `src/core/guards.ts`, `src/adapters/omp/index.ts`, `tests/queue-paths-isolation.test.ts`
