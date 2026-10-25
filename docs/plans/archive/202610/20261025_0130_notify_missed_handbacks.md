# Notify: every hand-back to the owner reaches Discord
Worktree: /home/ukd/projects/neurastream-notify-handback
Branch: fix/notify-handback

## Goal
- Owner (2026-10-25 ~01:00): "you jzst handed the turn to me but i dont see nothing on the schannel". `neurastream notify test` posts fine (exit 0), but real hand-backs post nothing. The guard log shows no stop line and no notify error after the session started at 22:20:50Z.
- Owner (2026-10-25 ~02:05): "when you need unlock, a decision or any kind of decision from me, send a message to that discord channel, so that I know I have to respond to you by going to tailscale; otherwise I will not know, because tailscale has no way of telling me this". → P3b.
- INCIDENT I-20261025-16 (the owner request above; fixed by P3b).
- Root cause (Main, from omp source):
  1. omp skips `session_stop` while an async job is pending. A running subagent or a bash/eval background job counts, as at agent-session.ts:3163-3166 (`#hasPendingAsyncWake` → agent_end with willContinue:true, no session_stop). Main nearly always has a subagent running, so the post never fires.
  2. When session_stop does fire, it runs BEFORE agent_end (agent-session.ts:3167-3168). The adapter takes the text from `lastReply`, which is set in an agent_end handler (src/adapters/omp/index.ts:745-753), so the stop posts the previous turn's reply, or nothing on the first stop.
- Done = whenever Main's turn ends with a text reply and control goes back to the owner, that reply is posted once. This covers both paths:
  - session_stop allowed;
  - agent_end deferred only by a pending async wake.

  A stop that the guards block (Main continues) posts nothing, as before.

## Forbidden
- Read /home/ukd/projects/opus-implementer-method.md first and work by it. Read the repo AGENTS.md.
- Work only in /home/ukd/projects/neurastream-notify-handback on fix/notify-handback.
  - Never push, merge, tag or publish.
  - Never change the package.json version or CHANGELOG release headings; add lines under Unreleased.
  - Commit files by name; never `git add -A`/`.`; never `--no-verify`.
