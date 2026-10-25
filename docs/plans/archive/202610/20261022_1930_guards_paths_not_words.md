# neurastream: plan blockers judge actions and file targets, not words in the command text
Worktree: /home/ukd/Work/neurastream-guard-paths
Branch: fix/guards-paths-not-words

## Goal
- Owner (2026-10-22 ~19:15): "I like your suggestions, make a plan for that" — for guards that block file paths and actions, not words, and for letting workers write their own progress.
- Seen today (plan-guard.log lines 774-775):
  - OiScPinsHaiku's `git commit -m "… push-fixture failures …"` was refused by no-push.
  - Its commit message and `git diff --quiet uv.lock` were refused by `deny-path uv.lock`.
  - CpSecP6Haiku could not create a script whose text contains `uv lock --upgrade`, because deny-command matched the heredoc body.
  - Every plan's `deny-path docs/plans/**` stops workers from appending to their own `## Progress`, although plan-edit (`checkPlanEdit`) already restricts sub edits to Progress.
- When done, these hold:
  1. no-push refuses only when the executed git subcommand is `push` (global options like `-C <dir>`, `-c k=v`, `--git-dir=…` skipped), or the command is `glab mr merge` / `gh pr merge`. The word "push" inside a quoted argument, commit message or heredoc never counts.
  2. deny-path checks a shell command only for the files it would change. Those are redirect targets (`>`, `>>`) and the operands of rm, mv, cp, truncate, tee, `sed -i`, patch, and `git rm|mv|checkout|restore`, in the segment that runs them. Reads (`git diff uv.lock`, `cat uv.lock`) and quoted text are never paths.
  3. deny-command matches the executed command words of each segment (`;`, `&&`, `||`, `|`, newline). It never matches heredoc bodies or quoted string arguments. deny-text keeps scanning written file content; that rule is about content.
  4. deny-path never refuses a write/edit of a live plan file (`MAIN_PLAN_FILE` pattern in guards.ts). Those edits stay governed by checkPlanEdit (Progress-only for subs, restore otherwise).

## Forbidden
- Never push, tag, publish, link or install; never bump the version. Commit only on fix/guards-paths-not-words, files added by name; never `git add -A`/`git add .`; never `--no-verify`.
- Touching the live setup (`~/.omp/agent`, `~/.local/bin`, `~/.local/state`, `~/.config`). Tests and smokes run under a sandbox `HOME=/tmp/neurastream-home-*` (AGENTS.md).
- Weakening a refusal that the tests list as must-refuse. Every relaxation needs a test pair: the old false positive is now allowed, and the real action is still refused. Real actions include `git push`, `git -C x push origin main`, `cd x && git push`, `echo y > uv.lock`, `rm uv.lock`, `sed -i s/a/b/ uv.lock`, `cp a uv.lock`, a sub `write` to `docs/plans/x.md` outside Progress (restored by plan-edit), and `uv lock --upgrade` run as a command.
- Changing files outside `src/core/blockers.ts`, `src/core/guards.ts` (only if needed for goal 4), `tests/`, `CHANGELOG.md` (one Unreleased line), `README.md` (blocker section only).
- Golden/parity tests that compare a blocker against the original scripts: where the new behavior differs on purpose (goals 1-4), change the expectation and give the reason in a one-line comment. Never delete a parity test to make it pass.
- Every `bun test`/typecheck run goes through `/home/ukd/Work/heavy-run.sh <agent> "<label>" -- <cmd>` with tool timeout 0, in the FOREGROUND. Probe one test file (`bun test tests/guards.test.ts`) before the full suite.
- `find` is broken: use grep/glob/read. One failed tool call is never a blocker; try two other ways.
- Claim rule: report only what you ran and saw (label + exit code + log path).
- Call budget: stop and report within ~100 tool calls per run (warning at 90, hard stop at 100). Commit each green unit immediately. You may append entries under `## Progress` of this plan only.
- Read /home/ukd/projects/opus-implementer-method.md first and work by it.
- STOP and report if a shell tokenizer dependency seems needed. Write a small quote-aware splitter in blockers.ts instead; no new npm dependency.

