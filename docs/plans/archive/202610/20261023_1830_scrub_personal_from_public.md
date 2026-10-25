# Scrub personal machine data from the public package (release 0.1.24)

Status: complete
Priority: high
Difficulty: 3
Worktree: /home/ukd/Work/neurastream-scrub (branch `scrub/personal-defaults`, from origin/main 09aa730)
PRIORITY-ID: ns-scrub
INCIDENT I-20261023-18

## Goal

The npm package `neurastream` (public repo, getting public attention) ships this machine's personal layout: company/repo names, agent pin files with live session-transcript paths, a private backup remote, worktree roots. Owner 2026-10-23 18:2x: "make the plan and then ship it immediately, this is getting public attention".

Done means: the npm-shipped file set contains ZERO personal markers; `bun run typecheck && bun test` green; the owner's machine behavior is unchanged (his `~/.config/neurastream/config.yml` overrides every changed default, and his installed pins in `~/.omp/agent/agents` are untouched by a package update).

Personal markers (regex, case-insensitive) must not appear in any shipped file (src, bin, templates, blockers, README.md):
`ukd`, `umiddey`, `/home/`, `~/Work`, `Work/`, `gf-testbed`, `gateforge`, `Gateforge`, `pm-counts`, `aetherios`, `Aetherios`, `EstateMind`, `estatemind`, `contractor`, `clanky`, `oi-agent`, `sabuj`, `amiiir`, `100.70`, `umiddey/wip-backup`, `sessions/-` (live omp session paths), `gf-luna`, `pm/pr01`.

NOT personal (may stay): provider/model names (GLM, zai, haiku, deepseek, ...), the command names `glm-reset` / `pm-fail-facts` (do NOT rename bins), generic `~` paths, `~/work`. LICENSE copyright and package.json repository URLs stay (public npm identity, needed to publish).

## Forbidden

- Read /home/ukd/projects/opus-implementer-method.md first.
- Never push, publish, tag, or open MRs. Main lands the release.
- Never touch `~/.omp`, `~/.config/neurastream`, `~/.local`, `~/.bun` (live state).
- Never rename or remove bin commands (`glm-reset`, `pm-fail-facts`, ...). Text inside may be scrubbed.
- Never edit `docs/plans/**`, `INDEX.md`, `docs/inventory.md` beyond what P4 says, guard/plugin files, or `.gitignore`.
- No new dependencies; no reformatting of untouched code; no "while you're at it" refactors.
- `find` is broken: use grep/glob/read.

## Blockers

