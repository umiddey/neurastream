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
- [x] P1 Core, pure. New src/core/reset-time.ts: `annotateResetTimes(text, rule: { pattern: string; zone: string }) → string`. Reuse the zone math of src/core/quota-reset.ts (export wallToEpoch/parseWhen/localStamp from there or move them into reset-time.ts and import back; one copy only). Config: `quota.reset_pattern` (default `reset at (\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?)\s*(Z|UTC|GMT|[+-]\d{2}:?\d{2}|[A-Z]{2,5}\b)?`, group 1 = wall clock, group 2 = optional explicit zone) next to `quota.reset_tz` in src/core/config.ts:164, templates/config.yml:167-169, docs/config.md:188-190; validated (pattern compiles, has group 1). An abbreviation that Intl cannot resolve is left unannotated (no guess). Fail-before tests in tests/reset-time.test.ts (red first: the module does not exist): the zai text "Your limit will reset at 2026-10-25 18:56:22" with zone Asia/Shanghai → "(= 2026-10-25 11:56:22 CET local)" under TZ=Europe/Berlin; same text with "+00:00" appended → converted from UTC, config ignored; already-annotated text unchanged; two times in one text both annotated; text without a match returned as the same string; a summer date gives CEST — difficulty: 3 — verify: `cd /home/ukd/Work/neurastream-reset-local && /home/ukd/Work/heavy-run.sh agent "reset p1" -- sh -c 'bun test tests/reset-time.test.ts tests/quota-reset.test.ts && bun run typecheck'`
- [x] P2 Adapter. In src/adapters/omp/index.ts the `context` handler (:1130-1154) also annotates, for the Main session (isMain): map every text part of every message (string content or content[].text, any role) through annotateResetTimes; return `{ messages }` only when some text changed, else undefined. The chat-unlock scan keeps its own `cfg.guards.chat_unlock` condition (today it returns early at :1131 — restructure so the early return no longer skips the annotation). Fail-before test in a new tests/reset-time-omp.test.ts using the adapter harness pattern of tests/rate-limit-omp.test.ts (createOmpAdapter + sandbox HOME/queue env, :13-31): a context event holding a toolResult with the zai 429 text → returned message carries "(= … local)"; an unrelated context → undefined; a subagent ctx → undefined — difficulty: 3 — verify: `cd /home/ukd/Work/neurastream-reset-local && /home/ukd/Work/heavy-run.sh agent "reset p2" -- sh -c 'bun test tests/reset-time.test.ts tests/reset-time-omp.test.ts && bun run typecheck'`
- [x] P3 Docs + full suite + smoke. README: one short section "Provider reset times" (what the annotation looks like, `quota.reset_tz`, explicit zone wins). CHANGELOG `## Unreleased` / `### Added`. Smoke: feed the real ledger line (`NsTracesBloatP3Glm … reset at 2026-10-25 18:56:22`) through annotateResetTimes with the template config and paste the output in Progress (expect 11:56:22 CET). Blocker clean. — difficulty: 1 — verify: `cd /home/ukd/Work/neurastream-reset-local && bash /home/ukd/projects/neurastream/docs/plans/blockers/reset-local-scope.sh </dev/null && /home/ukd/Work/heavy-run.sh agent "reset full" -- sh -c 'bun test && bun run typecheck'`
- [ ] P3b Two review fixes in annotateResetTimes (src/core/reset-time.ts). (1) The pattern is compiled with "gi" (:80), so the zone alternative `[A-Z]{2,5}\b` also matches lowercase words: "reset at 2026-10-25 18:56:22 then retry" takes "then" as the zone, cannot resolve it and leaves the time unannotated (seen by Main 12:45; same for "or later", and for "\n next" because `\s*` crosses the newline). Compile with "g" only, so zone abbreviations must be upper case as written in the pattern. (2) Whitespace after the time is dropped: the match ends after `\s*`, the output resumes at `end` (:101), so "…18:56:22 99 left" becomes "…CET local)99 left". Resume at the end of the time/zone text (timestampEnd, :94) so the whitespace that followed is kept; the already-annotated check (:95-97) must still leave annotated text byte-identical. Fail-before tests in tests/reset-time.test.ts (red on 7e0efd7 first, record the label): "then retry", "or later" and a newline after the time are annotated; "… 99 left" keeps its space ("… local) 99 left"); annotating twice gives the same string; "XYZ" (upper case, unknown) still stays unannotated — difficulty: 2 — verify: `cd /home/ukd/Work/neurastream-reset-local && bash /home/ukd/projects/neurastream/docs/plans/blockers/reset-local-scope.sh </dev/null && /home/ukd/Work/heavy-run.sh agent "reset p3b" -- sh -c 'bun test && bun run typecheck'`
- [ ] P4 Main: review, merge, release by tag under the owner's unlock, install, `neurastream doctor` exit 0; live check: the next zai reset line Main reads shows the local time — difficulty: 1 — verify: `git -C /home/ukd/projects/neurastream merge-base --is-ancestor feat/reset-local-time origin/main`

