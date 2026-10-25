# neurastream: ship the orchestrator rules as a managed AGENTS.md block; inject the edit limit from config
Worktree: /home/ukd/Work/neurastream-agents-md
Branch: feat/agents-md-block

## Goal
- Owner (2026-10-23 ~15:30), INCIDENT I-20261023-16: "It has to remove the personal bits … like the user wants to be a better person. No, that's shit." Then: "there is really nothing to read in the index MD because index MD is injected … things that are injected automatically you can remove … the local CI thingy that is my personal preference. I don't think it should be there … only the rules that are really necessary for neurastream … the five edits per 15 minutes … isn't that configurable … it should be injecting … At the end of the day I don't want the configuration saying something that [AGENTS.md] is not."
- When done, these hold:
  - (a) `templates/AGENTS.md` holds ONLY the neurastream rules (text in Background, verbatim). No owner-personal lines: no tone/personality line, no local-CI pipeline rule, no "script changes go to neurastream" section, no provider names (GLM/Grok), no PM/CP/Gateforge names, no `/home/ukd`, no edit-limit numbers.
  - (b) Core (no harness names in `src/core/`, repo AGENTS.md rule): new `src/core/agents-md.ts` with pure functions `renderBlock(cfg): string` (template text with `{{AGENT_DIR}}` replaced by `cfg.paths.agent_dir`, wrapped in the marker lines `<!-- neurastream:begin (managed by neurastream; edit the package, not this block) -->` and `<!-- neurastream:end -->`) and `upsertBlock(fileText: string, block: string): string` (replace the text between the two markers, markers included; when no markers exist, append `\n` + block at the end; keep every byte outside the markers unchanged; two begin markers or a begin without an end → throw).
  - (c) omp adapter install (`installOmp` in `src/adapters/omp/install.ts`, config via `loadConfig({ home })`): writes `upsertBlock(existing or "", renderBlock(cfg))` to `join(home, ".omp/agent/AGENTS.md")` (same home-rooted style as the other adapter live files). Creates the file if missing. Never touches text outside the markers.
  - (d) `neurastream doctor` (omp, `src/adapters/omp/doctor.ts`): reports `stale: <path>/AGENTS.md neurastream block` when the block in the live file differs from `renderBlock(cfg)`, and `missing: <path>/AGENTS.md neurastream block` when there are no markers. Text outside the markers is never compared. Also: a package bin that is absent from `~/.local/bin` is reported as `missing: <path>`, not `foreign: <path>` (today doctor printed `foreign: ~/.local/bin/queue-trim` for a bin that did not exist).
  - (e) Edit limit injected, from config: `checkInject` (src/core/guards.ts:562) appends one line to the non-continuation inject: `main-guard: Main changes non-.md/.txt project files at most ${cfg.guards.main_edit_limit} times per ${cfg.guards.main_window_min}-minute window (config guards.main_edit_limit / guards.main_window_min); plans and delegation do the rest.` Continuation injects (text starting `main-guard:`) do not repeat it. No number for the limit appears in any template or doc except `templates/config.yml` defaults and `docs/config.md`.
  - (f) README: a short "AGENTS.md block" section (what is managed, what stays yours, how doctor reports drift). `docs/inventory.md` line for `templates/AGENTS.md` updated to match. CHANGELOG Unreleased line.

## Forbidden
- Never push, tag, publish, link or install; never bump the version. Commit only on feat/agents-md-block, files added by name; never `git add -A`/`git add .`; never `--no-verify`.
- Touching the live setup (`~/.omp/agent`, `~/.local/bin`, `~/.local/state`, `~/.config`, `~/.bun/install/global`) or any repo other than this worktree. Never copy the live `~/.omp/agent/AGENTS.md` into a fixture; fixtures are invented text. Tests and smokes run under a sandbox `HOME=/tmp/neurastream-home-*` (repo AGENTS.md).
- Changing files outside `templates/AGENTS.md` (new), `src/core/agents-md.ts` (new), `src/core/guards.ts` (checkInject only), `src/adapters/omp/install.ts`, `src/adapters/omp/doctor.ts`, `tests/` (new `tests/agents-md.test.ts`; existing doctor/install/inject tests only where an expectation must change, one-line reason comment), `README.md`, `docs/inventory.md`, `CHANGELOG.md`, `package.json` `files` list only if `templates/` is not already shipped whole.
- Never weaken or delete an existing test to pass.
- Every `bun test`/typecheck run goes through `/home/ukd/Work/heavy-run.sh <agent> "<label>" -- <cmd>` with tool timeout 0, in the FOREGROUND. Probe one test file before the full suite.
- `find` is broken: use grep/glob/read. One failed tool call is never a blocker; try two other ways.
- Claim rule: report only what you ran and saw (label + exit code + log path).
- Call budget: stop and report within ~100 tool calls per run (warning at 90, hard stop at 100). Commit each green unit immediately. You may append entries under `## Progress` of this plan only.
- Read /home/ukd/projects/opus-implementer-method.md first and work by it. Read the repo AGENTS.md.
- The live plan-guard refuses any shell call whose text contains the word `queue-close` or `queue-cancel`, or names a path under `docs/plans/`. Never type those in a bash command; use the read/edit tools for the plan file.