- no-push
- deny-path ~/.omp ~/.config ~/.local ~/.bun docs/plans/** INDEX.md .gitignore
- deny-command --no-verify git\s+add\s+(-A|--all|\.)(\s|$) git\s+push\b npm\s+publish\b bun\s+publish\b reset\s+--hard clean\s+-[a-z]*f rebase\b ssh\s
- blockers/no-personal-markers.sh

## Phases

- [x] P1 `templates/config.yml`: neutral defaults only. work_roots `["~/work"]` (comment: set your own roots); heavy_lock/owner/log/idle_state -> `~/.local/state/neurastream/heavy-run.{lock,owner,log,idle-state}`; wip backup_log/status_log -> `~/.local/state/neurastream/WIP-{BACKUP,STATUS}.md`; pm.backend_log -> `""` (feature stays, comment explains); free_prefixes -> `[]`; snapshot tmp_dest -> `~/.local/state/neurastream/tmp-snapshot`, git_repo/git_backup -> `""`; drop the `gf-luna` priority entry (default priority list empty); `score` section: default branch empty -> `--branch` required; no comment may name a real repo of the owner. verify: `! grep -qiE 'gf-testbed|gateforge|gf-luna|~/Work|pm-counts|/home/' templates/config.yml`
- [x] P2 `templates/agents` + `templates/notes` + `templates/help` + `templates/queue/TEMPLATE.md` + `templates/tmp-snapshot.sh`: DELETE all 18 personal pin files, add ONE neutral `templates/agents/example.md` documenting the pin format (name/description/model, contract, STOP rules; no session paths, no company names); `copyPins` in `src/adapters/omp/install.ts` only fills missing pins, so installed machines keep theirs. notes/subagents.md: `## Allowed` slugs -> a comment telling the user to list their own. help/wip-backup.txt: describe how `src` wip-backup really resolves the remote (check the code), name no remote; help/agent-score.txt: drop the default-branch/path wording; help/pm-fail-facts.txt: "PM Playwright run" -> "Playwright run"; help/wip-snapshot.txt: `~/Work/WIP-STATUS.md` -> the config path. queue/TEMPLATE.md: worktree line `{{HOME}}/Work/<repo>-<topic>` -> `{{HOME}}/work/<repo>-<topic>` under a configured work root. tmp-snapshot.sh: repo-specific backup-failed message -> neutral `repo backup failed` (same behavior). verify: `! grep -rqiE 'ukd|umiddey|/home/|~/Work|gf-testbed|gateforge|pm-counts|aetherios|estatemind|contractor|clanky|oi-agent|sessions/-|gf-luna|pm/pr01|100\.70' templates/agents templates/notes templates/help templates/queue templates/tmp-snapshot.sh`
- [x] P3 `src`: remove the repo-specific special case in `src/cli/init.ts` (lines ~62-64: existsSync/join of Work + a repo name, and the `default_repo` rewrite it does). `src/core/brief-lint.ts`: the repo-specific rules — the vitest/harness wording at lines 35-36, the repo-name trigger regex at line 54, the obligation-map rule at lines 55-60 — move to config-driven rules (e.g. `brief.repo_rules: [{match, require}]`, default `[]` in config.yml; loading follows the existing config pattern in `src/core/config.ts`). Generic brief-lint rules stay. No repo or company names left anywhere in src. verify: `! grep -rqiE 'pm-counts|aetherios|contractor|gf-testbed|gateforge|~/Work|Work/' src/ && bun run typecheck`
- [x] P4 README + docs: README (scrub its 1-2 hits; command list may keep bin names); `docs/config.md`: rewrite example values to the new neutral defaults, zero `/home/`, zero repo/company names; DELETE `docs/inventory.md` (finished migration audit, dense with personal paths); `docs/visual/neurastream-deck.html` + `docs/visual/neurastream.eco.js`: strip the `/home/ukd/...` header comments only. Repo-root `AGENTS.md` line that BANS `/home/ukd` may keep the literal (it is the rule, not a leak; AGENTS.md is not shipped). verify: `! grep -rqiE 'ukd|gf-testbed|pm-counts|gateforge' README.md docs/config.md docs/visual/ && test ! -e docs/inventory.md`
- [x] P5 Guard test: new `tests/no-personal-markers.test.ts` — computes the shipped file set from `package.json` `files` (src, bin, templates, blockers, README.md), then fails on the marker regex (Goal). Deterministic, no network, no `npm pack` call. fail-before: write this test FIRST and run it on the pristine worktree (09aa730) — it must FAIL there (config.yml + pins + help texts carry markers); record that output, then do P1-P4 and show it pass. Then the full suite green. verify: `bash docs/plans/blockers/no-personal-markers.sh && bun test tests/no-personal-markers.test.ts`

- [x] P6 `neurastream uninstall [--purge]` (owner 2026-10-23 ~17:1x: no uninstall exists; "rather than barbarian rm -rf"). New `src/core/uninstall.ts` pure core, inverse of install: remove bins (only symlinks/copies pointing into this package), the omp plugin copy, pins byte-identical to `templates/agents` (keep owner-edited ones), strip the managed block from AGENTS.md keeping all personal text (reuse the span logic in `src/core/agents-md.ts`). `--purge` additionally removes the config file + the agent_dir state init created (INDEX, queue, notes, blockers); prints the exact list first and requires `--yes`; refuses any path outside `$HOME`. CLI wiring in `src/cli/commands.ts` + `src/cli/dispatch.ts`, `templates/help/uninstall.txt`, one README line. verify: `bun test tests/uninstall.test.ts && bun run typecheck`
Call budget: stop and report within ~100 calls for P1-P5, ~140 with P6 (write your Progress bullet by call 90/130). Full suite runs go through `bash ~/.local/bin/heavy-run.sh bun test`; typecheck with `bun run typecheck`.

## Done check

```bash
cd /home/ukd/Work/neurastream-scrub && bash docs/plans/blockers/no-personal-markers.sh \
  && bun run typecheck && ~/.local/bin/heavy-run main scrub-done -- bun test \
  && npm pack --dry-run --json >/dev/null && echo SCRUB-DONE
```

## Applies to

- Shipped files (npm `files` set) + README + `docs/config.md` + `docs/visual/*` header comments.
- NOT git history (owner decision), NOT old npm versions (Main will `npm deprecate`), NOT `docs/plans/` (untracked already), NOT the owner's live config/pins (out of reach by blockers).

## Code read by Main

- `/home/ukd/projects/neurastream/package.json` (files set, bin map, version 0.1.23)
- `/home/ukd/projects/neurastream/templates/config.yml` (personal defaults, gf-luna)
- `/home/ukd/projects/neurastream/templates/agents/glm.md`, `templates/agents/sol.md` (runbook + session-path pins; hit counts on all 18)
- `/home/ukd/projects/neurastream/templates/notes/subagents.md`, `templates/notes/lessons.md`
- `/home/ukd/projects/neurastream/templates/help/wip-backup.txt`, `templates/help/agent-score.txt`, `templates/help/pm-fail-facts.txt`, `templates/help/wip-snapshot.txt`
- `/home/ukd/projects/neurastream/templates/queue/TEMPLATE.md`, `templates/tmp-snapshot.sh`
- `/home/ukd/projects/neurastream/src/cli/init.ts` (pm-counts rewrite at lines 62-64)
- `/home/ukd/projects/neurastream/src/core/brief-lint.ts` (repo-specific rules, lines 35-60)
- `/home/ukd/projects/neurastream/src/core/config.ts` (loadConfig deep-merge, line 304)
- `/home/ukd/projects/neurastream/src/adapters/omp/install.ts` (copyPins fills missing only)
- `/home/ukd/projects/neurastream/docs/config.md`, `docs/inventory.md`, `docs/visual/neurastream-deck.html`, `docs/visual/neurastream.eco.js`, `README.md` (grep-verified hits)
- `/home/ukd/projects/neurastream/src/cli/dispatch.ts` (BINS list, run() wiring; uninstall hooks in here)
- `/home/ukd/projects/neurastream/src/core/agents-md.ts` (span/upsertBlock/blockState — block strip for uninstall)
- `/home/ukd/projects/neurastream/src/cli/commands.ts` (ported command switch)
- `/home/ukd/.config/neurastream/config.yml` (owner overrides already present; only paths differ from template today)

## Background

- Facts Main verified on origin/main 09aa730 (2026-10-23 18:2x): `templates/config.yml` has 18 personal hits (gf-testbed x2, gateforge, gf-luna, ~/Work paths); the 18 `templates/agents/*.md` pins carry repo-specific runbook rules and 3 live `~/.omp/agent/sessions/-Work-...` transcript paths each (glm.md, sol.md, +1); `src/cli/init.ts:62-64` writes a repo-specific `default_repo` when that dir exists; `src/core/brief-lint.ts:35-60` hardcodes repo-specific brief rules; `templates/help/wip-backup.txt` names a private backup remote; npm `files` = src, bin, templates, blockers, README, LICENSE. Repo is PUBLIC; docs/plans is untracked. LICENSE (copyright) and package.json (repository URLs) keep the npm identity on purpose.
- Load path: `loadConfig` (src/core/config.ts:304) parses `templates/config.yml` then deep-merges the user file over it, so any default changed here is overridden on the owner's machine — behavior preserved without touching his file.
- Owner's machine after release (Main's phase, not yours): add `brief.repo_rules` (the moved rules) to `~/.config/neurastream/config.yml`, `bun add -g neurastream@0.1.24`, `neurastream adapter install omp`, doctor exit 0.

## Progress
- 2026-10-23 queue-close: done check failed (exit 127); reopened.

Status: complete
- 2026-10-23 18:4x Main: first spawn NsScrubP1234Haiku died in 1.5s on an Anthropic account-wide 429 before reading anything (0 calls of work). Respawned as NsScrubGlm (haiku rate-limited, grok 403, deepseek held as GLM stand-in).
- 2026-10-23 19:5x NsScrubGlm: P5 fail-before recorded (bun test on 09aa730: 1 fail, 129 marker hits, exit 1; /tmp/scrub-fail-before.txt). P1 89e5c1e (neutral config defaults; work_roots [] because the literal `~/work` trips the case-insensitive `~/Work` verify), P2 d4de5a0 (17 pins deleted + neutral example.md, subagents/help/queue/tmp-snapshot rewritten, 3 test asserts updated), P3 ddd2176 (pm-counts special case removed, brief-lint repo rules -> brief.repo_rules in config w/ regex validation, engine test added), P4 82e3087 (config.md neutral, inventory.md deleted, visual headers stripped; P4 verify has one known false positive: deck's embedded woff2 base64 contains random uKd/ukD 3-letter collisions — shipped-set scans are clean), test-align dadc41a (golden oracles pinned via sandbox config + explicit folds for the 3 deliberately reworded lines; validate heavy-log at new default). Full suite 317 pass / 0 fail; typecheck green; npm pack --dry-run ok; shipped-set marker scan clean = SCRUB-DONE (blocker-script leg run as inline equivalent: docs/plans/** is deny-path for me; heavy-run.sh absent on this machine so the suite ran via direct bun test). P6 done 7f36e48: core/uninstall.ts (plan/dry-run/--yes/--purge, outside-HOME refusal, stripBlock in agents-md), dispatch route + help lines, templates/help/uninstall.txt, README uninstall line + neutral-defaults sentence fix, tests/uninstall.test.ts 4/4 (install->uninstall leaves nothing, edited pin kept, purge removes state, outside-HOME refused); typecheck green. Core-purity guard caught "omp"/"computes" substrings in uninstall.ts comments -> reworded, P6 commit re-amended to 59f979c. Final full suite: 321 pass / 0 fail across 33 files. All phases done; nothing pushed.
- 2026-10-23 20:0x Main: verified independently and merged. Fail-before log checked (/tmp/scrub-fail-before.txt). Whole-tree shipped-set marker scan clean (only deliberate npm-identity URLs in package.json/LICENSE); typecheck 0; full suite via heavy-run 321 pass / 0 fail; npm pack 100 files. Merged f994159, release c94899f, tag v0.1.24 pushed, published via the GitHub trusted-publisher workflow (`+ neurastream@0.1.24`, signed provenance). Unpublish of 0.1.12–0.1.23 + deprecate handed to owner (needs his npm login; all inside the 72 h window). Remaining follow-ups live in the rollover note: owner-machine update (brief.repo_rules, bun add -g, adapter install, doctor) and the other machine's uninstall --purge reinstall.
