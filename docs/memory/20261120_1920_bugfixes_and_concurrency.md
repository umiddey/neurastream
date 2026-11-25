# 20261120_1920_bugfixes_and_concurrency
**Task**: Fix verified correctness, concurrency, and runtime bugs across `queue-close.ts`, `queue-cancel.ts`, `team-client.ts`, `secret-redact.ts`, `queue/lib.ts`, `file-lock.ts`, `incidents.ts`, `guards.ts`, `plan-approval.ts`, `uninstall.ts`, and `tailscale.ts`
**Status**: COMPLETE

## WHAT
- Plan created and revised after independent Plan Reviewer audit (all blockers & important findings incorporated) ✓
- Phase 1 (`queue-close.ts` & `queue-cancel.ts`: `git && git` bug, `flock`, `expandHome`, clean error returns) ✓
- Phase 2 (`team-client.ts`: remove `process.execPath` fork-bomb regression with harness-neutral comment) ✓
- Phase 3 (`secret-redact.ts`: split `"env-all"`/`"env-secret"` cache kinds, escaped-quote parsing before `#` comments, `cfg.paths.home`) ✓
- Phase 4 (`file-lock.ts`, `queue/lib.ts`, `uninstall.ts`, `incidents.ts`, `guards.ts`, `plan-approval.ts`, `dispatch.ts`, `owner-ui.ts`, `queue-close.ts`: idempotent release, musl fallback preserving `"libc.so.6"` in error text, `writeAtomicSync` + `withFileLock`, locked `updateIndex()`, `.INDEX.md.lock` purge, full RMW locking + atomic writes, dynamic `expandHome`) ✓
- Phase 5 (`tailscale.ts`: bounded 30s TTL cache for `whois`, `createCachedWhois`, `clearWhoisCache`) ✓

## HOW
- **Phase 1**: Fixed `cloned.ok ? git(...) : cloned` in `src/core/queue-close.ts`; replaced manual PID lockfile + `process.on("exit")` with `tryLock()` inside `try/finally`; replaced `process.exit(1)` in `die()` with internal `AbortClose`/`AbortCancel` returning `1` cleanly in both `queue-close.ts` and `queue-cancel.ts`; replaced `os.homedir()` with `expandHome()`. Added regression tests in `tests/queue-close.test.ts` and `tests/queue-cancel.test.ts`.
- **Phase 2**: Changed `defaultSend()` in `src/core/team-client.ts` to spawn `"bun"` instead of `process.execPath` with a harness-neutral comment ("compiled host harness"). Added regression test in `tests/team-client.test.ts`.
- **Phase 3**: Split `FileKind` in `src/core/secret-redact.ts` into `"npmrc" | "env-all" | "env-secret" | "text"`; filtered auto-discovered `work_roots` `.env*` keys by `SECRET_ENV_NAME` while keeping all keys for explicit `secrets.known_value_files`; implemented `parseEnvValue()` handling double-quoted `\"`/`\\` escapes and single-quoted values before stripping trailing `#` comments; read `.npmrc` from `cfg.paths.home`. Added regression tests in `tests/secret-redact.test.ts`.
- **Phase 4**: Hardened `src/core/file-lock.ts` with idempotent `release()`, Linux musl libc fallback list preserving `"libc.so.6"` in error output, `withFileLock()`, and `writeAtomicSync()` (applying `chmodSync` before `renameSync`). Made `expandHome()` / `currentHome()` dynamic in `src/core/queue/lib.ts`; added `parseIndex()`, `indexLockPath()`, and locked `updateIndex()` (migrating `queue-close.ts`, `dispatch.ts`, and `owner-ui.ts`); added `indexLockPath(cfg.paths.queue_index)` cleanup under `--purge` in `src/core/uninstall.ts`. Protected RMW state files with `withFileLock` + `writeAtomicSync` across `incidents.ts` (`incidents.jsonl`, `owner-messages.jsonl` + exported `appendOwnerMessage`), `guards.ts` (`edit-window.json`, `mr-cache.json`, `plan-reviews.json`, `review-spawns.json`, `planner-spawns.json`, `spawns.json` + exported `deleteSpawnRecord`, `staffing.json`, `spawn-budgets.json`, `main-reads.json`, `cancel-pending.json`), `queue-close.ts`, and `plan-approval.ts` (`plan-approvals.json`). Added unit and multi-process concurrency tests across `tests/file-lock.test.ts`, `tests/index-guard.test.ts`, `tests/queue-lib.test.ts`, `tests/incidents.test.ts`, and `tests/uninstall.test.ts`.
- **Phase 5**: Added `WHOIS_TTL_MS = 30_000`, `WHOIS_MAX_ENTRIES = 256`, `createCachedWhois()`, and `clearWhoisCache()` in `src/core/tailscale.ts` and wired `realTailscale.whois()` through it (positive-only caching, expiry on read, oldest-entry eviction). Added unit tests in `tests/tailscale.test.ts`.
- **Verification**:
  - `bun run typecheck` → exit 0
  - `bun run lint` → 0 warnings, 0 errors across 323 files (exit 0)
  - `bun test tests/queue-close.test.ts tests/queue-close-worktree.test.ts tests/qclose-safety.test.ts tests/queue-cancel.test.ts tests/incident-close-record.test.ts tests/team-client.test.ts tests/team-server.test.ts tests/secret-redact.test.ts tests/secret-redact-omp.test.ts tests/file-lock.test.ts tests/index-guard.test.ts tests/incidents.test.ts tests/queue-lib.test.ts tests/plan-approval.test.ts tests/uninstall.test.ts tests/heavy-run-lock.test.ts tests/owner-ui.test.ts tests/guards.test.ts tests/host-neutral.test.ts tests/no-personal-markers.test.ts tests/tailscale.test.ts` → 311 pass, 0 fail (1624 expect() calls, exit 0)

