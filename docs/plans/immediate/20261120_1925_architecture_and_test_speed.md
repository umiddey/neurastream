# Plan: Architecture Boundaries, Monolith Decomposition & Test Speed

**Status**: COMPLETE
**Created**: 2026-11-20 19:25
**Revised**: 2026-11-20 19:30 (incorporated Plan Reviewer findings)
**Mapped Memory**: `docs/memory/20261120_1925_architecture_and_test_speed.md`

## Thought Process & Context

After resolving security issues (Plan 1) and concrete bugs/races (Plan 2), three structural problems remain from our codebase review:

1. **Adapter & Layering Boundary Leaks**:
   - `src/adapters/index.ts:13` leaks `export { ompComplete } from "./omp/launch.ts"`, which `src/cli/recall.ts:4` imports directly — bypassing `getAdapter(cfg)` and hardcoding a specific harness into the CLI.
   - Four `src/core/` modules reach back into `src/cli/` via runtime paths, bypassing `tests/host-neutral.test.ts`'s import check:
     - `src/core/owner-ui.ts:1163` spawns `../cli/results-build.ts`
     - `src/core/main-start.ts:208` spawns `../cli/main.ts doctor`
     - `src/core/machine-guard.ts:25` passes `../cli/main.ts` as `HEAVY_MAIN` (and `process.execPath` as `HEAVY_STATUS`)
     - `src/core/queue-cancel.ts:88` spawns `../cli/main.ts queue-close` instead of calling `queueClose()` directly

2. **Three Oversized Monoliths (~6,700 LOC combined = ~20% of `src/` in 3 files)**:
   - `src/core/guards.ts`: **2,658 lines** (state persistence, review gates, planner mode, edit windows, call budgets, MR caching, incident gates, priority skips, team caps, and all 5 guard entry points in one file).
   - `src/core/owner-ui.ts`: **2,121 lines** (auth/CSP, data builders, owner messages, results cache, HTML/CSS/JS rendering, POST handlers, and `Bun.serve` HTTP server in one file).
   - `src/adapters/omp/index.ts`: **1,936 lines** (7 separate `pi.on("agent_end", ...)` listeners, rollover state machine, rate-limit probing, owner-inbox delivery, collab-prompt parsing, chat commands, and subagent detectors all nested inside one giant `createOmpAdapter()` closure).

3. **Slow Test Suite Bottlenecks**:
   - Running `bun test` took ~470s (~7.8 minutes) with 13 timeouts at the default 5s limit in `tests/host.test.ts` and `tests/main-start.test.ts`, and 7 `graceCfg()` fallback tests in `tests/rollover-omp.test.ts` (several taking ~10.3s each).
   - Root cause verified in `src/core/main-start.ts:208-209`: every unit test calling `mainStartText()` spawns a real `bun src/cli/main.ts doctor` child process (which probes the harness, `systemctl`, `tailscale`, etc.), adding 5–10 seconds per test even when all other bins are stubbed! Making `doctor` injectable via `MainStartDeps` simultaneously closes a `core -> cli` boundary violation AND makes `host.test.ts`, `main-start.test.ts`, and all 7 `graceCfg()` tests in `rollover-omp.test.ts` run in milliseconds instead of tens of seconds.

---

## Architecture & Design Decisions

- **100% backwards-compatible barrels & TDZ-safe export order**:
  - Keep `src/core/guards.ts`, `src/core/owner-ui.ts`, and `src/adapters/omp/index.ts` as clean barrels re-exporting every single existing exported symbol.
  - Because `guards.ts -> team-client.ts -> guards.ts` (`mainId`) and `blockers.ts -> guards.ts` (`MAIN_PLAN_FILE`) already exist as cycles, **`export * from "./guards/state.ts"` MUST be first** in `src/core/guards.ts`, and `src/core/guards/state.ts` MUST hold both `mainId` and `MAIN_PLAN_FILE` and MUST NOT import `team-client.ts` or any sibling `guards/*` module (zero TDZ cycle hazard).
  - In `src/core/owner-ui/`, `ANSWER_MAX` and `fieldsOf` (imported by `src/core/team-server.ts:12`) are explicitly placed in `src/core/owner-ui/auth.ts` and re-exported from `src/core/owner-ui.ts`.
