# Plan: Correctness, Concurrency & Runtime Bug Fixes

**Status**: COMPLETE
**Created**: 2026-11-20 19:20
**Revised**: 2026-11-20 19:30 (incorporated Plan Reviewer findings)
**Mapped Memory**: `docs/memory/20261120_1920_bugfixes_and_concurrency.md`

## Thought Process & Context

During our review of `neurastream`, we uncovered six concrete runtime and concurrency bugs across core modules — none hypothetical, every one verified directly in source code:

1. **Always-truthy `git(...) && git(...)` in `src/core/queue-close.ts:150`**:
   - `const add = git(plan.repo, "clone", "-q", "--shared", ".", scratch) && git(scratch, "checkout", "-q", "--detach", base);`
   - `gitOut()` returns `{ ok: boolean; out: string }`, which is always truthy. If `git clone` fails, `&&` unconditionally executes `git checkout --detach` in the empty `scratch` dir (potentially hitting a parent git repo!) and discards the clone failure message.
   - Also in `src/core/queue-close.ts:81-91`: `queueClose()` rolls its own racy PID lockfile with a leaking `process.on("exit", ...)` listener instead of using `src/core/file-lock.ts` (`tryLock`), and calls `process.exit(1)` inside `die()` (same in `src/core/queue-cancel.ts:23`), which kills in-process callers/tests instead of returning exit code `1`. Also line 286 calls `os.homedir()` directly instead of `expandHome()`.

2. **`process.execPath` fork-bomb regression in `src/core/team-client.ts:167`**:
   - Three places in the repo (`src/adapters/omp/index.ts:247`, `704`, `src/core/main-start.ts:206`) explicitly warn never to spawn `process.execPath` inside code loaded by a compiled host harness because `process.execPath` is the harness binary itself (causing a ~175-process OOM fork bomb in Oct 2026).
   - Yet `defaultSend()` in `src/core/team-client.ts:167` — invoked synchronously from inside the adapter via `guards.ts` and `adapters/` — spawns `spawnSync(process.execPath, [fileURLToPath(import.meta.url)], ...)`. When `teams:` is enabled under a compiled host harness, it launches the harness binary instead of `bun`.

3. **Secret redactor corrupts normal text and truncates quoted `#` secrets in `src/core/secret-redact.ts`**:
   - `envValues()` (`secret-redact.ts:215-227`) extracts EVERY `KEY=value` from every `.env*` file under `paths.work_roots` (up to 500 repos) without filtering keys by `SECRET_ENV_NAME` (unlike `process.env` at line 310). Any non-secret value >= 8 chars in any repo's `.env` (such as `NODE_ENV=production`, `DB_HOST=localhost`, `TZ=Europe/Berlin`) gets globally redacted as `[REDACTED:known-value]` across all tool outputs and notifications.
   - `envValues()` strips surrounding quotes on line 221 *before* searching for inline `#` comments (`value.search(/\s#/)`) on line 222, truncating quoted secrets like `PASS="secret #123"` to `secret` so the real credential leaks unredacted.
   - Line 312 hardcodes `homedir()` instead of `cfg.paths.home` when reading `.npmrc`.

4. **Index write race (read-outside-lock), chmod ordering mismatch, and stale cached `HOME` in `src/core/queue/lib.ts`**:
   - `writeIndex()` (`queue/lib.ts:180-194`) comments that `index` is never writable even between rename and chmod, yet runs `chmodSync(index, 0o444)` *after* `renameSync(tmp, index)` instead of `chmodSync(tmp, 0o444)` before renaming.
   - All callers (`queue-close.ts:285`, `dispatch.ts:349,373`, `owner-ui.ts:1991`) read `INDEX.md` *outside* any lock. Locking only inside `writeIndex()` would still lose updates when `queue add` adds Plan B while `queue-close` removes Plan A (because `why.removed` skips the `gone` check). We need a locked read-modify-write helper `updateIndex(file, why, mutate)` used by every writer, plus cleaning up any index lockfile in `src/core/uninstall.ts:163-169` during `uninstall --purge`.
   - Line 79 snapshots `const HOME = os.homedir()` at module import time, so `expandHome()` ignores runtime `HOME` changes.