## WHY
- Codebase review uncovered concrete runtime defects: an always-truthy `git(...) && git(...)` check in `queue-close.ts:150`, a `process.execPath` spawn in `team-client.ts:167` inside harness-loaded code, `.env` redaction corrupting normal words and truncating quoted `#` passwords, an unlocked/non-atomic `writeIndex()` that chmods after rename, double-close hazard in `file-lock.ts`, unlocked RMW state files, and uncached synchronous `tailscale whois` forks on every HTTP request.

## FILES MODIFIED
- `src/core/queue-close.ts`: fixed `cloned.ok` check, `tryLock` + `try/finally`, `AbortClose` clean return `1`, `expandHome()`, migrated index write to `updateIndex()` and `spawns.json` cleanup to `deleteSpawnRecord()`
- `src/core/queue-cancel.ts`: replaced `process.exit(1)` in `die()` with `AbortCancel` returning `1`
- `src/core/team-client.ts`: replaced `process.execPath` spawn with `"bun"` and harness-neutral comment
- `src/core/secret-redact.ts`: split `"env-all"`/`"env-secret"` cache kinds, added `parseEnvValue()` quote/escape/comment parser, filtered `work_roots` `.env*` keys by `SECRET_ENV_NAME`, used `cfg.paths.home` for `.npmrc`
- `src/core/file-lock.ts`: idempotent `release()`, Linux musl libc fallback list, exported `withFileLock()` and `writeAtomicSync()`
- `src/core/queue/lib.ts`: dynamic `currentHome()`/`expandHome()`, exported `parseIndex()`, `indexLockPath()`, `updateIndex()`, locked atomic `writeIndex()` with pre-rename `0o444`
- `src/core/uninstall.ts`: added `indexLockPath(cfg.paths.queue_index)` to `--purge`
- `src/cli/dispatch.ts`: migrated `queue add` and `queue move` to `updateIndex()`
- `src/core/owner-ui.ts`: migrated `/reorder` to `updateIndex()` with in-lock `reorderedIndexText()`
- `src/core/incidents.ts`: locked + atomic writes for `incidents.jsonl` and `owner-messages.jsonl`; exported `appendOwnerMessage()`
- `src/core/guards.ts`: locked + atomic RMW for `edit-window.json`, `mr-cache.json`, `plan-reviews.json`, `review-spawns.json`, `planner-spawns.json`, `spawns.json`, `staffing.json`, `spawn-budgets.json`, `main-reads.json`, `cancel-pending.json`; exported `deleteSpawnRecord()`
- `src/core/plan-approval.ts`: locked + atomic RMW for `plan-approvals.json`
- `src/core/tailscale.ts`: added `WHOIS_TTL_MS`, `WHOIS_MAX_ENTRIES`, `createCachedWhois()`, `clearWhoisCache()`, wired `realTailscale.whois()`
- `tests/queue-close.test.ts`, `tests/queue-cancel.test.ts`, `tests/team-client.test.ts`, `tests/secret-redact.test.ts`, `tests/file-lock.test.ts`, `tests/index-guard.test.ts`, `tests/queue-lib.test.ts`, `tests/incidents.test.ts`, `tests/uninstall.test.ts`, `tests/tailscale.test.ts`: regression, unit, and multi-process concurrency tests
- `docs/plans/immediate/20261120_1920_bugfixes_and_concurrency.md`: updated phase statuses and final status to `COMPLETE`
- `docs/memory/20261120_1920_bugfixes_and_concurrency.md`: updated mapped memory log to `COMPLETE`

## NEXT SESSION
- Independent code reviewer audit of all Plan 2 changes and full repository test run.

## REFERENCES
- Plan: `docs/plans/immediate/20261120_1920_bugfixes_and_concurrency.md`
- Key files: `src/core/queue-close.ts`, `src/core/queue-cancel.ts`, `src/core/team-client.ts`, `src/core/secret-redact.ts`, `src/core/queue/lib.ts`, `src/core/file-lock.ts`, `src/core/incidents.ts`, `src/core/guards.ts`, `src/core/plan-approval.ts`, `src/core/uninstall.ts`, `src/core/tailscale.ts`
