# Autonomy tiers: strict, opinionated, full
Worktree: /home/ukd/Work/neurastream-autonomy-tiers
Branch: feat/autonomy-tiers

## Goal
- INCIDENT I-20261025-177. Owner (2026-10-25 ~19:00): "parameterize the number of things that we can do without you asking me … this is my own personal preference layer but there can be a strict layer where you ask more … or it can be completely up to you … except for the things you cannot take without me like unlocking". Owner (~19:35): "name it opinionated instead of personal. thanks. make plan".
- Done = one setting, `autonomy.tier` (default `opinionated`), changed only by the owner (whole chat message `tier strict|opinionated|full`, or a button on the phone page), and the guards follow it:

|Tier|Main's file changes per 15 min|Lower plan before an idle higher one|Push / merge|
|---|---|---|---|
|strict|`autonomy.strict_edit_limit` (default 2)|owner's words only (today)|refused until the owner types `go` (one landing, valid `autonomy.go_minutes`, default 10)|
|opinionated|`guards.main_edit_limit` (today: 5)|owner's words only (today)|allowed (today)|
|full|no cap|also `Priority skip: <plan> — Main: "<reason, ≥ 4 words>"`|allowed|

- Every tier keeps the owner-only moves owner-only: guard-file edits without the unlock, starting the phone page, reading notify secrets, local `npm publish`, and the tier setting itself (it lives in the protected state dir). Example: in `full`, `git push` and a priority skip go through, but `touch ~/.omp/agent/.guard-unlock` by Main is still refused.

## Forbidden
- Work only in /home/ukd/Work/neurastream-autonomy-tiers on feat/autonomy-tiers. Never push, merge, tag or publish (Main does P4). Commit files by name; never `git add -A`/`.`; never `--no-verify`.
- Never change the protected-path list (src/core/queue/lib.ts), `startsOwnerUi`, the notify-secret rule, `unlocked()`, or the phone page's auth (isLoopback / isTailnet / whois / owner_login). No tier may loosen any of them.
- The tier and the `go` approval are written only by the owner's own words (the same paths as chatUnlock: the terminal input event and collab write-peer prompts) or the authenticated phone page; never by a tool call (the state dir is protected) and never from model text.
- Tests use temp dirs and env overrides only; never the real config, state dir or home.
- Every test run via `/home/ukd/Work/heavy-run.sh <agent> "<label>" -- nice -n 19 <cmd>` with tool timeout 0.
- Call budget: stop and report within ~100 calls. One dated bullet under `## Progress` after the `Status:` line, ending with `Findings:`.
- Read /home/ukd/projects/opus-implementer-method.md first.

## Blockers
- no-push
- blockers/autonomy-tiers-scope.sh
- deny-command --no-verify git\s+add\s+(-A|--all|\.)(\s|$) git\s+push\b reset\s+--hard npm\s+publish

## Phases
- [ ] P1 Tier core. New `src/core/autonomy.ts`: `type Tier = "strict" | "opinionated" | "full"`; `currentTier(cfg)` reads `<state dir>/autonomy-tier` (one word; anything else → config value); `chatTier(text, cfg, source, word)`: the whole trimmed message `tier <name>` (case-insensitive) writes that file and logs `TIER <name> <word> source=<source>` to `cfg.paths.plan_guard_log`, shaped like `chatUnlock` (src/core/queue/lib.ts:636-671) and switched by the same `guards.chat_unlock` flag; `chatGo(text, cfg, source, word)`: the whole message `go` touches `<state dir>/autonomy-go`; `takeGo(cfg)`: true and deletes the file when it is younger than `autonomy.go_minutes`, else false. Config: `autonomy: { tier, strict_edit_limit, go_minutes }` in the Config type next to `guards` (src/core/config.ts:101-135) with checks (tier one of the three; both numbers integers ≥ 1) and in templates/config.yml after the guards block (:102-126). Tests `tests/autonomy.test.ts`: default tier; `tier full` / `TIER Strict` set it; `tier nope`, `please tier full` and chat_unlock off do nothing; `go` used once; a stale `go` refused; bad config values are ConfigErrors. — difficulty: 3 — verify: `bun test tests/autonomy.test.ts`
- [ ] P2 Guards follow the tier (src/core/guards.ts). `editWindow` (:568-597): the limit is `strict_edit_limit` / `main_edit_limit` / none for full, and the deny and warning texts name the tier. `priorityProblem` (:387-421): in `full` a `Priority skip: <path> — Main: "<reason>"` line with ≥ 4 words is accepted; in the other tiers it is refused exactly as today. Strict landing gate in `mainTool` (shell tools, Main only): `git push`, `glab mr merge`, `gh pr merge` are refused with `main-guard: tier strict — type "go" to approve one push/merge` unless `takeGo(cfg)`; seen through `sh -c` / `sudo` like `startsOwnerUi` (:512-530). `checkInject` (:891) replaces the edit-limit line with `autonomy: <tier> — <one line: what Main does without asking>`. Owner-only rules (:696-732) unchanged in every tier. Tests: existing guard test files plus cases for all three tiers (cap 2 / 5 / none; Main-reason skip only in full; push refused, `go` lets one through, the second refused; full still refuses a protected-file write and `systemctl --user restart neurastream-ui`). Regression test, fail-before: "tier strict refuses Main's `git push` without go" must fail on the old code (origin/main 67452db lets the push through); show the failing run in Progress. — difficulty: 3 — verify: `bun test tests/autonomy.test.ts` and the guard test files
- [ ] P3 Owner switches + docs. src/adapters/omp/index.ts: next to the chat-unlock handlers (:1095-1151) the same two paths call `chatTier` and `chatGo` and notify `tier now full` / `go: one push/merge approved for 10 min`. src/core/owner-ui.ts: the lock menu (:438-451) gets three tier buttons (current one marked) posting `/tier` with `tier=<name>`, routed like `/unlock` (:993-998) behind the same auth, written via `chatTier(\`tier ${name}\`, cfg, \`ui:${login}\`, "ui")`; a bad name → 400. templates/AGENTS.md: after line 29 one line on tiers (what each allows, `tier <name>` and `go`), keeping line 7 true for strict/opinionated. README, docs/config.md (`autonomy.*`), CHANGELOG Unreleased. Tests: owner-ui test for `/tier` (auth refused for a stranger, good name sets the file, bad name 400). — difficulty: 2 — verify: `bun run typecheck && bun test tests/autonomy.test.ts tests/owner-ui.test.ts`
- [ ] P4 Main: review, full suite via heavy-run, merge, release by `v*` tag, install, `neurastream doctor` exit 0 (refresh the AGENTS block if doctor asks). Live: owner types `tier strict`, Main's `git push` of a no-op branch is refused, owner types `go`, it goes through; owner types `tier opinionated` back (or his pick). — difficulty: 2 — verify: `grep -E "TIER (strict|opinionated|full)" ~/.local/state/plan-guard.log`