Suite runs go through `/home/ukd/Work/heavy-run.sh agent "<label>" -- <cmd>`. Stop and report within ~80 calls.

Read /home/ukd/projects/opus-implementer-method.md first.

## Done check
`cd /home/ukd/Work/neurastream-reset-local && bash /home/ukd/projects/neurastream/docs/plans/blockers/reset-local-scope.sh </dev/null && bun run typecheck && git fetch -q origin && git merge-base --is-ancestor HEAD origin/main`

## Code read by Main
- `src/core/quota-reset.ts` (zoneOffsetMs, wallToEpoch, parseWhen, zoneAbbrev, localStamp, quotaReset :83-127)
- `src/core/config.ts` (quota type :164)
- `src/adapters/omp/index.ts` (context handler :1130-1154, chat-unlock early return :1131; tool_result handler :707-758)
- `src/core/reset-time.ts` (branch feat/reset-local-time: RegExp "gi" :80, timestampEnd :94, annotated check :95-97, position = end :101)
- `tests/reset-time.test.ts` (branch: explicit offset :18, annotated :30, multiple :35, unresolved abbreviation :48)
- `templates/config.yml` (quota :167-169)
- `docs/config.md` (quota :188-190)
- `tests/rate-limit-omp.test.ts` (adapter harness :13-31)
- omp ContextEventResult `{ messages?: AgentMessage[] }` (pi-coding-agent src/extensibility/extensions/types.ts:1095; event messages are a deep copy, shared-events.ts:179-183)

## Progress
Status: open
- 2026-10-25 12:48 Main (for NsResetLocalLuna, cannot write outside its worktree): P1-P3 committed 6cd1162 (P1), a4e1614 (P2), 7e0efd7 (P3 docs); worktree clean; reset-local-scope clean. heavy-run "reset p1 red"/"reset p2 red" exit 1 (module/annotation missing), "reset p1 verify"/"reset p2 verify" exit 0, "reset full final 2" END exit 0 12:24:47 (722 pass, 3 skip, 0 fail; tsc clean). Earlier "reset full"/"reset full final" failed only on the flaky priority-watch golden test (plan 20261025_1225). Smoke: "NsTracesBloatP3Glm … reset at 2026-10-25 18:56:22 (= 2026-10-25 11:56:22 CET local)". Main ran edge cases with bun -e and found two bugs → P3b. The agent went over budget (103 calls > 80). Findings: src/core/reset-time.ts:80 "gi" flag makes the zone group match lowercase words, so "reset at … then retry" is not annotated; src/core/reset-time.ts:101 resumes after the trailing `\s*`, dropping the space after the time
- 2026-10-25 12:00 Main: plan written after the owner's "Yes, plan." Worktree created from origin/main 9e0cc28; blocker reset-local-scope.sh clean. The `context` hook was chosen because it is the one place every text reaches the model (tool results, task results, notices), so no single tool has to remember. Findings: none