- **Preserve `launch-upgrade.test.ts` string anchor**: `tests/launch-upgrade.test.ts:26,50` string-replaces the exact line `const out: string[] = [];` in `src/core/main-start.ts` — keep that exact line untouched.
- **No harness names in `src/core/`**: Every new file under `src/core/guards/` and `src/core/owner-ui/` must remain 100% free of harness names (even in comments) so `tests/host-neutral.test.ts` stays green.
- **No risky storage format rewrite**: Keep flat JSON/JSONL files under `queue_state` (already locked & atomic from Plan 2) so all existing operational tooling and test fixtures stay 100% compatible.

---

## Phases

### Phase 1: Close Adapter & `core -> cli` Layering Leaks
**Status**: COMPLETE

**Verification Result**:
- `bun run typecheck && bun run lint`: exit 0 (0 warnings, 0 errors across 323 files).
- `bun test tests/host-neutral.test.ts tests/recall-cli.test.ts tests/recall-topics-cli.test.ts tests/omp-complete.test.ts tests/machine-guard-darwin.test.ts tests/queue-cancel.test.ts tests/launch-upgrade.test.ts tests/main-start.test.ts`: 44 pass, 2 skip (macOS-only), 0 fail.
- `bun test --timeout 15000 tests/golden/ports-p4.test.ts`: 13 pass, 0 fail.

**Justification**: Restores the architectural invariant in `AGENTS.md` ("CLI reaches harnesses only through `HarnessAdapter`; `src/core/` never reaches into `src/cli/`") and creates the injectable `doctor` seam needed for fast tests.

**Tasks**:
1. **Move `ompComplete` behind `HarnessAdapter` (single canonical type definition)**:
   - Move `CompleteRequest` and `CompleteResult` from `src/core/owner-topics.ts:14-26` into `src/core/adapter.ts` and re-export them from `src/core/owner-topics.ts` so there is one canonical definition with zero breaking imports.
   - Add `complete(req: CompleteRequest): Promise<CompleteResult>` to `HarnessAdapter` in `src/adapters/index.ts`.
   - Wire `complete: ompComplete` in `src/adapters/omp/adapter.ts`.
   - Remove `export { ompComplete } from "./omp/launch.ts";` from `src/adapters/index.ts`.
   - Update `src/cli/recall.ts` to call `getAdapter(cfg).complete`.