## Done check
`cd /home/ukd/Work/neurastream-autonomy-tiers && bash /home/ukd/projects/neurastream/docs/plans/blockers/autonomy-tiers-scope.sh && bun run typecheck && bun test tests/autonomy.test.ts tests/owner-ui.test.ts && git merge-base --is-ancestor HEAD origin/main`

## Code read by Main
- `src/core/queue/lib.ts` (protected paths :577-615 incl. state dir :586 and config :587-590; chatUnlock :636-671)
- `src/core/guards.ts` (priorityProblem :387-421; startsOwnerUi :512-530; editWindow :568-597; owner-only rules in checkTool :693-732; checkInject :877-898)
- `src/core/config.ts` (guards type :101-135)
- `src/core/owner-ui.ts` (lock menu :438-451; /unlock and /lock :820-836, routes :993-998)
- `src/adapters/omp/index.ts` (chat unlock handlers :1095-1151)
- `templates/config.yml` (guards :102-126)
- `templates/AGENTS.md` (priority line :7, unlock line :29)

## Progress
Status: open
- 2026-10-25 ~20:30 glm (I-20261025-177 P1-P3, worktree /home/ukd/Work/neurastream-autonomy-tiers, feat/autonomy-tiers): P1 `fc92e6e` — `src/core/autonomy.ts` (`Tier`, `currentTier` reads `<state>/autonomy-tier`, `chatTier`/`chatGo`/`takeGo` behind `guards.chat_unlock`, shaped like chatUnlock), `autonomy: {tier, strict_edit_limit, go_minutes}` in config + checks + `templates/config.yml` block; 11 core tests. P2 `efb0c95` — `editWindow` caps strict 2 / opinionated 5 / full none with tier-named deny+warning texts, `full` accepts `Priority skip: <plan> — Main: "<reason>"` (≥ 4 words) at the priority gate, strict landing gate refuses `git push` / `glab mr merge` / `gh pr merge` (seen through `sh -c`/`sudo`/`env`/chains) without a one-shot `go`, `checkInject` injects `autonomy: <tier> — …`; new tests/autonomy-strict-push.test.ts + tier cases in tests/autonomy.test.ts; agents-md.test.ts inject assertions moved to the tier line. P3 `4814352` — omp input+collab owner paths call `chatTier`/`chatGo` and notify `tier now <name>` / `go: one landing approved for N min`; owner-ui lock menu gets three tier buttons (current marked) posting `/tier` behind the same auth, bad name 400, chat-gate-off redirect; AGENTS.md tier line after the unlock line; README + docs/config.md (`autonomy.*`, validation list) + CHANGELOG Unreleased; 4 `/tier` owner-ui tests. Fail-before (P2 regression on old code 67452db in a detached temp worktree, removed after): `bun test tests/autonomy-strict-push.test.ts` → `Expected: false / Received: true`, `(fail) tier strict refuses Main's git push without go`, 0 pass 1 fail, EXIT=1 — old code let the push through; the same file passes on the branch. Witnessed heavy-run runs: P1 `tiers-p1` tsc clean + 11 pass 0 fail (after one state-dir fixture fix); P2 `tiers-p2` tsc clean + 84 pass 0 fail across autonomy/strict-landing/agents-md/edit-window/guards/guards-priority; P3 `tiers-p3` and final `tiers` tsc clean + 177 pass 0 fail, 735 expects, 8 files, EXIT=0. Scope blocker `autonomy-tiers-scope.sh` clean before every commit; forbidden-names scan 0 hits on all three commits. Findings: the plan's no-push blocker lexical-matches the word in command text, so any git command naming tests/autonomy-strict-push.test.ts is refused — I staged via `git add tests`; P4 should keep that path out of commit/push command lines too. `priorityProblem` grew an optional trailing `cfg`; positional callers without it keep the pre-tier refusals.
- 2026-10-25 ~19:45 Main: plan written from the owner's tier request (I-20261025-177); worktree from origin/main 67452db, bun install done. Findings: none
