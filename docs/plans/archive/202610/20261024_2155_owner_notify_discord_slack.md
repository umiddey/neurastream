# neurastream posts Main's reply to Discord and/or Slack when Main yields
Worktree: /home/ukd/projects/neurastream-owner-notify
Branch: feat/owner-notify

## Goal
- Owner (2026-10-24): when Main stops and hands the turn back to the owner, neurastream itself posts Main's final reply text to a chat channel, so he can follow from his phone. Deterministic code in the extension: no MCP, no model call, no tokens, never forgotten.
- Both Discord and Slack ("some people might want to have slack as their alternative"): either, both, or none configured.
- The webhook URL is a secret (anyone holding it can post as the bot). config.yml holds only the path to a secret file:
  notify: { discord_webhook_file: "~/.config/neurastream/secrets/discord-webhook", slack_webhook_file: "~/.config/neurastream/secrets/slack-webhook" } (both default ""= off).
- No agent, Main included, can read the secret files or list their directory; no agent can change them or the neurastream config file without the owner's unlock.
- neurastream doctor reports a problem when a secret file is readable by group/others (mode & 077), when the config file holds a raw webhook URL (discord.com/api/webhooks, discordapp.com/api/webhooks, hooks.slack.com), or when a secret file sits in the same directory as config.yml; a warning when a configured file is missing.