2. **Remove all four `src/core/` -> `src/cli/` runtime back-references**:
   - `src/core/main-start.ts`: Add `doctor?: () => Promise<string> | string` to `MainStartDeps` (keeping `const out: string[] = [];` verbatim for `tests/launch-upgrade.test.ts`!). Supply the real `doctor` runner from `src/cli/commands.ts` (`main-start`), `src/adapters/omp/index.ts` (`rolloverInProcess`), and `src/adapters/omp/launch.ts` (`nextMessage`). When `deps.doctor` is omitted, skip spawning `../cli/main.ts` (return `""` or print nothing under `=== doctor`, verifying `tests/golden/ports-p4.test.ts` and `tests/main-start.test.ts` stay 100% green!).
   - `src/core/owner-ui.ts`: Move `spawnResultsBuild` into `src/cli/workspace.ts` (which passes it into `startOwnerUi({ ..., resultsBuild })`), and default `resultsBuild` in `src/core/owner-ui.ts` to a no-op `(done) => done()`, removing `../cli/results-build.ts` from `src/core/`.
   - `src/core/machine-guard.ts`: Change signature to `machineGuard(args: string[], cfg: Config, opts: { heavyMain: string; heavyStatus?: string })` with `heavyMain` required (matching `templates/machine-guard.sh:12-13`'s `${HEAVY_MAIN:?}`) and `heavyStatus` defaulting to `"bun"` (not `process.execPath`), supplied by its sole caller `src/cli/commands.ts:93`.
   - `src/core/queue-cancel.ts`: Replace spawning `../cli/main.ts queue-close` with calling `queueClose([file], cfg)` directly (now safe after Plan 2 Phase 1 removed `process.exit(1)` from `queueClose`!). Verify `tests/queue-cancel.test.ts` and `tests/golden/ports-p4.test.ts` remain green.
3. **Tighten `tests/host-neutral.test.ts`**:
   - Add a test asserting no file in `src/core/` contains relative escape paths matching `/(?:\.\.\/)+cli\//` (explicitly NOT banning legitimate `src/cli/main.ts` detection in `src/core/queue/lib.ts:681` or doc comments).

**Verification**: `bun test tests/host-neutral.test.ts tests/recall-cli.test.ts tests/recall-topics-cli.test.ts tests/omp-complete.test.ts tests/machine-guard-darwin.test.ts tests/queue-cancel.test.ts tests/launch-upgrade.test.ts`

---

### Phase 2: Decompose `src/core/guards.ts` (2,658 LOC) into `src/core/guards/`
**Status**: COMPLETE

**Verification Result**:
- `bun run typecheck && bun run lint`: exit 0 (0 warnings, 0 errors across 330 files).
- `bun test tests/guards*.test.ts tests/blockers-shell.test.ts tests/team-client.test.ts tests/host-neutral.test.ts`: 176 pass, 0 fail.
- Line counts: `guards.ts` (12), `guards/state.ts` (581), `guards/review.ts` (391), `guards/planner.ts` (70), `guards/spawn.ts` (699), `guards/tool.ts` (541), `guards/plan-edit.ts` (338), `guards/stop.ts` (235).

**Justification**: At 2,658 lines, `src/core/guards.ts` is the single largest maintenance bottleneck in the codebase. Splitting it along its existing internal boundaries makes each rule group independently readable and testable without changing any external API.

**Tasks**:
1. Extract cohesive modules under `src/core/guards/`:
   - `src/core/guards/state.ts` (**zero imports from `team-client.ts` or sibling `guards/*`**): `log`, `MAIN_ID_RE`, `MAIN_PLAN_FILE`, `mainId`, `mainStateDir`, `EditWindow`, `readWindow`, `writeWindow`, `readStaffing*`, `recordSpawns`, `staffedPlans`, `rekeySpawn*`, `briefBudget`, `readBudgets`, `recordBudgets`, `subCallCap`, `recordMainReads`, `recordMainResult`, `resetMainCalls`, `revertMainEdit`.
   - `src/core/guards/review.ts`: `reviewPassProblem`, `recordReviews`, `reviewSpawnEnd`, `reviewLockProblem`, MR cache (`readMrCache`/`writeMrCache`), `pendingWorkProblem`, `briefNamesPending`.
   - `src/core/guards/planner.ts`: `plannerRolePlan`, `plannerPlanProblem`, `plannerSpawnPlan`, `plannerBody`, planner spawn tracking.
   - `src/core/guards/spawn.ts`: `planGate`, `priorityProblem`, `preferProblem`, `providerClaimProblem`, `teamCapProblem`, `spawnProblem`, `incidentSpawnProblem`, `taskLaunch`, `bypassLaunch`, `checkSpawn`.
   - `src/core/guards/tool.ts`: `isProjectPath`, `changedProjectFiles`, `bypassRegExp`, `checkTool`, `tuned`, `editWindow`, `mainCallStop`/`Warn`, `subRules`.
   - `src/core/guards/plan-edit.ts`: `PlanEditDecision`, `checkPlanEdit`, `planReadNote`, `newProgressEntries`, `findingsValue`, `isOwnerProse`.
   - `src/core/guards/stop.ts`: `CANCEL_TODO`, `flagCancel`, `checkInject`, `openQueue`, `liveSubagents`, `STOP_PLAN_OFFER_REFUSAL`, `checkStop`, `incidentLine`.
2. Keep `src/core/guards.ts` as a thin barrel with `export * from "./guards/state.ts"` **first**, followed by the other submodules and `export { reviewHash } from "./plan-approval.ts"`.
3. Ensure zero circular-import TDZ issues and zero harness words in any new file under `src/core/guards/`.

**Verification**: `bun run typecheck && bun run lint && bun test tests/guards*.test.ts tests/blockers-shell.test.ts tests/team-client.test.ts tests/host-neutral.test.ts`

---

### Phase 3: Decompose `src/core/owner-ui.ts` (2,121 LOC) into `src/core/owner-ui/`
**Status**: COMPLETE

**Verification Result**:
- `bun run typecheck && bun run lint`: exit 0 (0 warnings, 0 errors across 337 files).
- `bun test tests/owner-ui.test.ts tests/team-page.test.ts tests/team-server.test.ts tests/host-neutral.test.ts`: 154 pass, 0 fail (3.57s).
- Line counts: `owner-ui.ts` (11), `owner-ui/auth.ts` (164), `owner-ui/messages.ts` (209), `owner-ui/results.ts` (266), `owner-ui/data.ts` (437), `owner-ui/render.ts` (714), `owner-ui/handlers.ts` (250), `owner-ui/server.ts` (142).

**Justification**: Separating auth/CSP, data builders, message storage, Results computation, HTML rendering, POST handlers, and HTTP server plumbing turns a 2,121-line monolith into ~200–450 line focused modules.

**Tasks**:
1. Extract cohesive modules under `src/core/owner-ui/`:
   - `src/core/owner-ui/auth.ts`: `ANSWER_MAX`, `fieldsOf`, `UiHttpServer`, `Auth`, `isLoopback`, `isTailnet`, `authenticate`, `hostAllowlist`, `originIsHost`, `pageCsp`, `textRes`, `jsonSent`, `jsonFail`. (Note: `team-server.ts:12` imports `ANSWER_MAX` and `fieldsOf` through `src/core/owner-ui.ts`.)
   - `src/core/owner-ui/messages.ts`: `OWNER_MESSAGE_KEEP_SEC`, `inboxPath`, `runningMains`, `ownerMessageTarget`, `MessageRow`, `sweepOwnerMessages`, `recentOwnerMessages`, `storeOwnerMessage`, `handleMessage`, `handleMessageImage`.
   - `src/core/owner-ui/results.ts`: `ResultsData`, `ResultsView`, `ResultsBuild`, `resultsCachePath`, `computeResults`, `resultsView`, results HTML rendering helpers.
   - `src/core/owner-ui/data.ts`: `QuestionRow`, `AgentRow`, `QueueRow`, `CiRow`, `IncidentRow`, `ScoresData`, `MachineRow`, `NowStats`, `TeamSection`, `PublishedPageRow`, `PageData`, and all row builders (`questionRows`, `agentRows`, `queueRows`, `teamSections`, `teamSection`, `ciRows`, `incidentRows`, `scoresData`, `machineRow`, `nowStats`, `buildPageData`).
   - `src/core/owner-ui/render.ts`: `dropSlot`, `edgeScrollStep`, `renderPage`, `TeamPageData`, `renderTeamPage`, tab HTML helpers (including sandboxed `knowledgeHtml`).
   - `src/core/owner-ui/handlers.ts`: `handleAnswer`, `handleTeamAnswer`, `handleIncident`, `handleUnlock`, `handleLock`, `handleTier`, `handleReorder`, `reorderedIndexText`.
   - `src/core/owner-ui/server.ts`: `OwnerUiServer`, `OwnerUiOptions`, `startOwnerUi`.
2. Keep `src/core/owner-ui.ts` as a thin barrel re-exporting all public exports.

**Verification**: `bun run typecheck && bun run lint && bun test tests/owner-ui.test.ts tests/team-page.test.ts tests/team-server.test.ts tests/host-neutral.test.ts`

---

### Phase 4: Decompose `src/adapters/omp/index.ts` (1,936 LOC) into Cohesive Adapter Modules
**Status**: COMPLETE

**Verification Result**:
- `bun run typecheck && bun run lint`: exit 0 (0 warnings, 0 errors across 343 files).
- `bun test --timeout 15000 tests/omp-*.test.ts tests/rollover-omp.test.ts tests/rate-limit-omp.test.ts tests/chat-unlock.test.ts tests/owner-answer-steer.test.ts tests/guards-omp.test.ts tests/host-neutral.test.ts`: 120 pass, 0 fail (78.76s prior to Phase 5 `doctor` stubbing; 7 `rollover-omp` fallback tests each ~10.2s).
- Line counts: `index.ts` (1,012 — down from 1,936, with 7 `agent_end` listeners consolidated into 1 ordered pipeline), `types.ts` (143), `inbox.ts` (221), `auto-close.ts` (64), `rate-limit-controller.ts` (196), `rollover-controller.ts` (334), `chat-commands.ts` (161).

**Justification**: `src/adapters/omp/index.ts` currently holds 1,936 lines with 7 separate `pi.on("agent_end", ...)` listeners inside one monolithic function. Breaking it into focused modules makes event ordering explicit and prepares the adapter for future multi-harness extraction.

**Tasks**:
1. Extract cohesive modules under `src/adapters/omp/`:
   - `src/adapters/omp/types.ts`: `ExtensionHost`, `HostCtx`, `EventReply`, `asRecord`, `asString`, `asCtx`, `lastAssistantIn`, `toExtensionResult`.
   - `src/adapters/omp/inbox.ts`: `OWNER_INBOX_POLL_MS`, `CLAIM_BEAT_MS`, `ownerInboxCursorPath`, `ownerInboxMessage`, `pendingInboxRecords`, `deliverOwnerInbox`, `pressureTick`.
   - `src/adapters/omp/auto-close.ts`: `autoClose`, `closeChildArgs`.
   - `src/adapters/omp/rate-limit-controller.ts`: `limitProbeSpawn`, `recordProviderOutFromRateLimit`, rate-limit episode state controller (`createRateLimitController`).
   - `src/adapters/omp/rollover-controller.ts`: rollover snapshot, relaunch request, exit-grace timer, in-process fallback (`createRolloverController`), accepting an optional `doctor` seam for tests.
   - `src/adapters/omp/chat-commands.ts`: interactive `input` and `context` collab-prompt unlock/tier/planner/go/approve handlers and reset-time annotation.
2. Refactor `createOmpAdapter()` in `src/adapters/omp/index.ts` to compose these controllers cleanly, consolidating the 7 scattered `pi.on("agent_end", ...)` registrations into one clear ordered `agent_end` pipeline (preserving exact execution order!).
3. Preserve all exported symbols from `src/adapters/omp/index.ts` (`default`, `createOmpAdapter`, `reset`, `freshPlannerConfig`, `stampPlannerState`, `toExtensionResult`, `autoClose`, `recordProviderOutFromRateLimit`, `OWNER_INBOX_POLL_MS`, `CLAIM_BEAT_MS`, `ownerInboxCursorPath`, `ownerInboxMessage`, `pendingInboxRecords`, `deliverOwnerInbox`, `pressureTick`, `limitProbeSpawn`, `adapterLog`).

**Verification**: `bun run typecheck && bun run lint && bun test tests/omp-*.test.ts tests/rollover-omp.test.ts tests/rate-limit-omp.test.ts tests/chat-unlock.test.ts tests/owner-answer-steer.test.ts tests/guards-omp.test.ts`

---

### Phase 5: Fix Slow Test Bottlenecks
**Status**: COMPLETE

**Verification Result**:
- `bun run typecheck && bun run lint`: exit 0 (0 warnings, 0 errors across 343 files).
- Targeted speed test (`bun test tests/host.test.ts tests/main-start.test.ts tests/provider-state-show.test.ts tests/mr-sweep-wiring.test.ts tests/rollover-omp.test.ts tests/no-personal-markers.test.ts tests/host-neutral.test.ts`): **57 pass, 0 fail in 1.70s** (down from ~72s+ in `rollover-omp.test.ts` alone and 13 timeouts at 5s in `host.test.ts`/`main-start.test.ts`).
- `TZ=Europe/Berlin bun test --timeout 15000 tests/golden tests/quota-reset.test.ts`: **27 pass, 0 fail** (31.08s).
- Full `bun test --timeout 15000`: **2,087 pass, 3 skip (macOS-only), 6 sandbox-only failures** across 189 files in **318.96s** (down from ~470s before Plan 3; the 6 failures are strictly sandbox restrictions unrelated to Plan 3: `EROFS` outside workspace in `guard-rule-ids.test.ts` & `guard-tuning-read.test.ts`, sandbox port bind in `tailnet-rebind.test.ts`, and offline `npm view` 16.7s > 15s timeout in `doctor.test.ts`).

**Justification**: Eliminating unstubbed `doctor` subprocess spawns inside unit tests that aren't testing `doctor` cuts multi-second waits out of `host.test.ts`, `main-start.test.ts`, and all 7 `graceCfg()` tests in `rollover-omp.test.ts`, preventing 5s timeouts and dramatically speeding up the feedback loop.

**Tasks**:
1. In `tests/host.test.ts`, `tests/main-start.test.ts`, `tests/provider-state-show.test.ts`, and `tests/mr-sweep-wiring.test.ts`:
   - Pass a lightweight stub `doctor: () => "doctor: ok\n"` via `MainStartDeps` for tests that are not specifically testing `doctor` output.
2. In `tests/rollover-omp.test.ts`:
   - Pass `doctor: () => "doctor: ok\n"` through the optional `createOmpAdapter` test seam across all 7 `graceCfg()` fallback tests (lines 424, 444, 464, 483, 503, 526, 597), keeping `agent host: a child's stderr is appended to the handoff text` running the real `mainStartText` with stubbed `doctor` so it tests real child stderr capture in <1s instead of 10s.
3. Run the full test suite and record total runtime before vs. after in the memory log.

**Verification**: `bun run typecheck && bun run lint && bun test` + `TZ=Europe/Berlin bun test tests/golden tests/quota-reset.test.ts`.

---

## Definition of Done
- All 5 phases implemented and marked COMPLETE.
- Mapped memory file `docs/memory/20261120_1925_architecture_and_test_speed.md` updated after every phase.
- `bun run typecheck` exits 0.
- `bun run lint` exits 0.
- Full `bun test` passes with 0 failures and materially reduced runtime.
- Independent reviewer subagent reviews and approves all changes.
