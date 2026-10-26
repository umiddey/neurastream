# Rate-limit resume: wake up when the provider says, not later
Worktree: /home/ukd/Work/neurastream-rate-honor
Branch: fix/rate-honor-retry-after

## Goal
- INCIDENT I-20261025-195. Owner (2026-10-25 20:17, 20:22, 20:26): "why didnt this start by itself" / "when the rate limit ended, the agent … were not to go automatically. It was working before."
- What happened (~/.local/state/main-guard.log + session 2026-10-25T19-44-40-321Z_01a17497): 19:44:44Z 429 `retry-after-ms=2115000` → `RATE-LIMIT stop: resume at 21:20 (2130s, attempt 1)` (correct: 20:20Z). 19:45:12Z the owner wrote → `resume cancelled: owner message`; that turn hit the same limit → `resume at 21:45 (3615s, attempt 2)`: the provider's own retry-after was doubled and capped to 3600 s, so the wake-up moved 25 min past the real end. 20:17:39Z again: `639s, attempt 3` (provider value ×4). The limit had actually ended ~20:20Z; the owner restarted by hand at 20:22Z.
- Cause: `rateLimitWait` (src/core/rate-limit.ts:52-61) doubles the wait from attempt 2 even when the error text names a retry-after. The provider's number is the truth; doubling only makes sense for the default guess.
- Done means: when the error text names a retry-after, the wait is exactly that (+ slack, clamped to max_wait_s) on every attempt; doubling applies only to the `default_wait_s` fallback. Replaying tonight's turns gives resume times ≈20:20Z each (that turn's own retry-after + 15 s), never 20:45Z.

## Background
- Read /home/ukd/projects/opus-implementer-method.md first.
- Small fix: stop and report within ~100 calls.

## Forbidden
- Never push, merge, tag or publish; commit on the plan's branch and report.
- Never touch the live setup (`~/.omp/agent`, `~/.local/state`, `~/.local/bin`, `~/.bun`, the user config dir).
- No change to patterns, cap, slack, notify-once-per-episode or the cancel-on-real-turn rule.

## Blockers
- no-push
- blockers/rate-honor-scope.sh
- deny-path /home/ukd/.omp/agent/** /home/ukd/.bun/** /home/ukd/.local/state/** /home/ukd/.local/bin/**

## Phases
- [ ] P1 `src/core/rate-limit.ts`: `retryAfterMs` reports whether the text named a value; `rateLimitWait` doubles per attempt ONLY when it did not. Update its doc comment, the file header of tests/rate-limit.test.ts (:1-4) and the comment at src/adapters/omp/index.ts:465-469 ("The attempt doubles the wait" → only without a provider retry-after). tests/rate-limit.test.ts: the test "a doubled wait above max_wait_s is clamped, then slack is added" (:54-57) pins doubling of a named retry-after — rewrite it to use a text without retry-after. Add the regression for I-20261025-195, fail-before: `rateLimitWait("error", REAL_429 with retry-after-ms=2115000, now, cfg, 2)` → `waitMs === (2115+15)*1000`; attempt 3 with `retry-after-ms=156000` → `(156+15)*1000`. Keep the default-wait doubling tests (:44-52). docs/config.md + README "Provider rate limits" + CHANGELOG Unreleased, one line each. — difficulty: 4 — verify: `heavy-run "rate-honor" bun test tests/rate-limit.test.ts tests/rate-limit-omp.test.ts && bun run typecheck && docs/plans/blockers/rate-honor-scope.sh`
- [x] P2 Main: review, merge, release via `v*` tag, `bun add -g neurastream@latest`, `neurastream doctor` exit 0. — difficulty: 1 — verify: `git -C /home/ukd/projects/neurastream merge-base --is-ancestor fix/rate-honor-retry-after origin/main && neurastream doctor`

## Done check
`cd /home/ukd/Work/neurastream-rate-honor && bun test tests/rate-limit.test.ts tests/rate-limit-omp.test.ts && git merge-base --is-ancestor HEAD origin/main`

## Code read by Main
- `src/core/rate-limit.ts`
- `src/adapters/omp/index.ts`
- `tests/rate-limit.test.ts`

## Progress
Status: complete
- 2026-10-25 22:52 Main: owner said yes on the phone page; `bun add -g neurastream@0.2.26` installed, `neurastream doctor: ok` (installed 0.2.26 = registry). Findings: none
- 2026-10-25 20:30 Main: plan written from the guard log and session evidence above. Findings: none
- 2026-10-25 P1 implemented in commit `7752998` (regression-test-first commit `47c6fe4`). Fail-before: `heavy-run "rate-honor" "fail-before" -- bun test tests/rate-limit.test.ts` exited 1; incident assertion expected 2130000 ms and received 3615000 ms under old retry-after doubling. Final acceptance: `heavy-run "rate-honor" "acceptance" -- bun test tests/rate-limit.test.ts tests/rate-limit-omp.test.ts && bun run typecheck && /home/ukd/projects/neurastream/docs/plans/blockers/rate-honor-scope.sh` exited 0 (26 pass, 0 fail; typecheck clean; scope script clean). Findings: none