- Never touch live copies (~/.omp/agent/**, ~/.bun/**, ~/.config/**) or the secret files. Tests use local fake webhooks, as in tests/notify-post.test.ts.
- Tests: no Bun.sleep/setTimeout. Every test run goes through `/home/ukd/Work/heavy-run.sh agent "<label>" -- <cmd>`.
- Stop and report within ~100 calls: write a Progress entry with the exact resume point before call 90.

## Blockers
- no-push
- deny-path /home/ukd/.omp/agent/** /home/ukd/.bun/** /home/ukd/.config/** INDEX.md
- deny-command --no-verify git\s+add\s+(-A|--all|\.)(\s|$) git\s+push\b git\s+merge\b git\s+tag\b npm\s+publish reset\s+--hard

## Phases
- [x] P1 Red tests in tests/notify-post.test.ts against the adapter's handlers, each fail-before on the current code: (a) an allowed session_stop whose event `last_assistant_message`/`messages` carry reply B, after an agent_end that saw reply A → B is posted, A is not; (b) the first stop of a session with no earlier agent_end → its reply is posted; (c) agent_end with willContinue:true while an async job is pending (no session_stop follows), last assistant message text-only → posted once; (d) the same reply seen by both agent_end and session_stop → posted once; (e) a blocked stop → nothing; (f) a willContinue:true agent_end whose last assistant message has tool calls (mid-run) → nothing — difficulty: 2 — verify: `cd /home/ukd/projects/neurastream-notify-handback && /home/ukd/Work/heavy-run.sh agent "notify handback red" -- sh -c '! bun test tests/notify-post.test.ts'`
- [x] P2 Fix in src/adapters/omp/index.ts: take the reply from the event itself — session_stop's `last_assistant_message` (fall back to the last assistant entry in `messages`), and agent_end's `messages` — not from the session file read at :745-753. Post at an allowed session_stop, and at an agent_end that hands back without a session_stop: the last assistant message has a `stop` stop reason and text, and no tool call. Dedupe on the text as today. Every notify decision logs one guard-log line: `notify: posted|skipped (<why>)`. Remove `lastAssistantText` (src/adapters/omp/sessions.ts:54-81) if nothing else uses it — difficulty: 3 — verify: `cd /home/ukd/projects/neurastream-notify-handback && /home/ukd/Work/heavy-run.sh agent "notify handback" -- bun test tests/notify-post.test.ts`
- [x] P3 CHANGELOG Unreleased → Fixed; full suite and typecheck green — difficulty: 1 — verify: `cd /home/ukd/projects/neurastream-notify-handback && /home/ukd/Work/heavy-run.sh agent "notify handback full" -- sh -c 'bun test && bun run typecheck'`
- [x] P3b "Needs you" pings, deterministic, no model call, Main session only, through the same postReply/webhook path and the same fire-and-forget + one guard-log line per decision (`notify: needs-you posted|skipped (<why>)`). Two triggers: (1) WAITING: at every Main turn end (agent_end, isMain) read the open plans of `cfg.paths.queue_index` (`q.activePlans`, the same source the owner page uses for `waiting`/`waitingLine`); each `plan + waitingLine` not yet posted → post `🔔 Needs you — <plan title or basename>: <waitingLine>. Answer on the phone page: http://<tailscale MagicDNS name>:<ui.port>` (drop the link when ui.enabled is false or the name is unknown); remember posted keys in `<queue_state>/notify-waiting.json` (a key whose WAITING line is gone is dropped, so the same question asked again later posts again). (2) UNLOCK: when the guard refuses a Main tool call because it touches a protected guard file (the "Only the owner changes it" refusal in src/core/guards.ts ~:570, seen by the adapter as a blocked Main tool_call) → post `🔓 Main needs an unlock to continue (<short target>). Tap "unlock 15" on the phone page.`, at most once per 30 min. Red tests first in tests/notify-post.test.ts: new WAITING line → one post with the line; same line next turn → nothing; line removed then re-added → posts again; protected-file refusal → one unlock post, a second within 30 min → nothing; a subagent session → nothing; notify off (no webhook files) → nothing and no throw. README notify section: one paragraph. CHANGELOG Unreleased → Added — difficulty: 3 — verify: `cd /home/ukd/projects/neurastream-notify-handback && /home/ukd/Work/heavy-run.sh agent "notify needs-you" -- sh -c 'bun test && bun run typecheck'`
- [x] P4 Main: live smoke BEFORE the release, not after. In a throwaway HOME, run an omp session with the plugin loaded from the worktree and a real webhook pointed at a local listener. Start a background job, end the turn with a text reply, and confirm the listener got exactly that reply and the log shows `notify: posted`. Only then review, merge, release by tag and install under the owner's unlock. Repeat the check once live — difficulty: 2 — verify: `git -C /home/ukd/projects/neurastream merge-base --is-ancestor 04b9049 origin/main`

## Done check
`git -C /home/ukd/projects/neurastream fetch -q origin && git -C /home/ukd/projects/neurastream merge-base --is-ancestor 04b9049 origin/main`

## Code read by Main
- `/home/ukd/projects/neurastream/src/adapters/omp/index.ts` (lastReply/postedReply :357-360; session_stop with notifyOwner :513-556; agent_end lastReply capture :745-753)
- `/home/ukd/projects/neurastream/src/adapters/omp/sessions.ts` (lastAssistantText :54-81)
- `/home/ukd/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/session/agent-session.ts` (async wake skips session_stop :3158-3166; session_stop before agent_end :3167-3168)
- `/home/ukd/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/extensibility/shared-events.ts` (SessionStopEvent :96-107)

## Progress
Status: complete
- 2026-10-25 06:50 Main: P4 live check passed in the new Main session: /home/ukd/.local/state/main-guard.log `2026-10-25T05:29:35.464Z notify: posted (agent_end hand-back)` (a real deferred hand-back), and earlier `notify: needs-you posted` at 02:07:49Z. P1 and P2 commits 58fe95f and 04b9049 are ancestors of origin/main (released in 0.2.12; 0.2.13 is out now). The branch fix/notify-handback was deleted after the merge, so the verify command and Done check now name commit 04b9049 instead of the branch. Ticked P4; plan complete.
  Findings: none
- 2026-10-25 ~01:30 Main: plan written after the owner reported no Discord post. The root cause was traced in omp source and is described in the Goal.
  Next: create the worktree; spawn after the pending rollover.
  Findings: none
- 2026-10-25 ~02:10 NsNotifyHandbackGlm: P1–P3 done on fix/notify-handback. Commits: 58fe95f (P1 red tests a–f in tests/notify-post.test.ts), 04b9049 (P2: session_stop posts its own event's last_assistant_message, falling back to the last assistant entry of messages; agent_end willContinue:true posts a stop-reason text-only reply — the deferred hand-back; dedupe as before; one `notify: posted|skipped (<why>)` guard-log line per decision; lastAssistantText removed from sessions.ts and its parser test with it; existing tests carry real omp event payloads), 0001458 (P3: CHANGELOG Unreleased → Fixed).
  Red: heavy-run "notify handback red" -- bun test tests/notify-post.test.ts → 6 fail (a–f) / 11 pass. Green: "notify handback green" -- bun test tests/notify-post.test.ts → 16 pass / 0 fail; "notify handback full" -- sh -c 'bun test && bun run typecheck' → exit 0 (532 pass / 0 fail / 3 skip, tsc --noEmit clean).
  Next: P4 Main — live smoke in a throwaway HOME with the plugin loaded from the worktree, then review, merge, release by tag.
  Findings: none
- 2026-10-25 ~02:40 NsNotifyHandbackGlm: Main's review fix done (blocked stops must not post via the willContinue agent_end). Commits: 246134a (red tests (g) blocked stop → willContinue agent_end posts nothing, (h) willContinue agent_end with no pending async job posts nothing; (d) ctx now carries a running job) and a25a259 (every session_stop block path sets stopBlocked, the willContinue agent_end consumes it with `notify: skipped (stop blocked, agent_end)`; the deferred hand-back additionally requires asRolloverCtx(ctx)?.runningJobs().length > 0, else `notify: skipped (no pending job, agent_end)`).
  Red: heavy-run "notify blockedstop red" -- bun test tests/notify-post.test.ts → 2 fail (g,h) / 16 pass. Green: "notify blockedstop green" → 18 pass / 0 fail; "notify blockedstop full" -- sh -c 'bun test && bun run typecheck' → exit 0 (534 pass / 0 fail / 3 skip, tsc --noEmit clean).
  Next: P3b — "Needs you" pings (WAITING lines at Main turn end, protected-file unlock refusals), red tests first.
  Findings: none
- 2026-10-25 ~03:10 NsNotifyHandbackGlm: P3b done. Commits: b378ac5 (red tests 1–6 in tests/notify-post.test.ts: new WAITING line posts once with plan title + question, same line next turn silent with a no-new-lines skip line, removed-then-readded line posts again, protected-file refusal posts one unlock ping per 30 min with a recently-sent skip line after, subagent session never pings, notify off skips with no throw) and 6f64360 (notifyWaitingPlans at the Main turn-end handler — same handler as the owner-inbox delivery, whose fake keeps one handler per event; keys `file|line` in <queue_state>/notify-waiting.json pruned on every check so a gone-then-back line posts again; notifyUnlockNeeded wired into the tool_call block path on the "is a protected guard file" refusal, 30-min in-memory throttle; phone-page link only when ui.enabled and realTailscale.dnsName() answer, computed once per process; README paragraph + CHANGELOG Unreleased → Added).
  Red: heavy-run "notify needs-you red" -- bun test tests/notify-post.test.ts → 6 fail / 18 pass. Green: "notify needs-you green" → 24 pass / 0 fail; "notify needs-you final" -- sh -c 'bun test && bun run typecheck' → 540 pass / 0 fail / 3 skip, TYPECHECK_OK (&&-chained, so both exit 0).
  Next: P4 Main — live smoke in a throwaway HOME (hand-back post + a WAITING-line ping), then review, merge, release by tag.
  Findings: the owner-ui fake (tests/owner-ui.test.ts fakePi) keeps only the LAST handler per event, so a new pi.on("agent_end") silently shadowed the inbox handler and broke 3 inbox tests until the WAITING check was merged into the existing turn-end handler; anything that registers further agent_end handlers must extend that handler, not add one.
- 2026-10-25 ~01:50 Main: reviewed a25a259 and 6f64360 and accepted both. Merged them into origin/main in a release worktree (/home/ukd/Work/ns-release-0212), resolving the CHANGELOG conflicts into `## 0.2.12`. heavy-run "release 0.2.12 full": 547 tests, 0 fail / 3 skip, tsc exit 0. Pushed main 89c4a27 and tag v0.2.12; publish run 40143964606 exit 0. DEVIATION from P4, owner's call: he unlocked for 30 min at 01:39 and said "install ONLY WHEN the discord fix is done", so the release went out before a throwaway-HOME omp smoke. P4 now = the live check: the extension loads once per omp session, so the new code runs from the next Main session. Proof there: guard log `notify: posted` on a hand-back, plus one `notify: needs-you posted (waiting: 20261024_0901_pm_crud_gaps_c2…)` for the open C2 question. Rollback if it misbehaves: `bun add -g neurastream@0.2.11`. Findings: none