## Blockers
- no-push
- deny-path /home/ukd/.omp/agent/** /home/ukd/.local/bin/** /home/ukd/.local/state/** /home/ukd/.config/** /home/ukd/.npmrc INDEX.md package.json bun.lock
- deny-command npm\s+publish bun\s+publish npm\s+link bun\s+link git\s+tag --no-verify git\s+add\s+(-A|--all|\.)

## Phases
- [x] P1 Quote-aware shell splitter in `src/core/blockers.ts`. It splits into segments on `;`, `&&`, `||`, `|` and newline outside quotes, with words with quotes removed. It records which words were quoted and the redirect targets, and drops heredoc bodies (`<<EOF … EOF`, `<<'EOF'`, `<<-EOF`). Unit tests cover quotes, escapes, heredocs and `$(…)` (treat the inside of `$(…)` as its own segment) — difficulty: 3 — verify: `heavy-run.sh <agent> "ns guard splitter" -- bun test tests/blockers-shell.test.ts` exit 0
- [x] P2 no-push on the splitter (goal 1). Refuse when a segment's first word is `git` and its subcommand (after global options `-C <v>`, `-c <v>`, `--git-dir[=]<v>`, `--work-tree[=]<v>`, `--namespace[=]<v>`) is `push`. Also refuse `glab mr merge` and `gh pr merge`. Pairs: `git commit -m "fix push fixture"` allowed; `git -C /x push -q origin main` refused; `cd x && git push` refused; `bash -c 'git push'` refused (an unquoted `-c` script for bash/sh is re-split) — difficulty: 2 — verify: `heavy-run.sh <agent> "ns guard nopush" -- bun test tests/blockers-shell.test.ts tests/guards.test.ts` exit 0
- [x] P3 deny-path and deny-command on the splitter (goals 2 and 3). shellPaths returns only the targets of mutating segments, and MUTATING is decided per segment from its command word. deny-command tests each segment's unquoted words joined by spaces. eval (JS/Python code, not shell) keeps today's whole-text behavior. Pairs: `git commit -m "lock: uv.lock unchanged"` allowed and `git diff --quiet uv.lock` allowed under `deny-path uv.lock`; `echo x > uv.lock`, `rm uv.lock`, `sed -i s/a/b/ uv.lock`, `cp a uv.lock`, `tee uv.lock` refused. `cat > s.sh <<'EOF'\nuv lock --upgrade\nEOF` allowed under `deny-command uv\s+lock\s+--upgrade`, while `uv lock --upgrade` and `cd backend && uv lock --upgrade` are refused — difficulty: 3 — verify: `heavy-run.sh <agent> "ns guard paths" -- bun test tests/blockers-shell.test.ts tests/guards.test.ts tests/guards-omp.test.ts` exit 0
- [x] P4 Goal 4: `denyPath` skips paths matching `MAIN_PLAN_FILE` (export it from one place; no second regex) for write/edit. Tests, sub with `deny-path docs/plans/**`: a Progress-only edit of the plan is allowed and passes plan-edit; a Status flip is still restored by plan-edit; `rm docs/plans/x.md` is still refused; a write to `docs/plans/archive/x.md` is still refused. Also one CHANGELOG Unreleased line for P1-P4 and README blocker-section wording — difficulty: 2 — verify: `heavy-run.sh <agent> "ns guard full" -- bash -c 'bun run typecheck && bun test'` exit 0

## Done check
`bun run typecheck && bun test && bun test tests/blockers-shell.test.ts && grep -q 'blockers' CHANGELOG.md`

## Code read by Main
- `/home/ukd/Work/neurastream-guard-paths/src/core/blockers.ts`
- `/home/ukd/Work/neurastream-guard-paths/tests/guards.test.ts`
- `/home/ukd/Work/neurastream-guard-paths/AGENTS.md`

## Progress
Status: complete
- 2026-10-22 16:5x Main: the second close failed too, and its log gives no detail. A manual run in /home/ukd/projects/neurastream passes all of it: typecheck exit 0, `bun test` 175/0, blockers-shell 20/0. Suspect: the known minute-boundary flake in `tests/golden/ports-p4.test.ts` priority-watch, reported by NsScPinsGlm (oracle and port print HH:MM; a run that crosses a minute tick fails). Retrying once, with the output captured.
- 2026-10-22 16:5x Main: the first queue-close ran the done check in /home/ukd/projects/neurastream, whose main was 2 commits behind origin (no tests/blockers-shell.test.ts yet), so it failed. That checkout is now fast-forwarded to 907e462. Re-closing.
- 2026-10-22 16:4x Main: merged into main (fast-forward) and tagged v0.1.12. Branch CI 39796287491, publish run 39797947365 exit 0. Installing it (`bun add -g neurastream@0.1.12`) was refused as a protected guard file, so the owner's unlock is needed for install + `neurastream doctor`.
- 2026-10-22 16:3x Main (real clock CEST; the earlier "19:3x" stamps were wrong): commit 5e83aac (NsGuardPathsHaiku work, committed by Main) checked in the worktree. Results: typecheck exit 0; `bun test` 175 pass, 0 fail; CHANGELOG mentions blockers. P1-P4 ticked. Next (Main): push the branch, CI, merge, release, `bun add -g neurastream@latest`, `neurastream doctor`. Known limits, out of scope: `$()` used as a redirect target, `sudo -u root git push`, a heredoc script later run with `bash s.sh`, quoted command words.
- 2026-10-22 19:3x Main: worktree /home/ukd/Work/neurastream-guard-paths on fix/guards-paths-not-words from origin/main e38ff1d.
  - Root causes, from reading `src/core/blockers.ts`:
    - no-push's regex `\bgit\b[^;&|\n]*\bpush\b` (line ~205) matches "push" anywhere after `git` in the same segment, including `-m` text.
    - deny-path's `shellPaths` (line ~140) treats every word of the whole command as a path once MUTATING (line ~49) matches anywhere, so commit-message words become paths.
    - deny-command tests the raw command text, including heredoc bodies.
  - Separately, the rollover-note refusal at 13:55Z (plan-guard.log line 773) is not a code bug. 328e65d already exempts it. Main's session started 2026-10-21 19:56, before 0.1.10/0.1.11 were installed (10-22 10:50), so it runs the old in-memory guard. Fresh sessions have the fix; not in this plan.
  - After merge, Main releases per the neurastream flow: tag → OIDC publish → `bun add -g neurastream@latest` → `neurastream doctor`.

- 2026-10-22 NsGuardPathsHaiku (implementer): P1-P4 implemented in /home/ukd/Work/neurastream-guard-paths on fix/guards-paths-not-words.
  - src/core/blockers.ts: quote-aware splitter (heredocs, `$()`, `bash -c` re-split); no-push judges `git push` as a command (bash only); deny-command matches unquoted command words; deny-path judges real mutation targets only; write/edit to a live plan file is left to plan-edit (`docs/plans/archive/` still refused).
  - Verify: tests/blockers-shell.test.ts 20 pass 0 fail (heavy-run label "ns guard splitter"); tests/guards.test.ts 27 pass 0 fail; `tsc --noEmit` exit 0 and full `bun test` 175 pass 0 fail, 19 files (label "ns guard-paths typecheck+full suite"). The worktree has an untracked `node_modules` symlink to the main checkout (not committed).
  - NOT COMMITTED: the live no-push guard refused the `git commit` call because its message contains "push" next to "git" (the false positive this plan fixes; the live guard runs the old code). Files staged by name: CHANGELOG.md, README.md, src/core/blockers.ts, tests/blockers-shell.test.ts. Main commits them.
  - Phase ticks P1-P4 left for Main (they sit outside Progress).
  - Known limits: `echo $(...) > file` target unseen; `sudo -u root git push` not seen through; a script written by heredoc and run by `bash s.sh` is not read; quoted command words in deny-command (`uv "lock" --upgrade`) are not matched; cd tracking is a conservative union.
## Background
- Owner's complaint about the PDLC (2026-10-22): too much friction from guards that block harmless commands, while the real protections (no push, no lock/plan tampering) must stay.