5. **File-lock double-release FD bug, musl incompatibility, and unlocked flat-file RMW**:
   - `src/core/file-lock.ts:63-68`: `release()` has no idempotency guard — calling `release()` twice double-closes `fd` (risking closing a reused descriptor). Also hardcodes `libc.so.6` on Linux, breaking on musl/Alpine (while keeping `"libc.so.6"` in the error message so `tests/file-lock.test.ts:21,32` on macOS keeps passing!).
   - `src/core/incidents.ts` (`incidents.jsonl`, `owner-messages.jsonl`), `src/core/guards.ts` (`edit-window.json`, `plan-reviews.json`, `main-reads.json`, `spawns.json`, `staffing.json`, `budgets.json`, `review-spawns.json`, `planner-spawns.json`), `src/core/queue-close.ts:293` (`spawns.json`), and `src/core/plan-approval.ts` (`plan-approvals.json`) do unlocked read-modify-write directly via `writeFileSync`, risking torn files or lost updates under concurrent multi-Main / watcher / subagent activity.

6. **Uncached `spawnSync("tailscale", ["whois", ...])` on every HTTP request in `src/core/tailscale.ts`**:
   - `realTailscale.whois(peer)` spawns a blocking subprocess (8s timeout) on every single HTTP request across `owner-ui.ts`, `team-server.ts`, and `pages.ts` with no TTL cache, stalling the single-threaded Bun event loop.

---

## Phases

### Phase 1: Fix `src/core/queue-close.ts` & `src/core/queue-cancel.ts`
**Status**: COMPLETE

**Justification**: Fixes a genuine logic bug (`git(...) && git(...)`), replaces a racy PID lockfile with the repo's real `flock` implementation, fixes an `os.homedir()` leak on line 286, and stops library functions from calling `process.exit(1)` directly.

**Tasks**:
1. In `src/core/queue-close.ts`:
   - Fix line 150: check `cloned.ok` explicitly before running `git(scratch, "checkout", "-q", "--detach", base)`.
   - Replace the manual PID lockfile + `process.on("exit", ...)` (lines 81-91) with `tryLock(lockPath)` from `src/core/file-lock.ts` inside a `try { ... } finally { held.release(); }` block (preserving exit code `3` and stderr message when lock is busy).
   - Replace `die()` calling `process.exit(1)` with throwing an internal `AbortClose` error caught at the top of `queueClose()`, printing the exact same stderr line and returning `1` (so `finally` always releases the lock cleanly too!).
   - Replace `os.homedir()` on line 286 with `expandHome()`.
2. In `src/core/queue-cancel.ts`:
   - Replace `die()` calling `process.exit(1)` with throwing an internal `AbortCancel` error caught at the top of `queueCancel()`, printing the exact same stderr line and returning `1`.
3. Add regression tests in `tests/queue-close.test.ts` and `tests/queue-cancel.test.ts`:
   - Verify `queueClose()` and `queueCancel()` return `1` cleanly in-process on refusal without exiting the test runner.
   - Verify concurrent `queueClose()` lock contention returns `3` via `file-lock.ts` and releases cleanly.
   - Verify `git clone` failure path in detached done-check reports the clone error and does not run `git checkout` on an empty scratch dir.

**Verification**: `bun test tests/queue-close.test.ts tests/queue-close-worktree.test.ts tests/qclose-safety.test.ts tests/queue-cancel.test.ts tests/incident-close-record.test.ts` — 22 pass, 0 fail (exit 0).

---

### Phase 2: Fix `process.execPath` Fork-Bomb Regression in `src/core/team-client.ts`
**Status**: COMPLETE

**Justification**: Spawning `process.execPath` inside `src/core/team-client.ts` will spawn the compiled host harness binary instead of `bun` whenever `teams:` is configured.

**Tasks**:
1. In `src/core/team-client.ts`:
   - Change `defaultSend()` (`line 167`) from `spawnSync(process.execPath, [fileURLToPath(import.meta.url)], ...)` to `spawnSync("bun", [fileURLToPath(import.meta.url)], ...)` (matching `src/core/queue-cancel.ts:100`).
   - Add a harness-neutral comment explaining why `process.execPath` must never be used here (say *"compiled host harness"*, NEVER name any specific harness so `tests/host-neutral.test.ts` stays green!).
2. Add a regression test in `tests/team-client.test.ts` verifying `src/core/team-client.ts` does not reference `process.execPath` and that the real `defaultSend` child transport round-trips a request against a local HTTP server.

**Verification**: `bun test tests/team-client.test.ts tests/team-server.test.ts tests/team-server-claims.test.ts tests/host-neutral.test.ts` — 65 pass, 0 fail (exit 0).

---

### Phase 3: Fix Secret Redactor Parsing & Filtering in `src/core/secret-redact.ts`
**Status**: COMPLETE

**Justification**: Redacting every 8+ character value in every repo's `.env*` file shreds normal words like `production` and `localhost` across all agent outputs, while stripping quotes before `#` comments silently truncates real passwords containing ` #`.

