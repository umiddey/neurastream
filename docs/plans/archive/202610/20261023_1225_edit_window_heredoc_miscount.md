# neurastream: heredoc text no longer counts as Main's project-file changes
Worktree: /home/ukd/Work/neurastream-window-fix
Branch: fix/edit-window-heredoc

## Goal
- Owner (2026-10-23 ~12:10): "Why did you get this message? What files did you change five times?" INCIDENT I-20261023-13.
- What happened: Main ran 3 bash calls of the form `python3 - <<'EOF' … EOF` whose heredoc bodies were plan text (`.md`, free). The edit window (`editWindow`, src/core/guards.ts:278) logged them as `bash:/home/ukd/projects/,` and `bash:/home/ukd/projects/\`` — cwd joined with junk. Cause (read by Main): `writeTargets` (src/core/queue/lib.ts:363) runs the redirect regex at :403 `(?:^|[^0-9&>=\-])>{1,2}\s*([^\s&|;)<>]+)` over every segment of the whole command INCLUDING heredoc bodies, so prose such as `` `<exp_unix>.<hmac(job_id|exp)>` `` yields target `` ` `` and `a > , b` yields `,`; `add` (:365) resolves them against cwd.
- When done, these hold:
  - (a) `writeTargets` ignores heredoc bodies (`<<WORD`, `<<'WORD'`, `<<"WORD"`, `<<-WORD` up to the terminator line) for the redirect scan and the per-command word scan (:396-415). The redirect on the heredoc's own command line (`cat <<EOF > out.txt`) still counts.
  - (b) A redirect target made only of punctuation (no letter, digit, `.` or `/`) is not a write target.
  - (c) Real writes are unchanged: `echo y > uv.lock`, `cat > src/x.ts <<EOF`, `sed -i … f`, `rm f`, `tee f`, python `open("f","w")` all still return their target (existing tests stay green).
  - (d) `MUTATING` (:301) / `changesFiles` (:303) are not widened or narrowed.

## Forbidden
- Never push, tag, publish, link or install; never bump the version. Commit only on fix/edit-window-heredoc, files added by name; never `git add -A`/`git add .`; never `--no-verify`.
- Touching the live setup (`~/.omp/agent`, `~/.local/bin`, `~/.local/state`, `~/.config`, `~/.bun/install/global`) or any repo other than this worktree. Tests run under a sandbox `HOME=/tmp/neurastream-home-*` (repo AGENTS.md).
- Changing files outside `src/core/queue/lib.ts`, the test file that already covers `writeTargets` (grep `writeTargets(` under tests/) or one new `tests/write-targets-heredoc.test.ts`, `CHANGELOG.md` (one Unreleased line).
- Never weaken or delete an existing test to pass.
- Every `bun test`/typecheck run goes through `/home/ukd/Work/heavy-run.sh <agent> "<label>" -- <cmd>` with tool timeout 0, in the FOREGROUND. Probe one test file before the full suite.
- `find` is broken: use grep/glob/read. One failed tool call is never a blocker; try two other ways.
- Claim rule: report only what you ran and saw (label + exit code + log path).
- Call budget: stop and report within ~100 tool calls per run (warning at 90, hard stop at 100). Commit each green unit immediately. You may append entries under `## Progress` of this plan only.
- Read /home/ukd/projects/opus-implementer-method.md first and work by it. Read the repo AGENTS.md.
- The live plan-guard refuses any shell call whose text contains the word `queue-close` or `queue-cancel`, or names a path under `docs/plans/`. Never type those in a bash command; use the read/edit tools for the plan file.

## Blockers
- no-push
- deny-path /home/ukd/.omp/agent/** /home/ukd/.local/bin/** /home/ukd/.local/state/** /home/ukd/.config/** /home/ukd/.bun/install/global/** /home/ukd/.npmrc INDEX.md package.json bun.lock
- deny-command npm\s+publish bun\s+publish npm\s+link bun\s+link git\s+tag --no-verify git\s+add\s+(-A|--all|\.)

## Phases
- [x] P1 (a)+(b)+(c)+(d). Tests first: the three real shapes from the incident (a `python3 - <<'EOF'` whose body contains `` `<a>.<b>` `` and `x > , y`, cwd `/home/ukd/projects`) → `writeTargets` returns `[]`; `cat <<EOF > out.txt` → `[<cwd>/out.txt]`; `echo y > uv.lock` → `[<cwd>/uv.lock]`; `python3 -c 'open("f.ts","w")'` → `[<cwd>/f.ts]`; `echo a >,` → `[]`. fail-before: run them red on unchanged code and record the run in Progress (label + exit code), then fix. — difficulty: 3 — verify: `bun test tests/write-targets-heredoc.test.ts`
- [x] P2 Whole suite + typecheck green; CHANGELOG Unreleased line. — difficulty: 1 — verify: `bun run typecheck && bun test`
<!-- difficulty: set by Main at plan time, before any result (agent-score reads it): 1 mechanical · 2 rules · 3 new spec · 4 root-cause · 5 product fix · 8 engine. Owner may override. -->

## Done check
`cd /home/ukd/Work/neurastream-window-fix && bun run typecheck && bun test && grep -qi heredoc CHANGELOG.md`

## Code read by Main
- `src/core/queue/lib.ts`
- `src/core/guards.ts`

## Progress
Status: complete
- 2026-10-23 13:2x Main: reviewed 4589d1a/6ab756e, rebased onto 94b234d, bumped 0.1.21 (b9b55d4). Done check on branch: typecheck 0, 281 pass, heredoc in CHANGELOG. PR #15 squash-merged as cba8f2d, tag v0.1.21 pushed. P1/P2 accepted on cba8f2d.
- 2026-10-23 12:2x Main: plan written for INCIDENT I-20261023-13.
- 2026-10-23 NsWindowHeredocHaiku, P1 red (tests written first, lib.ts unchanged): `HOME=/tmp/neurastream-home-heredoc /home/ukd/Work/heavy-run.sh NsWindowHeredocHaiku "red P1 probe" -- bun test tests/write-targets-heredoc.test.ts` → exit 1. 7 tests: 5 fail, 2 pass. Failing: python prose body (`…/projects`, `…/\``, `…/,` returned), redirect inside body (`world.txt` returned), command word inside body (`old-notes.txt` returned), quoted/tab/bare heredoc forms (`b.txt` returned), `echo a >,` (`,` returned). Passing before the fix, as intended: real-write guard (`uv.lock`, `src/x.ts`, `sed -i`, `rm`, `tee`, python `open` one-liner) and python heredoc that really opens a file.
- 2026-10-23 NsWindowHeredocHaiku, P1 fix, commit 4589d1a (`src/core/queue/lib.ts`: `withoutHeredocBodies` before the segment scan, punctuation-only redirect targets skipped; `tests/write-targets-heredoc.test.ts`). Probe green: `… "green P1 probe" -- bun test tests/write-targets-heredoc.test.ts` → exit 0, 7 pass, 0 fail.
- 2026-10-23 NsWindowHeredocHaiku, P2, commit 6ab756e (CHANGELOG `## Unreleased` / `### Fixed`). `"P2 typecheck" -- bun run typecheck` → exit 0. `"P2 full suite" -- bun test` → exit 0 (job bg_31): 276 pass, 0 fail, 1231 expect() calls, 29 files. Its output has `FAIL` lines from a brief-lint fixture; the summary shows 0 fail. Done check `grep -qi heredoc CHANGELOG.md` → exit 0.
- Left unchanged on purpose: `MUTATING`, `changesFiles`, the python `open()`/`os.remove` regex scan (still reads the whole command, so a python heredoc that really writes a file still counts), `packageOpTarget` (whole command).
- Known limit: heredoc detection is not quote-aware. `echo "<<X"` with a later line `X` would hide the lines between. An unterminated heredoc is kept as command text (fails closed).

## Background
- Release after merge is Main's job (it rides with 0.1.20 if that is not yet tagged, else 0.1.21).
- Separate, not this plan: `writeTargets` misses `open(p, "w")` with a variable path, so a shell heredoc can write a plan file unseen; Main should use edit/write for plans (Main's own rule).
