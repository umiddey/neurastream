# brief-lint fails plans on paths from finished phases and history sections
Worktree: /home/ukd/projects/neurastream-brief-lint
Branch: fix/brief-lint-live-sections

## Goal
- Owner rule: obvious bug → plan and fix right away.
- Seen live 2026-10-24 ~20:35: `brief-lint` on the CP security plan (/home/ukd/Work/aetherios-contractor-portal/docs/plans/immediate/20261022_1330_security_audit_and_fixes.md) gives 19 errors "path does not exist", all from `## Code read by Main` and ticked phases that cite worktrees removed after landing (e.g. the cp-sec-d worktree's backend/utils/chat_tokens.py). Same on the Gateforge 0.18.3 plan for the deleted rg-0183 clones. Main had to mkdir the missing paths to spawn.
- Cause: /home/ukd/projects/neurastream/src/core/brief-lint.ts:43-58 `lint` collects every path in the whole file and errors on each missing one, with no notion of plan sections.
- Wanted: when the linted file is a plan (has a `## Phases` heading), paths are checked only in the live parts: the header lines, Goal, Forbidden, Blockers, unticked phase lines, Done check. Paths in ticked phase lines, `## Code read by Main`, `## Progress` and `## Background` are history and are not checked. A plain brief (no `## Phases`) is checked whole, as today.

## Forbidden
- Read /home/ukd/projects/opus-implementer-method.md first and work by it. Read the repo AGENTS.md.
- Work only in /home/ukd/projects/neurastream-brief-lint on fix/brief-lint-live-sections. Never push, merge, tag or publish; never change package.json version or CHANGELOG release headings (Main releases). Commit files by name; never `git add -A`/`.`; never `--no-verify`.
- Never touch live copies (~/.omp/agent/**, ~/.bun/**), never the live queue index.
- Tests assert behaviour (exit code, which path is reported), never wording or source text.
- Every phase is fail-before: write the test, run it red, record the red run, then change src.
- Every test run via `/home/ukd/Work/heavy-run.sh <agent> "<label>" -- <cmd>` with tool timeout 0. Green = `bun test` at the worktree root.
- Call budget: stop and report within ~60 calls (warning at 90). Add ONE dated bullet under `## Progress` after the `Status:` line.

## Blockers
- no-push
- deny-path /home/ukd/.omp/agent/** /home/ukd/.bun/** package.json INDEX.md
- deny-command --no-verify git\s+add\s+(-A|--all|\.)(\s|$) git\s+push\b git\s+merge\b git\s+tag\b npm\s+publish reset\s+--hard

## Phases
- [x] P1 Red tests in tests/brief-lint.test.ts (sandbox paths under a temp dir): a plan whose missing path sits only in a ticked phase line, in `## Code read by Main`, in `## Progress` or in `## Background` passes today's lint → must exit 0 (red now); the same missing path in an unticked phase line, in Goal or in Done check still fails; a plain brief (no `## Phases`) with a missing path still fails. Record the red run — difficulty: 2 — verify: `cd /home/ukd/projects/neurastream-brief-lint && /home/ukd/Work/heavy-run.sh agent "brief-lint live red" -- bun test tests/brief-lint.test.ts`
- [x] P2 Fix in src/core/brief-lint.ts: build the text the path check scans from the live parts only when the file has a `## Phases` heading (reuse the section splitter in src/core/queue/lib.ts if it fits); the other checks keep reading the whole file. CHANGELOG `## Unreleased` → Fixed entry. Full suite green; then run the built brief-lint on the CP plan above and report its result — difficulty: 2 — verify: `cd /home/ukd/projects/neurastream-brief-lint && /home/ukd/Work/heavy-run.sh agent "brief-lint live full" -- bun test`

## Done check
`git -C /home/ukd/projects/neurastream merge-base --is-ancestor fix/brief-lint-live-sections origin/main`

## Code read by Main
- `/home/ukd/projects/neurastream/src/core/brief-lint.ts` (lint :12-88; path collection :43-58 scans the whole file)
- `/home/ukd/projects/neurastream/src/core/guards.ts` (unticked :187-190 uses q.sections(p.text).get("phases"))

## Progress
Status: complete
- 2026-10-24 ~21:30 (Main): reviewed diff (liveText in src/core/brief-lint.ts:14-30; only the path scan uses it), heavy-run log shows "brief-lint live red" exit 1 and "brief-lint live full" exit 0. ff-merged e982d78 to main, release 84a0d9c, tag v0.2.4: CI 40115935784 + publish 40115935796 green; `npm view neurastream version` = 0.2.4. Install waits for the owner's guard unlock. Scored accept P2. Findings: none
- 2026-10-24 21:05 (NsBriefLintGlm): P1 red run recorded (heavy-run "brief-lint live red": 13 pass / 4 fail — exactly the four history tests: ticked phase line, Code read by Main, Progress, Background); P2 fix in src/core/brief-lint.ts reuses queue sections() to scan header+Goal+Forbidden+Blockers+unticked phases+Done check only; commit e982d78 on fix/brief-lint-live-sections (scan 0 hits); heavy-run "brief-lint live full" 414 pass / 0 fail (3 pre-existing skips), `bun run typecheck` exit 0; built bin on the CP security plan copy (/tmp/brieflint-live-cpsec.md): exit 0, 0 errors, 1 warning (92510 chars > aim 8000 — pre-existing length warn, not a path error; was 19 errors before). Findings: none
- 2026-10-24 ~20:40 (Main): plan written after brief-lint refused the CP security plan on 19 history paths. Next: spawn P1+P2. Findings: none
