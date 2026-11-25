# 20261120_1925_architecture_and_test_speed
**Task**: Close adapter and `core -> cli` boundary leaks, decompose the three largest monoliths (`guards.ts`, `owner-ui.ts`, `adapters/omp/index.ts`), and eliminate slow test subprocess bottlenecks
**Status**: COMPLETE

## WHAT
- Plan created and revised after independent Plan Reviewer audit (all blockers, important findings & nits incorporated) ✓
- Phase 1 (Close adapter & `core -> cli` boundary leaks) ✓
- Phase 2 (Decompose `src/core/guards.ts` into `src/core/guards/`) ✓
- Phase 3 (Decompose `src/core/owner-ui.ts` into `src/core/owner-ui/`) ✓
- Phase 4 (Decompose `src/adapters/omp/index.ts` into cohesive adapter modules) ✓
- Phase 5 (Eliminate slow `doctor` subprocess bottlenecks in tests) ✓

## HOW
- Audited every call site of `ompComplete`, `spawnResultsBuild`, `mainStartText`, `machineGuard`, and `queueCancel`, and mapped section boundaries of `guards.ts` (2,658 LOC), `owner-ui.ts` (2,121 LOC), and `adapters/omp/index.ts` (1,936 LOC).
- Incorporated Plan Reviewer feedback: narrowed `host-neutral.test.ts` CLI path check to `/(?:\.\.\/)+cli\//`, made `machineGuard` `heavyMain` required, preserved `const out: string[] = [];` in `main-start.ts` for `launch-upgrade.test.ts`, unified `CompleteRequest`/`CompleteResult` into `adapter.ts`, documented TDZ-safe `guards/state.ts`-first barrel order and `ANSWER_MAX`/`fieldsOf` placement in `owner-ui/auth.ts`, and noted all 7 `agent_end` listeners and all 7 `graceCfg()` tests.

## WHY
- `src/adapters/index.ts` leaked `ompComplete` directly to `src/cli/recall.ts`, and four `src/core/` modules reached back into `src/cli/` via runtime paths, bypassing `tests/host-neutral.test.ts`.
- Three files held ~6,700 LOC (~20% of `src/`), making maintenance and future multi-harness support difficult.
- Unstubbed `bun src/cli/main.ts doctor` child spawns inside `mainStartText()` caused 5–10s per-test delays and 5s timeouts across `tests/host.test.ts`, `tests/main-start.test.ts`, and `tests/rollover-omp.test.ts`.