**Tasks**:
1. In `src/core/secret-redact.ts`:
   - Split `FileKind` into `"npmrc" | "env-all" | "env-secret" | "text"` so `fileCache` keys (`${kind}\0${path}`) never collide when a `.env` file is both listed in `secrets.known_value_files` (`"env-all"`) and discovered under `paths.work_roots` (`"env-secret"`).
   - Refactor `envValues(text, secretKeysOnly)`:
     - Capture both `key` and `rawValue` from each `KEY=value` line.
     - When `secretKeysOnly` is true (auto-discovered `.env*` files under `paths.work_roots`), keep only lines where `SECRET_ENV_NAME.test(key)` is true (matching `process.env` filtering on line 310).
     - When `secretKeysOnly` is false (owner-explicit `secrets.known_value_files`), keep all `KEY=value` entries.
     - Fix quote vs `#` comment parsing:
       - Double-quoted values (`"..."`): scan forward handling `\"` escapes until the unescaped closing `"`, ignoring any trailing `# ...` comment after the closing quote, preserving ` #` inside the quotes verbatim.
       - Single-quoted values (`'...'`): scan to the closing `'`, ignoring any trailing `# ...` comment after the closing quote, preserving ` #` inside the quotes verbatim.
       - Unquoted values: strip trailing `\s#.*` comments, then trim.
   - In `loadKnownSecrets(cfg, env)`: use `join(cfg.paths.home, ".npmrc")` instead of `join(homedir(), ".npmrc")`, and remove the unused `homedir` import on line 11 so `oxlint` stays clean.
2. Add tests in `tests/secret-redact.test.ts` proving:
   - Non-secret `.env` keys (`NODE_ENV=production`, `DB_HOST=localhost`) in a `work_roots` repo are NOT redacted, while `APP_SECRET=...` IS redacted.
   - Same `.env` file listed in `secrets.known_value_files` still has all its keys loaded without cache key collision.
   - Double-quoted secrets containing ` #`, escaped quotes `\"`, and trailing comments (`DB_PASSWORD="hunter #2026" # prod`) and single-quoted secrets (`TOKEN='abc #xyz' # comment`) are redacted whole without truncation.
   - `loadKnownSecrets(cfg)` reads `.npmrc` from `cfg.paths.home`.

**Verification**: `bun test tests/secret-redact.test.ts tests/secret-redact-omp.test.ts tests/secret-redact-proxy.test.ts` — 23 pass, 0 fail (exit 0).

---

### Phase 4: Harden `file-lock.ts`, `updateIndex()`/`writeIndex()`, `expandHome()`, and Atomic Locked State Writes
**Status**: COMPLETE

**Justification**: Eliminates file-descriptor double-close bugs, musl Linux incompatibility, `INDEX.md` lost-update races and writable window, stale cached `HOME`, and unlocked read-modify-write corruption across multi-Main state files.

**Tasks**:
1. In `src/core/file-lock.ts`:
   - Add a `let released = false;` guard in `release()` so calling `release()` more than once is a safe no-op.
   - On Linux, try `["libc.so.6", "libc.musl-x86_64.so.1", "libc.musl-aarch64.so.1", "libc.so"]` in order before throwing, and include **all tried library names** in the thrown error message (e.g., `file-lock: cannot load ${candidates.join(", ")}: ...`) so `tests/file-lock.test.ts:21,32` on macOS still sees `"libc.so.6"`.
   - Export two small atomic helpers in `src/core/file-lock.ts`:
     - `writeAtomicSync(filePath: string, data: string, mode?: number): void` — creates parent dir, writes `${filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`, optionally `chmodSync(tmp, mode)` **before** `renameSync(tmp, filePath)`.
     - `withFileLock<T>(lockPath: string, fn: () => T): T` — acquires `lock(lockPath)` and guarantees `held.release()` in `finally`.
2. In `src/core/queue/lib.ts` & `src/core/uninstall.ts`:
   - Change `expandHome(p)` to read `process.env.HOME || os.homedir()` dynamically rather than caching `const HOME = os.homedir()` at module load time.
   - Add `export function indexLockPath(index: string): string` returning `path.join(path.dirname(index), `.${path.basename(index)}.lock`)`.
   - Add `export function updateIndex(file: string, why: { removed?: "close" | "cancel" | "migrate" } | undefined, mutate: (currentText: string) => string[]): void` which runs inside `withFileLock(indexLockPath(file), ...)` — reads the current file under the lock, calls `mutate`, validates no plan disappears without `why.removed`, and writes via `writeAtomicSync(file, content, 0o444)` (so `chmod 0444` happens **before** `renameSync`).
   - Update `writeIndex()` to also run under `withFileLock(indexLockPath(file), ...)` + `writeAtomicSync(..., 0o444)` for any direct callers.
   - Migrate all index RMW callers (`src/core/queue-close.ts:285`, `src/cli/dispatch.ts:349,373`, `src/core/owner-ui.ts:1991`) to use `updateIndex()` so concurrent `queue add` + `queue-close` or `/reorder` can never lose plans.
   - Update `src/core/uninstall.ts:163-169` so `uninstall --purge` also cleans up `indexLockPath(cfg.paths.queue_index)` if present.
