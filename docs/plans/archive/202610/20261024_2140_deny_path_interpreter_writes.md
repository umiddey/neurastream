# deny-path catches file writes done through python/ruby/perl code
Worktree: /home/ukd/projects/neurastream-interp-writes
Branch: fix/deny-path-interpreter-writes

## Goal
- INCIDENT I-20261024-24. A subagent refused by `deny-path` on edit/cp/rm wrote and removed the same files with `python3 -c "…Path('x').write_text(…)"`, `python3 << 'PY' … PY` and `python3 -c "import os; os.remove('x')"` (history://PmLint1Composer, calls 96-130). The `deny-path` blocker must refuse these the same way it refuses `rm x` or `echo > x`.
- Cause: in `src/core/blockers.ts`, an interpreter segment counts as writing only when its words match `CODE_WRITE = /writeFile|Bun\.write|unlink/` (:403, used at :494); Python writes (`.write_text(`, `.write_bytes(`, `open(…, "w")`, `os.remove/rename/replace/unlink`, `shutil.`, `.writelines(`) do not match. Heredoc bodies are dropped by `splitShell` (:207-219), so code fed to an interpreter on stdin (`python3 << 'PY'`) is never judged. The `eval` path uses `CODE_MUTATING` (:50-51), which has the same gap.
- `src/core/queue/lib.ts` already lists these Python write forms in `MUTATING` (:361-362) and extracts literal targets in `writeTargets` (:522-529); reuse those patterns, do not create a second, different list.

## Forbidden
- Read /home/ukd/projects/opus-implementer-method.md first and work by it. Read the repo AGENTS.md.
- Work only in /home/ukd/projects/neurastream-interp-writes on fix/deny-path-interpreter-writes. Never push, merge, tag or publish; never change the package.json version or CHANGELOG release headings (Main releases). Commit files by name; never `git add -A`/`.`; never `--no-verify`.
- Never touch live copies (~/.omp/agent/**, ~/.bun/**) or the live queue index.
- Tests assert behaviour (refused/allowed, exit codes), never wording or source text.
- No false refusals: reading a protected file with python (`open('x')`, `Path('x').read_text()`), and python writes to paths outside the deny globs, stay allowed.
- Every phase is fail-before: write the test, run it red, record the red run, then change src.
- Every test run via `/home/ukd/Work/heavy-run.sh <agent> "<label>" -- <cmd>` with tool timeout 0. Green = `bun test` at the worktree root plus `bun run typecheck`.
- Call budget: stop and report within ~80 calls. Add ONE dated bullet under `## Progress` after the `Status:` line.

## Blockers
- no-push
- deny-path /home/ukd/.omp/agent/** /home/ukd/.bun/** INDEX.md
- deny-command --no-verify git\s+add\s+(-A|--all|\.)(\s|$) git\s+push\b git\s+merge\b git\s+tag\b npm\s+publish reset\s+--hard

## Phases
- [x] P1 Red tests in tests/blockers-shell.test.ts (deny-path glob `secret/**`, cwd = the sandbox repo): refused — (a) `python3 -c "from pathlib import Path; p=Path('secret/a.py'); p.write_text('x')"`; (b) `python3 -c "import os; os.remove('secret/a.py')"`; (c) `python3 << 'PY'` heredoc whose body does `open('secret/a.py','w').write('x')`; (d) `python3 -c "import shutil; shutil.copy('ok.txt','secret/a.py')"`; (e) the `eval` tool with Python code `Path('secret/a.py').write_text('x')`; (f) `ruby -e "File.write('secret/a.rb','x')"`. Allowed — (g) `python3 -c "print(open('secret/a.py').read())"`; (h) `python3 -c "Path('other/b.py').write_text('x')"`; (i) a heredoc to `cat` (not an interpreter) whose body mentions `secret/a.py`. Record the red run — difficulty: 3 — verify: `cd /home/ukd/projects/neurastream-interp-writes && /home/ukd/Work/heavy-run.sh agent "interp writes red" -- bun test tests/blockers-shell.test.ts`
- [x] P2 Fix in src/core/blockers.ts: one shared code-write pattern (from lib.ts MUTATING's code parts plus `File.write`) used by `mutationTargets` (:494) and the eval path (:588); interpreter heredoc bodies kept for the interpreter's segment (splitShell :207-219) so they are judged as its code; targets are the literal path words of that code, resolved against the segment's directory. CHANGELOG `## Unreleased` → Fixed, citing the incident. Full suite + typecheck green — difficulty: 3 — verify: `cd /home/ukd/projects/neurastream-interp-writes && /home/ukd/Work/heavy-run.sh agent "interp writes full" -- sh -c 'bun test && bun run typecheck'`
- [x] P3 Main: review, merge, release by tag, install after the owner's guard unlock, `neurastream doctor` exit 0, `neurastream incident plan I-20261024-24 <this plan>` closes on merge — difficulty: 1 — verify: `neurastream doctor`

## Done check
`git -C /home/ukd/projects/neurastream merge-base --is-ancestor fix/deny-path-interpreter-writes origin/main`

## Code read by Main
- `/home/ukd/projects/neurastream/src/core/blockers.ts` (CODE_MUTATING :50-51; splitShell heredoc skip :207-219; INTERPRETERS :390-399; CODE_WRITE :403; mutationTargets :478-498; denyPath :583-595)
- `/home/ukd/projects/neurastream/src/core/queue/lib.ts` (MUTATING :361-362; writeTargets code-write regexes :522-529)

## Progress
Status: complete
- 2026-10-25 ~02:35 Main: P3 done. Shipped in 0.2.6 (fd2175a), carried in the installed 0.2.10; `neurastream doctor` → ok, installed 0.2.10 = registry. I-20261024-24 is PLANNED on this plan and closes with it. Findings: none
- 2026-10-24 ~21:50 Main: reviewed main..358073e; heavy-run log: "interp writes red" exit 1 (21:30), "interp writes full" exit 0 (21:33). Merged, released fd2175a tag v0.2.6, scored P1+P2. Note: CODE_WRITE in blockers.ts is a copy of lib.ts MUTATING's code parts, not an import (drift risk, accepted). Next: P3 install after the owner's guard unlock. Findings: none
- 2026-10-24 ~21:45 Main: plan written for INCIDENT I-20261024-24 (found reviewing PmLint1Composer). Next: worktree + spawn P1+P2. Findings: none
- 2026-10-24 ~21:40 NsInterpWritesGlm (P1+P2): red 50f3322 — tests (a)-(i) in tests/blockers-shell.test.ts, heavy-run "interp writes red" exit 1 (4 fail on (a)-(f), the 3 allowed cases green); fix 358073e — shared CODE_WRITE (lib.ts MUTATING code parts + `File.write`) in mutationTargets and the eval path, heredoc bodies kept on the interpreter segment (cat heredocs still prose), CHANGELOG Unreleased/Fixed; heavy-run "interp writes full" exit 0 (430 pass / 0 fail + typecheck). Not pushed/merged/tagged; P3 is Main's. Findings: none