## FILES MODIFIED
- `docs/plans/immediate/20261120_1925_architecture_and_test_speed.md`: created and revised phased architecture & test-speed plan; marked Phases 1–5 COMPLETE
- `docs/memory/20261120_1925_architecture_and_test_speed.md`: created and updated 1:1 mapped memory log
- `src/core/adapter.ts`: moved canonical `CompleteRequest` and `CompleteResult` definitions here
- `src/core/owner-topics.ts`: imported and re-exported `CompleteRequest` / `CompleteResult` from `./adapter.ts`
- `src/adapters/index.ts`: added `complete(req)` to `HarnessAdapter` and removed leaked `export { ompComplete }`
- `src/adapters/omp/adapter.ts`: wired `complete: ompComplete`
- `src/cli/recall.ts`: called `getAdapter(cfg).complete` instead of importing `ompComplete` directly
- `src/core/main-start.ts`: added injectable `doctor?: () => Promise<string> | string` to `MainStartDeps` and removed `../cli/main.ts` spawn (preserved `const out: string[] = [];`)
- `src/cli/commands.ts`: added `CLI_MAIN` and `runCliDoctor()`, supplied `doctor` to `mainStart` and `{ heavyMain, heavyStatus }` to `machineGuard`
- `src/adapters/omp/launch.ts`: exported `runCliDoctor()` and passed it to `mainStart` in `nextMessage`; imported `CompleteRequest`/`CompleteResult` from `../../core/adapter.ts`
- `src/adapters/omp/index.ts`: passed `doctor: runCliDoctor` to `mainStartText` in `rolloverInProcess`
- `src/core/owner-ui.ts` & `src/cli/workspace.ts` & `src/cli/results-build.ts`: moved `spawnResultsBuild` to `src/cli/workspace.ts`, defaulted `resultsBuild` in `src/core/owner-ui.ts` to a no-op
- `src/core/machine-guard.ts`: required `opts: { heavyMain: string; heavyStatus?: string }` (default `heavyStatus: "bun"`), removed `../cli/main.ts`
- `src/core/queue-cancel.ts`: called `queueClose([file], cfg)` directly instead of spawning `../cli/main.ts queue-close`
- `tests/host-neutral.test.ts`: added regression test banning `/(?:\.\.\/)+cli\//` in `src/core/`
- `src/core/guards.ts`: reduced to 12-line TDZ-safe barrel exporting `./guards/state.ts` first
- `src/core/guards/{state,review,planner,spawn,tool,plan-edit,stop}.ts`: decomposed 2,739-LOC monolith into 7 acyclic modules preserving all 53 exports and Plan 2 atomic/locked writes
- `src/core/owner-ui.ts`: reduced to 11-line barrel exporting `./owner-ui/auth.ts` first
- `src/core/owner-ui/{auth,messages,results,data,render,handlers,server}.ts`: decomposed 2,132-LOC monolith into 7 acyclic modules preserving Plan 1 sandboxed `knowledgeHtml` + `/knowledge/*` CSP headers, `allowLoopback`, and Plan 2 `updateIndex` reorder
- `src/adapters/omp/index.ts`: reduced from 1,936 to 1,012 lines, consolidated 7 `agent_end` listeners into 1 ordered pipeline, added optional `OmpAdapterOptions.doctor` seam, preserved all exports
- `src/adapters/omp/{types,inbox,auto-close,rate-limit-controller,rollover-controller,chat-commands}.ts`: extracted 6 cohesive adapter modules
- `tests/host.test.ts`, `tests/main-start.test.ts`, `tests/provider-state-show.test.ts`, `tests/mr-sweep-wiring.test.ts`: passed lightweight `{ doctor: () => "doctor: ok\n" }` via `MainStartDeps`
- `tests/rollover-omp.test.ts`: passed `{ doctor: () => "doctor: ok\n" }` via `createOmpAdapter`'s `OmpAdapterOptions` seam across all `graceCfg()` fallback tests (lines 424, 444, 464, 483, 503, 526, 597, 795, 842)

## VERIFICATION
- `bun run typecheck`: exit 0 (`tsc --noEmit`)
- `bun run lint`: exit 0 (`oxlint --deny-warnings`: 0 warnings, 0 errors on 343 files)
- `bun test tests/host.test.ts tests/main-start.test.ts tests/provider-state-show.test.ts tests/mr-sweep-wiring.test.ts tests/rollover-omp.test.ts tests/no-personal-markers.test.ts tests/host-neutral.test.ts`: 57 pass, 0 fail in **1.70s** (before: ~72s+ in `rollover-omp.test.ts` alone + 13 timeouts at 5s in `host.test.ts`/`main-start.test.ts`)
- `TZ=Europe/Berlin bun test --timeout 15000 tests/golden tests/quota-reset.test.ts`: 27 pass, 0 fail (31.08s)
- `bun test --timeout 15000`: 2,087 pass, 3 skip (macOS-only), 6 sandbox-only failures across 189 files in **318.96s** (before: ~470s; ~151s / 32% faster; the 6 failures are strictly sandbox environment restrictions: `EROFS` outside workspace in `guard-rule-ids.test.ts` & `guard-tuning-read.test.ts`, sandbox port bind in `tailnet-rebind.test.ts`, and offline `npm view` 16.7s > 15s timeout in `doctor.test.ts`)

## NEXT SESSION
- Hand off to independent Code Reviewer subagent to audit all Plan 3 changes before removing the plan from the immediate queue.

## REFERENCES
- Plan: `docs/plans/immediate/20261120_1925_architecture_and_test_speed.md`
- Key files: `src/adapters/index.ts`, `src/cli/recall.ts`, `src/core/main-start.ts`, `src/core/machine-guard.ts`, `src/core/guards.ts`, `src/core/owner-ui.ts`, `src/adapters/omp/index.ts`, `tests/host-neutral.test.ts`
