# Rate-limit resume: only a real turn cancels the wake-up
Worktree: /home/ukd/Work/neurastream-rate-resume
Branch: fix/rate-resume-turn-start

## Goal
- Owner (2026-10-25 ~11:40), answering "Plan the wake-up fix now? (yes/no)": "yes".
- What happened (main-guard.log, Main session 2026-10-25T09-27-16-485Z_01a17262): Main was rate limited; resume armed for 11:35 CET (`RATE-LIMIT stop: resume at 11:35 (3615s, attempt 3)` at 09:35:37Z). At 09:51:12Z the log says `RATE-LIMIT resume cancelled: owner message`, but no user message reached the session (the session jsonl has none between 09:35:37Z and 10:29:41Z; the omp log shows a usage fetch at 10:51:00 CET, consistent with a slash command such as `/usage`). No turn started, so nothing re-armed; Main stayed idle until the owner wrote at 11:29.
- Cause: the cancel sits in the `input` handler (src/adapters/omp/index.ts:1088-1097). omp fires `input` for every submit before slash-command dispatch and before handled inputs return (pi-coding-agent src/modes/controllers/input-controller.ts:690-700; slash commands after it), so an input that never starts a turn still kills the timer.
- Done means: the pending resume is cancelled only when an agent run actually starts in the Main session (`before_agent_start`). A slash command, a handled input (chat "unlock 30" / "lock") or an empty submit leaves the timer armed and it fires on time. A real owner message still takes over (cancel logged once; the normal 429 handling re-arms if that turn is limited too).

## Forbidden
- Never push, merge, tag or publish; commit on the plan's branch and report.
- No change to src/core/ (rate-limit.ts stays pure and untouched); no change to wait, doubling, cap, slack or post rules.
- Never touch the live setup (`~/.omp/agent`, `~/.local/bin`, `~/.local/state`, the user config dir); tests use the sandbox HOME of tests/rate-limit-omp.test.ts.
- The resume's own `sendUserMessage` turn must not log a cancel (the timer is already null when it fires, index.ts:483-486); keep it that way.

## Blockers
- no-push
- blockers/rate-resume-scope.sh
- deny-path /home/ukd/.omp/agent/** /home/ukd/.bun/** /home/ukd/.local/state/** /home/ukd/.local/bin/** src/core/**
- deny-command --no-verify git\s+add\s+(-A|--all|\.)(\s|$) git\s+push\b git\s+merge\b git\s+tag\b npm\s+publish reset\s+--hard

## Phases
- [x] P1 Fix + fail-before tests. In src/adapters/omp/index.ts move the cancel from the `input` handler (:1088-1097, delete that handler) into the Main `before_agent_start` handler (:620-638): when `rateTimer !== null`, `clearRateTimer()` and log `RATE-LIMIT resume cancelled: owner message` (same text, so log readers keep working). Update the comments at :464-466 and :1088 and any chat-unlock comment that says the cancel handler is registered before it. Tests in tests/rate-limit-omp.test.ts, fail-before (run them red on the old code first and record the red heavy-run label): (a) after a 429 stop arms the resume, `emit("input", { text: "/usage", source: "interactive" })` with no `before_agent_start` → no cancel line and the resume fires (host.sent length 1); (b) a chat "unlock 5" input with no turn → same; (c) rewrite the test at :292-303 so the takeover is `emit("input")` then `emit("before_agent_start", { prompt: "taking over" })` → one cancel line, nothing sent; (d) the resume's own turn (`before_agent_start` after the timer fired) logs no cancel — difficulty: 3 — verify: `cd /home/ukd/Work/neurastream-rate-resume && /home/ukd/Work/heavy-run.sh agent "resume p1" -- sh -c 'bun test tests/rate-limit-omp.test.ts && bun run typecheck'`
- [x] P2 Docs + full suite. README.md:189: "Your own message before expiry takes over and cancels the resume" becomes: your own message takes over when it starts a turn; a slash command or a handled input (chat unlock) leaves the resume armed. CHANGELOG: new `## Unreleased` / `### Fixed` above 0.2.16 with one line (a slash command typed while Main waited out a rate limit cancelled the wake-up; seen 2026-10-25 10:51). — difficulty: 1 — verify: `cd /home/ukd/Work/neurastream-rate-resume && bash /home/ukd/projects/neurastream/docs/plans/blockers/rate-resume-scope.sh </dev/null && /home/ukd/Work/heavy-run.sh agent "resume full" -- sh -c 'bun test && bun run typecheck'`
- [x] P3 Main: review, merge, release by tag under the owner's unlock, install, `neurastream doctor` exit 0 — difficulty: 1 — verify: `git -C /home/ukd/projects/neurastream merge-base --is-ancestor fix/rate-resume-turn-start origin/main`

Suite runs go through `/home/ukd/Work/heavy-run.sh agent "<label>" -- <cmd>`. Stop and report within ~60 calls.

Read /home/ukd/projects/opus-implementer-method.md first.

## Done check
`cd /home/ukd/Work/neurastream-rate-resume && bash /home/ukd/projects/neurastream/docs/plans/blockers/rate-resume-scope.sh </dev/null && bun run typecheck && git fetch -q origin && git merge-base --is-ancestor HEAD origin/main`

## Code read by Main
- `src/adapters/omp/index.ts` (rate timer :464-501; rateLimitOf :503-504; before_agent_start :620-638; session_stop rate branch :776-783; input cancel handler :1088-1097)
- `src/core/rate-limit.ts` (rateLimitWait :42-63, unchanged)
- `tests/rate-limit-omp.test.ts` (resume test :255-270; doubling test :274-290; owner-input cancel test :292-303)
- `README.md` (Provider rate limits :179-191)
- `CHANGELOG.md` (head :1-5, no Unreleased section)
- `docs/plans/blockers/rate-limit-scope.sh` (template for the new blocker)

## Progress
Status: complete
- 2026-10-25 12:18 Main: P3 done. Merge be92d52 (CHANGELOG conflict resolved as 0.2.18). heavy-run "release 0.2.18 full" exit 0 12:05:01 (751 pass, 0 fail, tsc clean). Tag v0.2.18: the first publish run 40187396260 failed on the flaky golden test "priority-watch matches the original" (tests/golden/ports-p4.test.ts:624, a wall-clock minute "11:06" differed between the two runs); the rerun of the failed job succeeded. npm latest = 0.2.18; installed, `neurastream doctor: ok` exit 0. Findings: tests/golden/ports-p4.test.ts:624 priority-watch golden compares a wall-clock minute that can roll over between the original and the port run (flaky; failed CI publish once on 2026-10-25)
- 2026-10-25 12:05 Main (for NsRateResumeLuna): P1+P2 done, commit b5b709a on fix/rate-resume-turn-start. heavy-run: "resume p1 red" exit 1 (slash + unlock cases red on old code), "resume p1" END exit 0 at 11:55:28, "resume full" END exit 0 at 12:00:46 (718 pass, 0 fail). Main reviewed index.ts:621-626 (cancel in Main before_agent_start; input handler removed). Blocker rate-resume-scope clean. Merged into main for 0.2.18. Findings: none
- 2026-10-25 11:50 Main: plan written after the owner's "yes". Evidence: main-guard.log 09:35:37Z (armed 11:35) and 09:51:12Z (cancelled, no message in the session jsonl); omp log omp.2026-10-25.1106087.log usage fetch 10:51:00 CET. Worktree created from origin/main 9e0cc28; blocker rate-resume-scope.sh clean. Findings: none
