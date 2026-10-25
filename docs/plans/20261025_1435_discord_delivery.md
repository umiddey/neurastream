# Discord delivery: every reply the owner sees in chat reaches Discord, and bursts are not dropped by 429
Worktree: /home/ukd/Work/neurastream-discord-delivery
Branch: fix/discord-delivery
Read /home/ukd/projects/opus-implementer-method.md first.

## Goal
- Owner (2026-10-25 ~14:25): "again these messages are not coming to the discord channel … only select few coming in so I don't know what is happening here … did you not even send me an answer".
- Main read the guard log (/home/ukd/.local/state/main-guard.log, 2026-10-25 11:30–13:25 UTC). Two causes:
  1. A reply whose stop the guard blocks is never posted: `notify: skipped (stop blocked by guard)` at 12:49:31, 12:50:05, 13:01:29, 13:11:55. The owner saw those replies in chat (e.g. the plantrail "how it fits with neurastream" answer), but Discord never got them. Main's later turn posts only its own final text.
  2. Bursts are dropped: at 12:58:57 one turn end fired 13 needs-you posts plus the hand-back at the same moment, and 9 got `discord answered 429 on chunk 1/1`. Nothing retries.
- Done when:
  - a Main reply that the guard blocks still reaches Discord once, if it has text (deduplicated like today);
  - the needs-you pings of one turn end go out as ONE message, listing every new waiting plan;
  - every post goes through one serial queue, and a 429 waits for Discord's `retry_after` (capped at 10 s) and retries that chunk once, then logs a failure.

## Forbidden
- Work only in /home/ukd/Work/neurastream-discord-delivery on fix/discord-delivery. Never push, merge, tag or publish. Commit files by name; never `git add -A`/`.`; never `--no-verify`.
- Do not read, print or log webhook URLs or the secret files' contents. Tests use a loopback fake server (postableUrl already allows http://127.0.0.1).
- No new config keys. No change to which events count as a hand-back other than the blocked-stop post.
- Every test run via `/home/ukd/Work/heavy-run.sh <agent> "<label>" -- <cmd>` with tool timeout 0.
- Call budget: stop and report within ~80 calls. One dated bullet under `## Progress` after the `Status:` line, ending with `Findings:`.

## Blockers
- no-push
- blockers/discord-delivery-scope.sh
- deny-command --no-verify git\s+add\s+(-A|--all|\.)(\s|$) git\s+push\b git\s+merge\b git\s+tag\b npm\s+publish reset\s+--hard

## Phases
- [ ] P1 Serial posting with one 429 retry. In src/core/notify.ts (`postChunks` :159-177, `postReply` :182-197) every call to postReply joins one module-level promise chain, so posts never overlap and keep their order. A 429 reads `retry_after` (seconds, JSON body; else the `Retry-After` header; else 1 s), waits min(that, 10 s) and retries the same chunk once; a second failure returns the failed result as today. Tests with a loopback fake: (a) 3 postReply calls started together arrive in call order and never overlap; (b) a 429 with retry_after 0.2 then 200 → posted true, 2 requests; (c) two 429s → posted false, error names 429. — difficulty: 3 — verify: `cd /home/ukd/Work/neurastream-discord-delivery && /home/ukd/Work/heavy-run.sh agent "discord p1" -- bun test tests/notify.test.ts`
- [ ] P2 Batch needs-you and post blocked replies. In src/adapters/omp/index.ts: `notifyWaitingPlans` (:555-585) builds ONE text for all fresh plans (`🔔 Needs you (N):` then one line per plan: title + waiting line; the phone-page link once at the end) and makes one `needsYouPost` call, log `notify: needs-you posted (waiting: <n> plans)`. In `session_stop` (:766-822), both blocked paths (:797-800 rollover need-note, :819-821 guard block) call `notifyHandback(reply, "blocked session_stop")` before returning the block, so a reply the owner saw in chat is posted once; the existing `postedReply` dedupe stops a double post at agent_end (:1021-1056 skips on `stopBlocked`, keep that). Tests: a blocked stop with reply text posts once and a following agent_end posts nothing more; 3 fresh waiting plans → exactly 1 post containing all 3 titles. Docs: README notify paragraph + CHANGELOG `## Unreleased` → Fixed. Full suite and typecheck green. — difficulty: 3 — verify: `cd /home/ukd/Work/neurastream-discord-delivery && /home/ukd/Work/heavy-run.sh agent "discord full" -- bun test && bunx tsc --noEmit -p .`
- [ ] P3 Main: review, merge, release by tag, install, `neurastream doctor` exit 0; smoke: `neurastream notify "delivery smoke"` posts once, and the next blocked stop shows `notify: posted (blocked session_stop)` in the guard log. — difficulty: 1 — verify: `git -C /home/ukd/projects/neurastream merge-base --is-ancestor fix/discord-delivery origin/main`

## Done check
`git -C /home/ukd/projects/neurastream fetch -q origin && git -C /home/ukd/projects/neurastream merge-base --is-ancestor fix/discord-delivery origin/main`

## Code read by Main
- `/home/ukd/projects/neurastream/src/core/notify.ts` (limits :112-114; postableUrl :126-129; postChunks :159-177; postReply :182-197)
- `/home/ukd/projects/neurastream/src/adapters/omp/index.ts` (notifyHandback :510-524; needsYouPost :529-538; notifyWaitingPlans :555-585; session_stop :766-822; agent_end hand-back :1021-1056)

## Progress
Status: open
WAITING on owner: install 0.2.22 (`bun add -g` is guard-locked): run `bun add -g neurastream@0.2.22 && neurastream install`, or type `unlock 30` in chat
- 2026-10-25 14:35 Main: plan written from the guard-log evidence in the Goal. Findings: none
- 2026-10-25 NsDiscordDelivery: P1/P2 implemented; targeted notify tests 29/29 pass, full suite 817 pass/3 skip/0 fail and typecheck pass. Findings: none
- 2026-10-25 NsDiscordDelivery: Final targeted notify run 29/29 pass and `bun run typecheck` pass; later full-suite run was 812 pass/3 skip/5 fail, with four `EDQUOT` writes and one git ref-lock error in `tests/golden/ports-p4.test.ts`. Findings: environmental full-suite failures reported; earlier full run was green