## Blockers
- no-push
- deny-path /home/ukd/.omp/agent/** /home/ukd/.local/bin/** /home/ukd/.local/state/** /home/ukd/.config/** /home/ukd/.bun/install/global/** /home/ukd/.npmrc INDEX.md bun.lock
- deny-command npm\s+publish bun\s+publish npm\s+link bun\s+link git\s+tag --no-verify git\s+add\s+(-A|--all|\.)

## Phases
- [x] P1 (a)+(b). Create `templates/AGENTS.md` with the Background text verbatim. Tests first in `tests/agents-md.test.ts`: renderBlock puts the agent dir in and wraps markers; upsertBlock appends to a file with no markers and keeps the personal text byte-identical; replaces an old block in place (text above and below unchanged); is idempotent (second run = same bytes); throws on a begin without end and on two begin markers; template contains none of `better person`, `dumb`, `one combined merge request`, `GLM`, `Gateforge`, `/home/ukd`, `5 times`, `15-minute`. fail-before: run the test file red before writing agents-md.ts and record label + exit code in Progress, then implement. — difficulty: 3 — verify: `bun test tests/agents-md.test.ts`
- [x] P2 (c)+(d). Install writes the block; doctor reports `stale:`/`missing:` for the block and `missing:` (not `foreign:`) for an absent bin. Tests: sandbox HOME, install on a home with a personal AGENTS.md (no markers) → personal text kept + block appended; doctor clean for the block; edit inside the block → doctor `stale: … neurastream block`; edit outside → doctor still clean; delete a linked bin → `missing: …`. fail-before for the doctor `missing:` case (red on unchanged doctor.ts, record it). — difficulty: 3 — verify: `bun test tests/agents-md.test.ts`
- [x] P3 (e). checkInject line from config. Test: cfg with main_edit_limit 7 and main_window_min 20 → inject contains `at most 7 times per 20-minute window`; continuation inject (starts with `main-guard:`) does not. fail-before: red on unchanged guards.ts, record it. — difficulty: 2 — verify: `bun test tests/agents-md.test.ts`
- [x] P4 (f) + whole suite + typecheck green. — difficulty: 1 — verify: `bun run typecheck && bun test`
- [x] P5 (Main only) Review, PR, merge, release, owner unlock, `bun add -g neurastream@latest`. Before `neurastream adapter install omp`: Main edits the live `~/.omp/agent/AGENTS.md` to delete the lines the block now carries (keep the owner's personal lines: tone line, local-CI rule, "Script changes go to neurastream", provider/PM notes), then installs; `neurastream doctor` exit 0; show the owner the final live file. — difficulty: 1 — verify: `neurastream doctor`
<!-- difficulty: set by Main at plan time, before any result (agent-score reads it): 1 mechanical · 2 rules · 3 new spec · 4 root-cause · 5 product fix · 8 engine. Owner may override. -->

## Done check
`cd /home/ukd/Work/neurastream-agents-md && bun run typecheck && bun test && test -f templates/AGENTS.md && ! grep -qiE 'better person|one combined merge request|/home/ukd' templates/AGENTS.md`

## Code read by Main
- `src/core/guards.ts`
- `src/adapters/omp/doctor.ts`
- `src/adapters/omp/index.ts`
- `src/cli/init.ts`
- `src/adapters/omp/install.ts`

## Progress
Status: complete
- 2026-10-23 16:5x Main: owner unlocked (touch 16:37). Global 0.1.22 -> 0.1.23 (`bun add -g`, plugin copy refreshed via `bun add` in ~/.omp/plugins + adapter install re-record). Live AGENTS.md trimmed: old generic rules + full scripts table deleted, kept owner lines (tone, one-MR rule, "Script changes go to neurastream", pm-fail-facts, glm-reset) + plugins table + the managed block (47-75 style, written by install). `neurastream doctor` = ok, exit 0. P5 done; plan complete.
- 2026-10-23 16:0x Main: plan written for INCIDENT I-20261023-16 after the owner's review of the draft block (personal lines out, injected/enforced items out, edit limit injected from config).
- 2026-10-23 16:3x Main: reviewed d8b10b3..60cca03 (agents-md.ts, doctor/install, checkInject line); Done check run by Main exit 0 (typecheck clean, 315 pass). P1–P4 ticked. P5 next: merge, release 0.1.23.
- 2026-10-23 16:4x Main: PR #17 CI green, squash 09aa730 on main, tag v0.1.23, publish workflow success; NsAgentsMdHaiku P1–P4 scored. `bun add -g neurastream@0.1.23` and the live AGENTS.md trim refused by plan-guard (protected): waiting for owner `touch ~/.omp/agent/.guard-unlock`. Then: trim live file to owner lines, `neurastream adapter install omp`, `neurastream doctor`.
- 2026-10-23 NsAgentsMdHaiku: P1-P4 committed on feat/agents-md-block in /home/ukd/Work/neurastream-agents-md: `d8b10b3`+`1778d80` (P1), `1d4654c` (P2), `2c1fdb9` (P3), `60cca03` (P4). Red before green: P1 `bun test tests/agents-md.test.ts` exit 1 (`/tmp/nsam-p1-red.log`), P2 exit 1 9 pass/3 fail (`/tmp/nsam-p2-red.log`), P3 exit 1 1 fail of 14 (`/tmp/nsam-p3-red.log`). Green: P2 agents-md file 12 pass exit 0 (`/tmp/nsam-p2-green.log`); doctor+init 10 pass exit 0 (`/tmp/nsam-p2-existing.log`); P3 agents-md+incident+guards 50 pass exit 0 (`/tmp/nsam-p3-green.log`); P4 `bun run typecheck` exit 0 (`/tmp/nsam-p4-tc2.log`), `bun test` exit 0, 315 pass 0 fail (`/tmp/nsam-p4-test2.log`). First full run exit 1 on the harness-name scan (word "compared" in a core comment), fixed in `60cca03`. Done check template grep exit 0. Not done: P5 (Main). Phase boxes left for Main. Scope notes: doctor now reports an absent bin as `missing:` (was `foreign:`); `docs/visual/neurastream-deck.html` and `neurastream.eco.js` still say "5 ... 15 minutes" (outside allowed files); `src/core/guards.ts:13` header comment still says "5 project-file changes" (outside checkInject).

## Background
- Already injected every Main prompt by `checkInject` (so not in the block): the queue summary (main INDEX.md + repo INDEX.md plans), owner-cancel flag, open incidents. Already enforced by guards (so not in the block): allowed-subagent list, spawn-on-valid-plan, edit window, plan-guard Progress-only edits, stop guard, protected files. `queue-close` runs by itself (main-guard timer).
- Owner-personal, stay outside the block in his live file: the tone/"better person" line, "Pipelines on our local computer: one combined merge request at a time", "Script changes go to neurastream", `pm-fail-facts`, `glm-reset`.
- Block text for `templates/AGENTS.md` (verbatim, except: the two lines written `@@## …` here are `## …` in the template; the `@@` only keeps the plan parser from reading them as plan sections. `{{AGENT_DIR}}` is replaced at install):

```
# neurastream: orchestrator rules

You are Main, the orchestrator. Main plans, delegates, reviews and lands; implementers do the work.

@@## Plans
- When the owner asks for work in a repo, add the repo to `{{AGENT_DIR}}/INDEX.md` and the plan to the repo's INDEX.md.
- Entering a repo: read its AGENTS.md first.
- Main writes every plan in `<repo>/docs/plans/`, shaped like `{{AGENT_DIR}}/queue/TEMPLATE.md`. Do the research yourself; never base a plan on another agent's findings.
- Phase 0 of every plan: blocker scripts that stop the implementer from going against the plan. They must exist before any spawn.
- An open plan gets an implementer subagent. When it claims done, verify (another subagent or yourself). Not done → spawn another implementer for the rest. Done → set `Status: complete`; `queue-close` then archives it and cleans the indexes.
- Main may push and publish once the repo's AGENTS.md test rules are met.

@@## Scripts (run at the stated moment)
|Script|When|
|---|---|
|`main-start`|session start, after an abort, before every status report|
|`queue-check`|after changing a plan or an index, before every spawn; exit 1 = fix first|
|`agent-ledger --cap`|before every spawn|
|`agent-score`|`gate <agent>` before every spawn; `accept`/`diagnose`/`penalty` after reviewing a result; `check` after every merge; `board` after a score change|
|`brief-lint <plan.md>`|before every spawn on that plan|
|`wip-check`|session start, before new work|
|`neurastream metrics ci <repo> <mr>`|after every merge|
|`neurastream metrics report`|weekly when main-start says due; propose ONE rule change to the owner|
|`neurastream incident list --open`|session start, before status reports, when a spawn or stop is blocked|
|`machine-guard`, `heavy-run`|machine-guard at session start and before launches; every test run goes through heavy-run|

Guard files are locked for every agent; the owner unlocks with `touch {{AGENT_DIR}}/.guard-unlock` (30 min).
```