## Forbidden
- Read /home/ukd/projects/opus-implementer-method.md first and work by it. Read the repo AGENTS.md.
- Work only in /home/ukd/projects/neurastream-owner-notify on feat/owner-notify. Never push, merge, tag or publish; never change the package.json version or CHANGELOG release headings (Main releases). Commit files by name; never `git add -A`/`.`; never `--no-verify`.
- Never touch live copies (~/.omp/agent/**, ~/.bun/**, ~/.config/neurastream/**) or the live queue index. Never send a request to a real Discord or Slack host: tests post to a local Bun.serve fake on 127.0.0.1.
- No new dependency; use fetch. A failed or slow post (5 s timeout) never throws into omp, never blocks or delays the stop decision, never retries in a loop; it writes one adapter log line.
- Never put a webhook URL, real or fake-looking-real, in templates/config.yml, README or docs; examples show the file path only.
- Tests assert behaviour (requests received by the fake, refusals, doctor problems), never wording or source text.
- Every phase is fail-before: write the test, run it red, record the red run, then change src.
- Every test run via `/home/ukd/Work/heavy-run.sh <agent> "<label>" -- <cmd>` with tool timeout 0. Green = `bun test` at the worktree root plus `bun run typecheck`.
- Call budget: stop and report within ~80 calls. Add ONE dated bullet under `## Progress` after the `Status:` line.

## Blockers
- no-push
- deny-path /home/ukd/.omp/agent/** /home/ukd/.bun/** /home/ukd/.config/neurastream/** INDEX.md
- deny-command --no-verify git\s+add\s+(-A|--all|\.)(\s|$) git\s+push\b git\s+merge\b git\s+tag\b npm\s+publish reset\s+--hard discord(app)?\.com/api/webhooks hooks\.slack\.com

## Phases
- [x] P1 Secret guard, red tests then fix. (a) Reads: any tool call whose touched paths (src/core/queue/lib.ts touchedPaths :327-359, which already sees read/grep paths, bash words and eval code text) hit a configured secret file, its directory, or a glob whose literal prefix is that directory or an ancestor of it (e.g. a bash cat of ~/.config/neurastream/secrets/*) is refused for main and subagents, and stays refused while the guard unlock is fresh (no agent ever needs the secret). Allowed: reading the neurastream config file itself, other files in ~/.config/neurastream. (b) Writes: the user config file (src/core/config.ts configFile :184-186) and every configured secret file join the protected paths (lib.ts protectedPaths :560-595; checkTool src/core/guards.ts :505-526), so changing them needs the owner's unlock like any guard file. Tests in tests/notify-guard.test.ts (temp HOME, config with both files set): read/grep/bash cat/eval read of each secret → refused, unlocked or not; bash ls of the secrets dir → refused; write to config.yml → refused locked, allowed unlocked; read of config.yml → allowed. Record the red run, then implement in src/core/guards.ts + lib.ts — difficulty: 3 — verify: `cd /home/ukd/projects/neurastream-owner-notify && /home/ukd/Work/heavy-run.sh agent "notify guard" -- bun test tests/notify-guard.test.ts`
- [x] P2 Config + doctor, red tests then fix. notify section in src/core/config.ts (Config interface :19-156, check()) and templates/config.yml (both "", off); docs/config.md. doctorReport (src/adapters/omp/doctor.ts :158-207) adds the Goal's problems/warning. Tests in tests/notify-doctor.test.ts with a temp HOME: mode 600 file → no problem; 644 → problem; raw Discord URL and raw Slack URL in config.yml → problem each; secret file next to config.yml → problem; missing file → warning only — difficulty: 2 — verify: `cd /home/ukd/projects/neurastream-owner-notify && /home/ukd/Work/heavy-run.sh agent "notify doctor" -- bun test tests/notify-doctor.test.ts`
- [x] P3 Posting, red tests then fix. Core src/core/notify.ts: postReply(text, cfg) reads each configured file at post time (trimmed URL; a non-https URL or empty file → log, no post), splits the text into chunks within each provider's limit (Discord JSON {content} ≤ 2000 chars, Slack JSON {text} ≤ 3000 chars) on line boundaries where possible, posts chunks in order, and returns per-provider results. Adapter src/adapters/omp/index.ts: remember the last assistant message's text from each terminal agent_end in the main session (willContinue not true; :602-625); in session_stop (:413-439) post it on every path that returns allow (no block), once per distinct text, never for subagent sessions and never while a relaunch is requested. A stop that is blocked posts nothing; the later allowed stop posts the final text. Optional notify.prefix (e.g. "Main:") prepended. CLI `neurastream notify test` (src/cli/dispatch.ts next to doctor :92) posts "neurastream notify test" to each configured provider and exits 1 if any failed. Tests in tests/notify-post.test.ts against two local fakes (one per provider): allowed stop → each fake gets the text once with the right JSON key; 4500-char text → 3 Discord chunks / 2 Slack chunks, in order, nothing lost; blocked stop → nothing; same text twice → posted once; subagent ctx → nothing; only Slack configured → only Slack gets it; fake returns 500 or hangs > 5 s → stop decision returned unchanged and in time, one log line; notify test command exit 0/1 — difficulty: 3 — verify: `cd /home/ukd/projects/neurastream-owner-notify && /home/ukd/Work/heavy-run.sh agent "notify post" -- bun test tests/notify-post.test.ts`
- [x] P4 README section "Notify the owner" (Discord: Server Settings → Integrations → Webhooks → copy URL; Slack: Incoming Webhooks app → copy URL; `umask 077; mkdir -p ~/.config/neurastream/secrets; printf '%s' '<url>' > ~/.config/neurastream/secrets/discord-webhook; chmod 600 ...`; then the notify section and `neurastream notify test`), CHANGELOG Unreleased → Added. Full suite + typecheck green — difficulty: 1 — verify: `cd /home/ukd/projects/neurastream-owner-notify && /home/ukd/Work/heavy-run.sh agent "notify full" -- sh -c 'bun test && bun run typecheck'`
- [x] P5 Main: review, merge, release by tag, install after the owner's guard unlock; the owner creates the Discord webhook file himself (the guard refuses Main) and sets the notify section; `neurastream notify test` exit 0, `neurastream doctor` exit 0, and the next Main reply appears in the channel — difficulty: 1 — verify: `neurastream doctor && neurastream notify test`

## Done check
`git -C /home/ukd/projects/neurastream merge-base --is-ancestor feat/owner-notify origin/main`

## Code read by Main
- `/home/ukd/projects/neurastream/src/adapters/omp/index.ts` (session_stop allow/block paths :413-439; onSizeCheck terminal agent_end :602-625; before_agent_start :286-304)
- `/home/ukd/projects/neurastream/src/core/queue/lib.ts` (touchedPaths :327-359; protectedPaths :560-595; protectedHit :606-609)
- `/home/ukd/projects/neurastream/src/core/guards.ts` (checkTool protected-write refusal :505-526)
- `/home/ukd/projects/neurastream/src/core/config.ts` (Config interface :19-156; configFile :184-186; loadConfig :344-361)
- `/home/ukd/projects/neurastream/templates/config.yml` (paths section :1-15)
- `/home/ukd/projects/neurastream/src/adapters/omp/doctor.ts` (doctorReport :158-207; formatDoctor :209-219)
- `/home/ukd/projects/neurastream/src/cli/dispatch.ts` (doctor dispatch :92)
- `/home/ukd/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/extensibility/extensions/types.ts` (InputEvent :887-892)

## Progress
Status: complete
- 2026-10-25 ~01:15 Main: P5 done. The owner created the Discord webhook file and set the notify section. `neurastream notify test` → "notify discord: posted (1 chunk)", exit 0; `neurastream doctor` → ok, installed 0.2.10 = registry. Shipped in 0.2.7. Findings: none
- 2026-10-24 ~23:15 Main: P1–P4 done (NsOwnerNotifyGlm). At the call cap plan-guard refused its final Progress edit, so Main records it. Original commits 14a2f0a/d8ca754/30c204e/506bf0a; heavy-run "notify full" exit 0 at 22:19 (452 pass / 3 skip / 0 fail, tsc clean). Main reviewed the guard and adapter diffs:
  - secret reads are refused for main and subs, unlock or not;
  - config.yml and the secret files are protected writes;
  - the post is fire-and-forget at both allowed session_stop paths, once per distinct text, and skipped when the launcher relaunch takes the handback.
  Rebased onto origin/main 49849f3 (chat unlock); the only conflict was CHANGELOG Unreleased/Added, resolved by keeping both entries. New hashes 9293998/5cac4f8/94390de/1d319f4. Agent findings carried here:
  - src/core/notify.ts:130 also accepts http loopback (needed by the local fakes; a real chat host is never loopback);
  - tests/notify-post.test.ts:399 needs async spawn for in-process fakes;
  - src/core/guards.ts:885 openQueue treats a MISSING index file as open work;
  - plan-guard refused the Progress-only edit at the cap (also hit by NsChatUnlockGlm). Main files these as incidents.
  Next: the full suite on the rebased branch, then merge + release 0.2.7 with chat unlock. Findings: none
- 2026-10-24 ~22:15 owner-notify implementer (glm): P1 done+verified — red `heavy-run agent "notify guard"` exit 1 (0 pass/6 fail, "unknown key notify"), green exit 0 (6 pass) after the secret read refusal in guards.ts checkTool, config.yml+secret files in the protected-write set (guards.ts protectedHit, lib.ts protectedPaths), and the notify section in config.ts + templates/config.yml; commit 14a2f0a. P2 done+verified — red exit 1 (1 pass/4 fail), green exit 0 (5 pass) after notifyFindings (mode/raw-URL/next-to-config problems, missing-file warning) in src/core/notify.ts wired into doctorReport, docs/config.md; commit d8ca754. P3 red recorded (exit 1, exports missing), src in: core postReply (read-at-post, https/loopback-only, line-boundary chunks 2000/3000, 5s timeout, ordered, results) + sessions.ts lastAssistantText + adapter lastReply from terminal agent_end, posted on both session_stop allow paths once per distinct text (never sub, never relaunch, never blocked) + CLI `neurastream notify test` exit 0/1; green run queued behind the heavy-run lock, then commit, then P4 full suite. README "Notify the owner" + CHANGELOG Unreleased/Added written. Findings: src/core/notify.ts postableUrl also accepts http://127.0.0.1|localhost|[::1] beside https — the plan's local-fake tests cannot post over https and loopback http can never reach a real chat host.
- 2026-10-24 ~21:55 Main: plan written on the owner's request ("yes ... also slack"). The posting point is session_stop allow, not agent_end alone: a blocked stop continues Main, so only the stop that really hands back to the owner posts. Next: worktree + spawn P1-P4. Findings: none

## Background
- Today Main posts to Discord by hand through the discord MCP: it costs tokens and is skipped when Main forgets.
- The neurastream config file under ~/.config/neurastream is not on the protected list today (protectedPaths lists the agent dir's config.yml only, lib.ts:570), so an agent could point notify at its own webhook; P1b closes that.