3. Protect read-modify-write state files using `withFileLock` + `writeAtomicSync`:
   - `src/core/incidents.ts`: `incidents.jsonl` (`addIncident`, `planIncident`, `dismissIncident`, `fixedIncident`, `proposeIncident`) and `owner-messages.jsonl` (`writeOwnerStore`).
   - `src/core/guards.ts`: `edit-window.json`, `plan-reviews.json`, `main-reads.json`, `spawns.json`, `staffing.json`, `budgets.json`, `review-spawns.json`, `planner-spawns.json`.
   - `src/core/queue-close.ts:293`: `spawns.json` cleanup under the same lock/atomic write helper.
   - `src/core/plan-approval.ts`: `plan-approvals.json`.
4. Add unit & concurrency tests covering:
   - Double `release()` in `file-lock.ts` does not throw or close another fd.
   - `updateIndex()` / `writeIndex()` leaves no temp file, produces `0444` before rename, and preserves Plan B when `queue add` and `queue-close` run concurrently.
   - `expandHome("~")` reflects runtime `process.env.HOME` changes.
   - Concurrent `addIncident()` calls preserve all records without corrupting `incidents.jsonl`.

**Verification**: `bun test tests/file-lock.test.ts tests/index-guard.test.ts tests/incidents.test.ts tests/queue-lib.test.ts tests/plan-approval.test.ts tests/uninstall.test.ts tests/heavy-run-lock.test.ts` — 51 pass, 0 fail (exit 0).

---

### Phase 5: Bounded TTL Cache for `realTailscale.whois()` in `src/core/tailscale.ts`
**Status**: COMPLETE

**Justification**: Every HTTP request to `owner-ui`, `team-server`, and `pages` currently forks `tailscale whois --json <peer>` synchronously (up to 8s timeout). Caching positive peer->login resolutions for 30s (bounded to 256 entries, with a test reset helper) eliminates repeated event-loop stalls without weakening access revocation meaningfully.

**Tasks**:
1. In `src/core/tailscale.ts`:
   - Add a `WHOIS_TTL_MS = 30_000` and `WHOIS_MAX_ENTRIES = 256` cache helper `createCachedWhois(lookup, opts?: { ttlMs?: number; maxEntries?: number; now?: () => number })` (pure and directly unit-testable!).
   - Only cache non-null logins (transient `null` failures are never cached so recovery is immediate; expired entries are evicted on read; oldest entry evicted if size exceeds `maxEntries`).
   - Wire `realTailscale.whois` through this cache and export `clearWhoisCache()`.
2. Add unit tests verifying cache hit within TTL, expiry after TTL, non-caching of `null` failures, and max-entries bound.

**Verification**:
- `bun run typecheck` — exit 0
- `bun run lint` — 0 warnings, 0 errors across 323 files (exit 0)
- `bun test tests/tailscale.test.ts tests/owner-ui.test.ts tests/team-server.test.ts` — 145 pass, 0 fail (exit 0)
- Full targeted suite (`bun test tests/queue-close.test.ts tests/queue-close-worktree.test.ts tests/qclose-safety.test.ts tests/queue-cancel.test.ts tests/incident-close-record.test.ts tests/team-client.test.ts tests/team-server.test.ts tests/secret-redact.test.ts tests/secret-redact-omp.test.ts tests/file-lock.test.ts tests/index-guard.test.ts tests/incidents.test.ts tests/queue-lib.test.ts tests/plan-approval.test.ts tests/uninstall.test.ts tests/heavy-run-lock.test.ts tests/owner-ui.test.ts tests/guards.test.ts tests/host-neutral.test.ts tests/no-personal-markers.test.ts tests/tailscale.test.ts`) — 311 pass, 0 fail (exit 0)

---

## Definition of Done
- All 5 phases implemented and marked COMPLETE.
- Mapped memory file `docs/memory/20261120_1920_bugfixes_and_concurrency.md` updated after every phase.
- `bun run typecheck` exits 0.
- `bun run lint` exits 0.
- Targeted unit/concurrency tests and full test suite pass with 0 failures.
- Independent reviewer subagent reviews and approves all changes.
