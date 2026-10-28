# Write-time code checks
Worktree: /home/ukd/Work/neurastream-write-checks
Branch: feat/write-checks
Summary: Every file an agent edits is linted the moment it changes; an edit that adds a new lint problem or a new suppression comment is undone and the agent is told why.

## Goal
- Owner (2026-10-28): bad code must be caught "the moment they write", not reactively in review or CI.
- Only problems the edit ADDS are refused (old lint debt never freezes a file); a new `noqa` / `eslint-disable` / `@ts-ignore`-style comment counts as a new problem.
- Off in the shipped template; the owner's config turns it on.

## Forbidden
- Pushing, tagging or publishing.
- Blocking an edit because a linter is missing, crashed or timed out (log it, allow the edit).
- Running a linter through a shell or with a string command line; argv arrays only.
- Naming a harness in `src/core/write-check.ts`.
- A second path-extraction helper: reuse `writeTargets` in `src/core/queue/lib.ts:536`.

## Blockers
- no-push
- blockers/write-checks-scope.sh

## Phases
- [ ] P1 Core check `src/core/write-check.ts` — difficulty: 3 — verify: `bun test tests/write-check.test.ts`
  - `checkWrite(file, before: string | null, after: string | null, wc: Config["write_check"]): { allow: true; note?: string } | { allow: false; reason: string }`. A deleted file (`after === null`) or a file no linter entry matches by extension is allowed.
  - Each linter entry: `ext` list, `argv` with a `{file}` placeholder, `pattern` regex with a named group `rule` (one finding per matching output line). Findings are counted per rule key, for before and after; a key whose count grew is a new problem. Lines matching `wc.suppress` count under one key `suppression` the same way.
  - The before text is linted from a temp file with the same extension in the same directory (so the repo's own linter config applies), removed in a `finally`. `before === null` (new file) → no before findings.
  - `spawnSync` with `wc.timeout_ms`; ENOENT, a signal or a timeout → allow and return a `note` the adapter logs.
  - The refusal reason lists each new rule with one sample output line, ends with "the file was restored to its state before this edit; fix it and edit again — do not add suppression comments", and is at most 2000 chars.
  - Tests use a fake linter (a small bun script in `tests/fixtures/write-check/`) so the suite needs neither ruff nor oxlint: grown key refused, equal count allowed, new suppression refused, old suppression allowed, missing binary allowed, timeout allowed.
- [ ] P2 Config — difficulty: 2 — verify: `bun test tests/config.test.ts && bun run typecheck`
  - `src/core/config.ts` `Config.write_check`: `enabled: boolean`, `applies_to: "sub" | "all"`, `timeout_ms: number`, `suppress: string` (regex source), `linters: {ext: string[]; argv: string[]; pattern: string}[]`, with load-time validation like the neighbouring sections (bad regex → load error naming the key).
  - `templates/config.yml` gains the block with `enabled: false`, `applies_to: sub`, `timeout_ms: 5000`, the suppress regex `noqa|type:\s*ignore|oxlint-disable|eslint-disable|biome-ignore|@ts-ignore|@ts-expect-error|@ts-nocheck`, and two linter entries: ruff (`["ruff","check","--no-cache","--output-format=concise","--select","E,F,B,S,C90,PERF,SIM","{file}"]`) and oxlint (`["oxlint","-f","unix","-D","correctness","-D","suspicious","-D","perf","{file}"]`) with matching patterns.
  - `docs/config.md` documents the section.
- [ ] P3 Adapter wiring — difficulty: 3 — verify: `bun test tests/omp-write-check.test.ts`
  - `src/adapters/omp/index.ts` `tool_call` (line 824): when `cfg.write_check.enabled` and the caller is covered by `applies_to`, snapshot (text or null) each `writeTargets(tool, input, cwd)` file whose extension a linter entry names, keyed by toolCallId — beside the existing plan snapshot, not inside `snapshotPlans`.
  - `tool_result` (line 880): for a non-error result with a snapshot, run `checkWrite`; on refusal write the before text back (or remove a file that did not exist) and return `{ isError: true, content: [{type:"text", text: reason}] }`; log every refusal and every note with `adapterLog` (`WRITE-CHECK refused <file>: <rules>`). A plan-guard refusal of the same call keeps its own reason (it runs first).
  - Test drives the registered handlers with a fake `pi` and the fake linter from P1: refused edit restores the file and returns isError; clean edit untouched; `applies_to: sub` leaves Main's edit alone.
  - `docs/adapter.md` gets one line on the hook; CHANGELOG `## Unreleased` entry; README feature row.
- [ ] P4 Land (Main) — difficulty: 1 — verify: `neurastream doctor`
  - Merge, tag, install; turn it on in the owner config with ruff + oxlint; one real spawn watched in the guard log.

## Done check
`cd /home/ukd/Work/neurastream-write-checks && bun test tests/write-check.test.ts tests/omp-write-check.test.ts && git fetch -q origin && git merge-base --is-ancestor HEAD origin/main`

## Code read by Main
- `src/adapters/omp/index.ts`
- `src/core/queue/lib.ts`
- `src/core/config.ts`
- `templates/config.yml`
- `docs/plans/blockers/finding-taps-scope.sh`

## Progress
Status: open
- 2026-10-28 12:28 Main: plan written from the trial below. Findings: none

## Background
- Trial 2026-10-28 (throwaway `/tmp/wtc/write-check.ts`, loaded with `omp -p -e`): haiku ran plan 20261028_1135_finding_taps end to end with it — 133 calls, 8.5 Mtok, $0.20; 8 refusals, 26 clean edits. Four identical back-to-back refusals on one file (~33 s) ended with the agent restoring the file and redoing the phase. The first prototype let the agent silence findings with `# noqa`; counting new suppressions closed that.
- oxlint has no security rules for TypeScript; ruff `S` covers Python security. Hook cost 160–390 ms per edit.
