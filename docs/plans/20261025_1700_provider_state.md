# Provider state: who is rate-limited comes from live data, and the owner's pick order is enforced
Worktree: /home/ukd/Work/neurastream-provider-state
Branch: fix/provider-state
Summary: Which AI provider is rate-limited comes from live data, not my guess, and your pick order of agents is enforced.

## Goal
- INCIDENT I-20261025-164 (owner correction, 2026-10-25): "you made the same mistake … you thought 18:56 GLM comes back when it was Chinese time and we built something on top of that". Main misread a zai 429 ("reset at 2026-10-25 18:56:22", Asia/Shanghai = 11:56 CET), wrote "glm rate limited until 18:56" into notes and a handoff, and skipped GLM all day.
- When done: a provider's out-until time is recorded by code from the 429 text (converted with `quota.reset_tz`), never typed by Main; `agent-ledger --cap` and `main-start` print live `providers:` status; the spawn gate enforces the owner's pick order GLM → deepseek → Haiku.
- INCIDENT I-20261025-217 (owner idea, 2026-10-25 ~23:55): "since we are in OMP and we can connect to multiple providers and access multiple models. Check if there is something, a plug …" — pick each subagent's model from live provider availability plus the owner's preference order. Main found no ready plugin; omp gives `omp models`, `retry.fallbackChains` and the `before_subagent_spawn` hook (returns `model: string[]`, first used, rest = fallback chain). Main recommends building it here (this plan already owns live provider state and the pick order), host-neutral: the router logic in src/core, the hook wiring in src/adapters/omp. No phases for it until the owner agrees on the design.
- Read /home/ukd/projects/opus-implementer-method.md first.

## Forbidden
- Host-neutral (owner 2026-10-26): logic and types in src/core name no harness (omp/opencode/codex/claude/cursor); harness-specific reads/writes live under src/adapters/<harness>/ (docs/adapter.md).
- Never push; never tag; never `npm publish`. Main merges and releases.
- Do not edit the reset-time parser (`src/core/reset-time.ts`) or its test; reuse `parseWhen`/`wallToEpoch`.
- Do not touch anything under /home/ukd/.omp/agent or the installed neurastream.
- Call budget: stop and report within ~100 calls.

## Blockers
- no-push
- deny-path /home/ukd/.omp/agent/**
- deny-path /home/ukd/.bun/**
- deny-path /home/ukd/.local/state/**
- deny-path src/core/reset-time.ts
- deny-path tests/reset-time.test.ts

## Phases
- [ ] P1 Record: new `src/core/provider-state.ts` with an append-only `<paths.queue_state>/provider-out.jsonl` (`{provider, until, at, source}` lines), `recordOut(provider, untilEpoch, source)`, `providerStatus(now)` → per provider `free` or `out until <local time>`. `quota-reset` (`src/core/quota-reset.ts`) gains `--provider <name>` that records the parsed time instead of only printing it. The adapter's `tool_result` hook records automatically when a `task` result matches `quota.reset_pattern`; the provider is the `model:` prefix of the agent's pin (e.g. `zai/glm-5.3-flash` → `zai`). A rate limit without a reset time (see `rateLimitWait` in `src/core/rate-limit.ts`) records now + its wait. Test: "reset at 2026-10-25 18:56:22" with zone Asia/Shanghai → zai out until 2026-10-25T10:56:22Z; after that time the status is `free`. — difficulty: 3 — verify: `bun run typecheck && bun test tests/provider-state.test.ts`
- [ ] P2 Show: `agent-ledger --cap` (`src/core/agent-ledger.ts`) and `main-start` (`src/core/main-start.ts`) print one line `providers: zai free · openrouter out until 18:40 · …`. `noteRequest` in `src/core/rollover.ts` gains the sentence "Do not state which agents or providers are rate-limited or free; that comes from agent-ledger --cap." Tests for both lines. Regression test for INCIDENT I-20261025-164, fail-before: with a recorded zai out-until in the past, `agent-ledger --cap` prints `zai free`; the test must fail on the old code (no providers line) and pass after; state both runs in Progress. — difficulty: 2 — verify: `bun run typecheck && bun test`
- [ ] P3 Enforce: config `ledger.prefer: []` (agent names in order; empty = off) in `src/core/config.ts` + `templates/config.yml`. `checkSpawn` in `src/core/guards.ts` denies (a) a brief claiming a provider that `providerStatus` shows free is rate-limited, and (b) spawning a lower `prefer` agent while a higher one is free and under its cap, unless the brief has `Pick note: <why>`. `agent-score gate` prints the prefer verdict. Tests: deny, allow with Pick note, allow when the higher pick is out, empty prefer = no change. README + CHANGELOG Unreleased. — difficulty: 4 — verify: `bun run typecheck && bun test`
  - Owner 2026-10-27 ~11:20: "you are using paid haiku over free glm, why? didnt we set the agent order? this is the 5th time it has happened, so it is clearly not working". Cause found: `agent-score gate` (src/core/agent-score.ts:545) ranks ONLY by score and prints "WARN gate: glm ranks #3; better-ranked: anthropic/claude-haiku-5-5 … Use one of those"; Main followed it and spawned haiku twice (CpTermsConsentHaiku, CpTermsConsentHaiku2) while GLM was free. The order in notes/subagents.md (GLM first, haiku last resort) is prose only; nothing enforces it. P3 must also change the gate: rank inside the `prefer` order, never recommend a later (paid) agent while an earlier one is free, and print `gate: glm is first in prefer and free → use it`. Test (fail-before): prefer [glm, deepseek, haiku], haiku has the higher score, glm free → gate recommends glm and main-guard refuses a haiku spawn without `Pick note:`.
- [ ] P4 Main: review, merge, release via `v*` tag, `bun add -g neurastream@latest`, `neurastream doctor` exit 0, set `ledger.prefer: [glm, deepseek, haiku]`, smoke: `quota-reset --provider zai "reset at <past time>"` → `agent-ledger --cap` shows zai free. — difficulty: 1 — verify: `neurastream doctor`

## Done check
`bun run typecheck && bun test`

## Code read by Main
- `src/core/quota-reset.ts`
- `src/core/reset-time.ts`
- `src/core/agent-ledger.ts`
- `src/core/guards.ts`
- `src/core/rollover.ts`
- `src/core/config.ts`
- `src/core/main-start.ts`
- `src/core/rate-limit.ts`
- `src/core/agent-score.ts`

## Progress
Status: open
- 2026-10-25 Main: plan written for INCIDENT I-20261025-164; GLM implements (live probe first). Findings: none
