# Owner page: tapping unlock/lock tells Main at once
Worktree: /home/ukd/projects/neurastream-ui-unlock-notice
Branch: fix/ui-unlock-notice

## Goal
- Owner (2026-10-25 ~01:10), after tapping "unlock 5" on the phone page and Main not reacting: "shouldnt you have gotten the trigger when i clicked the unlock 5? otherwise if i have to write here to inform it beats the purpose no??"
- Today handleUnlock/handleLock (src/core/owner-ui.ts:257-269) only move the unlock file; only answers are appended to the owner inbox (:253), and ownerInboxMessage (src/adapters/omp/index.ts:294-301) drops every record that is not an answer. So Main never hears about a page unlock.
- INCIDENT I-20261025-10 (owner correction, the message above).
- Done = an applied unlock or lock from the page reaches Main as a user message through the same inbox path as answers (delivered once, at turn end or on the 15 s idle poll), e.g. `Owner unlocked the guards from the phone page for 5 min (until 01:12). Do the step that waited on the unlock now.` / `Owner locked the guards from the phone page.` A refused unlock (chat_unlock off) adds nothing. ownerInboxMessage also knows `kind:"reorder"` (`{ts, kind:"reorder", plan, from, to, login}`, written later by the redesign plan's drag-and-drop) → `Owner moved <plan basename> from #<from> to #<to> on the phone page; INDEX.md has the new order — work by it.`

## Forbidden
- Read /home/ukd/projects/opus-implementer-method.md first and work by it. Read the repo AGENTS.md.
- Work only in /home/ukd/projects/neurastream-ui-unlock-notice on fix/ui-unlock-notice.
  - Never push, merge, tag or publish.
  - Never change the package.json version or CHANGELOG release headings; add lines under Unreleased.
  - Commit files by name; never `git add -A`/`.`; never `--no-verify`.
- Never touch the live setup (~/.omp/agent, ~/.bun, ~/.local/state) or the owner's secret/config files; never run `neurastream ui` or `systemctl --user`. Tests use a sandbox HOME, as tests/owner-ui.test.ts does.
- Change only the unlock/lock handlers, the inbox record shape and ownerInboxMessage; leave answer delivery, auth and the page HTML as they are (a redesign plan owns the HTML).
- Tests: no Bun.sleep/setTimeout. Every test run goes through `/home/ukd/Work/heavy-run.sh agent "<label>" -- <cmd>`.
- Stop and report within ~60 calls: write a Progress entry with the exact resume point before call 50.

## Blockers
- no-push
- deny-path /home/ukd/.omp/agent/** /home/ukd/.bun/** /home/ukd/.local/state/** INDEX.md src/core/guards.ts src/core/tailscale.ts
- deny-command --no-verify git\s+add\s+(-A|--all|\.)(\s|$) git\s+push\b git\s+merge\b git\s+tag\b npm\s+publish reset\s+--hard systemctl\s+--user neurastream\s+ui\b

## Phases
- [x] P1 Red tests, fail-before on current code: (a) POST /unlock minutes=5 with chat_unlock on → the inbox gets one record `{ts, kind:"unlock", minutes:5, until:<epoch s>, login}`; (b) POST /lock → one `{ts, kind:"lock", login}`; (c) chat_unlock off → 409 and the inbox is unchanged; (d) ownerInboxMessage turns (a) into a message naming the minutes, the local HH:MM end time and "from the phone page", and (b) into the lock message; an answer record still gives today's text; a record with an unknown kind → null; (e) deliverOwnerInbox with an answer row then an unlock row sends two user messages in order and moves the cursor by 2. Record the red run — difficulty: 2 — verify: `cd /home/ukd/projects/neurastream-ui-unlock-notice && /home/ukd/Work/heavy-run.sh agent "unlock notice red" -- bun test tests/owner-ui.test.ts; test $? -ne 0`
- [x] P2 Fix: handleUnlock/handleLock append the record after an applied result (reuse the minutes/until that chatUnlock applied, from its result; extend ChatUnlockResult in src/core/queue/lib.ts:637 if it lacks them); ownerInboxMessage switches on `kind` (missing kind = answer) and handles `reorder` as in the Goal, with a test (reorder record → that text; missing from/to → null). CHANGELOG Unreleased → Fixed. Full suite and typecheck green — difficulty: 2 — verify: `cd /home/ukd/projects/neurastream-ui-unlock-notice && /home/ukd/Work/heavy-run.sh agent "unlock notice full" -- sh -c 'bun test && bun run typecheck'`
- [x] P3 Main: review, merge, release by tag, install under the owner's unlock, doctor exit 0; live: the owner taps "unlock 5" and Main gets the message without the owner typing anything (adapter log `owner inbox: delivered 1`) — difficulty: 1 — verify: `git -C /home/ukd/projects/neurastream merge-base --is-ancestor 53e8c1a origin/main`

## Done check
`git -C /home/ukd/projects/neurastream fetch -q origin && git -C /home/ukd/projects/neurastream merge-base --is-ancestor 53e8c1a origin/main`

## Code read by Main
- `/home/ukd/projects/neurastream/src/core/owner-ui.ts` (inboxPath :53-56; handleAnswer appends the inbox :243-255; handleUnlock/handleLock :257-269 append nothing)
- `/home/ukd/projects/neurastream/src/adapters/omp/index.ts` (inbox delivery notes :263-268; ownerInboxMessage answers only :294-301; pendingInboxRecords :306-321; deliverOwnerInbox :325-344; 15 s poll :374-379)
- `/home/ukd/projects/neurastream/src/core/queue/lib.ts` (chatUnlock :629-641, refuses when guards.chat_unlock is off)

## Progress
Status: complete
- 2026-10-25 09:27 Main: P3 live proof. The owner tapped unlock on the phone page; the adapter logged `owner inbox: delivered 1 answer(s) (cursor 4 → 5)` at 2026-10-25T08:08:23Z and Main received "Owner unlocked the guards from the phone page for 15 min (until 09:23). Do the step that waited on the unlock now." with no typing from the owner. Main used the window to release 0.2.15. Findings: the delivery log line says "answer(s)" for an unlock record too (src/adapters/omp/index.ts deliverOwnerInbox log text), cosmetic
- 2026-10-25 09:55 Main: the fix is on main and installed (53e8c1a, in every release since 0.2.11); branch fix/ui-unlock-notice was deleted after the fast-forward, so the done check and P3 verify now name commit 53e8c1a. Live evidence so far: the owner tapped unlock 15 at 2026-10-25T07:39:17Z (plan-guard log) and the adapter logged only `delivered 1 answer(s)` at 07:39:26Z, no unlock record. Cause [INFERENCE]: the page process still runs the code from before 0.2.11, since only the owner may restart it. Findings: none
- 2026-10-25 01:55 Main: reviewed composer's d4b34fc (tests assert the plan's (a)–(e) shapes) and its uncommitted handler + `until` diff (until = backdated mtime + unlock_minutes = real window end). Finished P2 myself: ownerInboxMessage kind switch (answer/unlock/lock/reorder, unknown → null). Red re-proved on d4b34fc in a temp worktree: heavy-run "unlock notice red" → 36 pass / 4 fail, all assertions. Green: heavy-run "unlock notice full" → 531 pass / 3 skip / 0 fail; `bun run typecheck` clean (after `bun install --frozen-lockfile`; the worktree had no node_modules, so tsc was missing). Commits 53e8c1a (fix), 1f4dd37 (release 0.2.11), fast-forwarded to main, pushed, tag v0.2.11 pushed. P3 left: install under the owner's unlock; owner restarts neurastream-ui at the PC (the running page holds the old code); then one page tap → `owner inbox: delivered` line. Findings: none
- 2026-10-25 ~23:20 NsUnlockNoticeComposer: P1 done. Red run: `/home/ukd/Work/heavy-run.sh agent "unlock notice red" -- bun test tests/owner-ui.test.ts` → exit 1, 36 pass / 4 fail (inbox unlock/lock append, ownerInboxMessage unlock/reorder, deliverOwnerInbox answer+unlock) — assertion failures, not compile. Commit `d4b34fc` (tests/owner-ui.test.ts). P2 partial before call budget: committed handlers in owner-ui.ts + `until` on ChatUnlockResult/chatUnlock (lib.ts); **not applied**: ownerInboxMessage kind switch (index.ts still answers-only), CHANGELOG Unreleased, green full suite, P2 commits. Resume: finish ownerInboxMessage + CHANGELOG, run heavy-run full suite, commit src/core/owner-ui.ts src/core/queue/lib.ts src/adapters/omp/index.ts CHANGELOG.md by file name, append Progress with green hashes. Findings: plan-guard blocked edits at 60/60 calls with ownerInboxMessage/CHANGELOG still open.
- 2026-10-25 01:27 Main: NsUnlockNoticeSol died at start: "Error: No model selected" (sol agent has no working model on this machine). No work done. Respawning on composer. Findings: none
- 2026-10-25 01:25 Main: NsUnlockNoticeDs (deepseek) died at start: OpenRouter "403 Key limit exceeded ($0.51 of $0.50 used; does not reset)" — no work done, worktree untouched. zai slots full (NsNotifyHandbackGlm, NsTracesClaimsGlm), grok out of credits, gemini no quota until 10-31. Respawning P1+P2 on sol. Findings: none
- 2026-10-25 ~03:15 Main: plan written after the owner's report. Evidence: plan-guard log `2026-10-24T23:07:29Z UNLOCK ui source=ui:umiddey@gmail.com minutes=5`, no inbox delivery line after it; Main learnt of the unlock only from the owner's chat message. Findings: none
