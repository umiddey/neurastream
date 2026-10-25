# Reset times reach Main already in local time
Worktree: /home/ukd/Work/neurastream-reset-local
Branch: feat/reset-local-time

## Goal
- Owner (2026-10-25 ~11:50): "next time you convert the script is your textual promise. It's not forced on you… how do we force it on you?… I don't want to be hard coding this shit in neurastream because the future [provider] might finally show their reset time in the local time zone". Then "Yes, plan."
- What happened: a zai 429 said "Your limit will reset at 2026-10-25 18:56:22" (provider wall clock, Asia/Shanghai). Main copied "until 18:56" into a spawn brief; the real local time was 11:56 CET (`quota-reset "2026-10-25 18:56:22"` → in 0h 18m).
- Done means: every reset time in a message the Main model is about to read (tool results, task results, system notices, ledger DIED lines) carries its local time beside it, written by code: `reset at 2026-10-25 18:56:22 (= 2026-10-25 11:56:22 CET local)`. The zone comes from config (`quota.reset_tz`), never from code. A time that names its own zone or offset (`Z`, `UTC`, `GMT`, `+08:00`, `+0800`, a tz abbreviation the text carries) is converted from that zone and the config is ignored, so a provider that starts printing local or explicit times needs no change.

## Forbidden
- Never push, merge, tag or publish; commit on the plan's branch and report.
- No provider or harness names in src/core/ (AGENTS.md architecture rule); the match pattern and the zone live in config.
- The annotation is absolute only (no "in 2h 5m"): the same input text must always give the same output text, so rewriting history never breaks the prompt cache. Idempotent: a time already followed by "(= … local)" is left alone.
- Never touch the live setup (`~/.omp/agent`, `~/.local/bin`, `~/.local/state`, the user config dir); tests use a sandbox HOME.

## Blockers
- no-push
- blockers/reset-local-scope.sh
- deny-path /home/ukd/.omp/agent/** /home/ukd/.bun/** /home/ukd/.local/state/** /home/ukd/.local/bin/**
- deny-command --no-verify git\s+add\s+(-A|--all|\.)(\s|$) git\s+push\b git\s+merge\b git\s+tag\b npm\s+publish reset\s+--hard

## Phases
- [ ] P1 Core, pure. New src/core/reset-time.ts: `annotateResetTimes(text, rule: { pattern: string; zone: string }) → string`. Reuse the zone math of src/core/quota-reset.ts (export wallToEpoch/parseWhen/localStamp from there or move them into reset-time.ts and import back; one copy only). Config: `quota.reset_pattern` (default `reset at (\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?)\s*(Z|UTC|GMT|[+-]\d{2}:?\d{2}|[A-Z]{2,5}\b)?`, group 1 = wall clock, group 2 = optional explicit zone) next to `quota.reset_tz` in src/core/config.ts:164, templates/config.yml:167-169, docs/config.md:188-190; validated (pattern compiles, has group 1). An abbreviation that Intl cannot resolve is left unannotated (no guess). Fail-before tests in tests/reset-time.test.ts (red first: the module does not exist): the zai text "Your limit will reset at 2026-10-25 18:56:22" with zone Asia/Shanghai → "(= 2026-10-25 11:56:22 CET local)" under TZ=Europe/Berlin; same text with "+00:00" appended → converted from UTC, config ignored; already-annotated text unchanged; two times in one text both annotated; text without a match returned as the same string; a summer date gives CEST — difficulty: 3 — verify: `cd /home/ukd/Work/neurastream-reset-local && /home/ukd/Work/heavy-run.sh agent "reset p1" -- sh -c 'bun test tests/reset-time.test.ts tests/quota-reset.test.ts && bun run typecheck'`
- [ ] P2 Adapter. In src/adapters/omp/index.ts the `context` handler (:1130-1154) also annotates, for the Main session (isMain): map every text part of every message (string content or content[].text, any role) through annotateResetTimes; return `{ messages }` only when some text changed, else undefined. The chat-unlock scan keeps its own `cfg.guards.chat_unlock` condition (today it returns early at :1131 — restructure so the early return no longer skips the annotation). Fail-before test in a new tests/reset-time-omp.test.ts using the adapter harness pattern of tests/rate-limit-omp.test.ts (createOmpAdapter + sandbox HOME/queue env, :13-31): a context event holding a toolResult with the zai 429 text → returned message carries "(= … local)"; an unrelated context → undefined; a subagent ctx → undefined — difficulty: 3 — verify: `cd /home/ukd/Work/neurastream-reset-local && /home/ukd/Work/heavy-run.sh agent "reset p2" -- sh -c 'bun test tests/reset-time.test.ts tests/reset-time-omp.test.ts && bun run typecheck'`
- [ ] P3 Docs + full suite + smoke. README: one short section "Provider reset times" (what the annotation looks like, `quota.reset_tz`, explicit zone wins). CHANGELOG `## Unreleased` / `### Added`. Smoke: feed the real ledger line (`NsTracesBloatP3Glm … reset at 2026-10-25 18:56:22`) through annotateResetTimes with the template config and paste the output in Progress (expect 11:56:22 CET). Blocker clean. — difficulty: 1 — verify: `cd /home/ukd/Work/neurastream-reset-local && bash /home/ukd/projects/neurastream/docs/plans/blockers/reset-local-scope.sh </dev/null && /home/ukd/Work/heavy-run.sh agent "reset full" -- sh -c 'bun test && bun run typecheck'`
- [ ] P4 Main: review, merge, release by tag under the owner's unlock, install, `neurastream doctor` exit 0; live check: the next zai reset line Main reads shows the local time — difficulty: 1 — verify: `git -C /home/ukd/projects/neurastream merge-base --is-ancestor feat/reset-local-time origin/main`

Suite runs go through `/home/ukd/Work/heavy-run.sh agent "<label>" -- <cmd>`. Stop and report within ~80 calls.

Read /home/ukd/projects/opus-implementer-method.md first.

## Done check
`cd /home/ukd/Work/neurastream-reset-local && bash /home/ukd/projects/neurastream/docs/plans/blockers/reset-local-scope.sh </dev/null && bun run typecheck && git fetch -q origin && git merge-base --is-ancestor HEAD origin/main`

## Code read by Main
- `src/core/quota-reset.ts` (zoneOffsetMs, wallToEpoch, parseWhen, zoneAbbrev, localStamp, quotaReset :83-127)
- `src/core/config.ts` (quota type :164)
- `src/adapters/omp/index.ts` (context handler :1130-1154, chat-unlock early return :1131; tool_result handler :707-758)
- `templates/config.yml` (quota :167-169)
- `docs/config.md` (quota :188-190)
- `tests/rate-limit-omp.test.ts` (adapter harness :13-31)
- omp ContextEventResult `{ messages?: AgentMessage[] }` (pi-coding-agent src/extensibility/extensions/types.ts:1095; event messages are a deep copy, shared-events.ts:179-183)

## Progress
Status: open
- 2026-10-25 12:00 Main: plan written after the owner's "Yes, plan." Worktree created from origin/main 9e0cc28; blocker reset-local-scope.sh clean. The `context` hook was chosen because it is the one place every text reaches the model (tool results, task results, notices), so no single tool has to remember. Findings: none
