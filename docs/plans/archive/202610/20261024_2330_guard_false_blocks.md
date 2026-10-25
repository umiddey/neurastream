# Guard false blocks: Progress edit at the call cap, Main's edit window, agent-score flag
Worktree: /home/ukd/projects/neurastream-guard-false-blocks
Branch: fix/guard-false-blocks

## Goal
- INCIDENT I-20261024-27: when a subagent reaches its call cap, its last allowed act is to write its plan's `## Progress`. Today that edit (and a read of its plan with a selector) is refused, so the result is lost and Main must rebuild the report from chat. A subagent at the cap can always read its own plan file (with or without a `:N-M`/`:raw` selector) and edit its Progress; everything else stays refused.
- INCIDENT I-20261024-28: Main's 5-per-15-min edit window counts only real project-file changes. A tool call that was refused or failed (file unchanged) does not count, and text inside quotes, such as JSON piped to a command (`echo '{"x":"PUT >50:"}' | cmd`), is not a redirect target.
- INCIDENT I-20261024-29: `agent-score accept|diagnose|penalty|validate` refuses a missing positional agent name or an unknown flag with exit 2 and the usage line. Today `accept --agent X …` silently records the agent as "--agent".

## Forbidden
- Read /home/ukd/projects/opus-implementer-method.md first and work by it. Read the repo AGENTS.md.
- Work only in /home/ukd/projects/neurastream-guard-false-blocks on fix/guard-false-blocks. Never push, merge, tag or publish. Never change the package.json version or the CHANGELOG release headings (Main releases). Commit files by name; never `git add -A`/`.`; never `--no-verify`.
- Never touch live copies (~/.omp/agent/**, ~/.bun/**, ~/.config/neurastream/**), the live queue index or any live state/log file. Tests use a temp HOME and QUEUE_* env, set AFTER any process.env copy (tests/guards-scope.test.ts:106-117 is the pattern).
- Do not loosen the cap for anything but the agent's own plan file. Do not change what counts as a change for edit/write tools that succeed.
- Stop and report within ~100 calls: write a Progress entry with the exact resume point before call 90.

## Blockers
- no-push
- deny-path /home/ukd/.omp/agent/** /home/ukd/.bun/** /home/ukd/.config/neurastream/** INDEX.md
- deny-command --no-verify git\s+add\s+(-A|--all|\.)(\s|$) git\s+push\b git\s+merge\b git\s+tag\b npm\s+publish reset\s+--hard

## Phases
- [x] P1 I-20261024-27 fail-before first. Take the exact refused tool inputs from the session files: the NsOwnerNotifyGlm edits at calls 100–101, the NsChatUnlockGlm edits at calls 102–104, and the NsOwnerUiComposer read at call 110. They are read-only, under /home/ukd/.omp/agent/sessions/-projects/2026-10-24T19-14-44-763Z_01a16f56-3b9b-711a-9e71-a85107d2e997/<Name>.jsonl; the refusal times are in /home/ukd/.local/state/plan-guard.log 2026-10-24T20:05–20:21Z. Replay each one through checkTool with the sub at calls ≥ cap, a temp queue whose index lists that plan, and the plan file in the main checkout. Write tests/cap-progress.test.ts and record the red run against the old code. Find why `planEdit`/`planRead` (src/core/guards.ts:358-362) do not match: the writes/paths from touchedPaths (src/core/queue/lib.ts:328-360, hashline `[PATH#TAG]` at :341, the selector strip at :338), planAt, and whether a plan edit is refused earlier by another rule. Fix it. Allowed at the cap: a read of the own plan with no selector, `:44+10` or `:raw:44+10`; an edit/write of the own plan. Still refused at the cap: a read or edit of any other file, including another plan — difficulty: 4 — verify: `cd /home/ukd/projects/neurastream-guard-false-blocks && /home/ukd/Work/heavy-run.sh agent "cap progress" -- bun test tests/cap-progress.test.ts` (fail-before recorded)
- [x] P2 I-20261024-28 fail-before first. Main's window is recorded at pre-tool time in editWindow (src/core/guards.ts:388-405), so a call that is then refused or fails in the tool still counts. Red tests in tests/edit-window.test.ts: (a) a guard-denied call does not count; (b) a failed edit (tool result is an error) does not count; (c) `echo '{"input":"PUT >50:"}' | bun x` counts nothing; (d) a real `echo x > file` and a successful edit still count once each. Then fix: count only after a successful tool result (the adapter has the tool_result event) or drop the entry when the result is an error, and make quoted text not match `MUTATING`'s redirect (src/core/queue/lib.ts:363-369) — difficulty: 3 — verify: `cd /home/ukd/projects/neurastream-guard-false-blocks && /home/ukd/Work/heavy-run.sh agent "edit window" -- bun test tests/edit-window.test.ts` (fail-before recorded)
- [x] P3 I-20261024-29 fail-before first. agent-score's accept takes `rest[0]` as the agent (src/core/agent-score.ts:326-329), so a leading flag becomes the name. Red test: `accept --agent X --plan …` → exit 2, usage printed, nothing appended to events.jsonl. The same for diagnose, penalty and validate. Also an unknown flag → exit 2. Then fix — difficulty: 2 — verify: `cd /home/ukd/projects/neurastream-guard-false-blocks && /home/ukd/Work/heavy-run.sh agent "score args" -- bun test tests/agent-score-args.test.ts` (fail-before recorded)
- [x] P4 CHANGELOG Unreleased → Fixed (one entry per incident, naming the INCIDENT id). Full suite + typecheck green — difficulty: 1 — verify: `cd /home/ukd/projects/neurastream-guard-false-blocks && /home/ukd/Work/heavy-run.sh agent "guard false blocks full" -- sh -c 'bun test && bun run typecheck'`
- [x] P5 Main: review, merge, release by tag, install after the owner's unlock — difficulty: 1 — verify: `neurastream doctor`

## Done check
`git -C /home/ukd/projects/neurastream merge-base --is-ancestor fix/guard-false-blocks origin/main`

## Code read by Main
- `/home/ukd/projects/neurastream/src/core/guards.ts` (subRules cap exemption :351-363; editWindow :388-405; window file :57-73)
- `/home/ukd/projects/neurastream/src/core/queue/lib.ts` (touchedPaths :328-360; MUTATING + changesFiles :362-369)
- `/home/ukd/projects/neurastream/src/core/agent-score.ts` (accept positional agent :326-329)
- `/home/ukd/projects/neurastream/tests/guards-scope.test.ts` (child env order :106-117)

## Progress
Status: complete
- 2026-10-25 ~02:10 Main: v0.2.8 publish and CI runs are green. Installed with `bun add -g neurastream@latest` (installed 0.2.8, registry 0.2.8). doctor first reported a stale AGENTS.md block; `neurastream adapter install omp` rewrote it, and `neurastream doctor` then printed "ok" and exited 0. P5 ticked. Findings: none
- 2026-10-25 ~01:45 Main: reviewed the finisher's report.
  - Scored: Gemini for P1 (825e1ea) and P3 (354a1e7); FinishGlm for P2 (01342b9 + 238b4e6) and P4 (3f53446).
  - Merged into main as 614804a; the CHANGELOG conflict was resolved into a new `## 0.2.8` section.
  - heavy-run "ns 0.2.8 full": 516 tests, 0 fail, tsc clean. Tag v0.2.8 pushed.
  - P5 is left with: install after the owner's guard unlock, then `neurastream doctor`.
  Findings: none
- 2026-10-25 ~01:30 NsGuardFalseBlocksFinishGlm: P1–P4 done, all green, worktree clean.
  - Uncommitted 5-file diff reviewed: KEPT. The 4 code/test files are the real P2 completion — committed HEAD (01342b9) failed its own full suite 476 pass / 4 fail: guards.test.ts + guards-omp.test.ts (count-at-tool-result never runs in the one-shot `guard pre-tool` CLI, so the 3rd-write inject and the 6th-write block vanished) and write-targets-heredoc ×2 (`withoutQuotes` emptied quotes, hiding `python3 -c 'open("f.ts","w")'` from MUTATING). CHANGELOG.md kept for P4. My first move — reverting the 4 files to HEAD — was wrong and was undone after that suite run; the identical diff was re-applied (stat 29+/23− matches the original byte-for-byte shape).
  - Fail-before (temp worktree at 1d319f4, committed test files copied in, heavy-run, worktrees removed after):
    - P1 `agent "cap progress old (fail-before 1d319f4)"`: 0 pass / 1 fail / 4 expect, exit 1 — old `writeTargets("edit", <structured edit>)` returns `[]`, so the own-plan edit is not recognized at the cap.
    - P2 `agent "edit window old (fail-before 1d319f4, final test)"`: 2 pass / 2 fail / 11 expect, exit 1 — (b) failed edit still counted (window 1 ≠ 0; old code has no un-count path) and (c) `changesFiles` true for `echo '{"input":"PUT >50:"}' | bun x`. Variant note: old guards.ts exports no `readWindow`/`writeWindow`/`revertMainEdit`, so the variant reads `$QUEUE_STATE/edit-window.json` directly and drops the revert call (assertions unchanged); an earlier interim run (`agent "edit window old (fail-before 1d319f4)"`, 2 pass / 2 fail) used the pre-rewrite test file.
    - P3 `agent "score args old (fail-before 1d319f4)"`: 0 pass / 6 fail / 6 expect, exit 1 — no exit-2+usage path exists; `diagnose/penalty --agent X …` exited 0 (agent recorded as "--agent").
  - Verifies (all exit 0): P1 `agent "cap progress"` 1 pass / 0 fail / 25 expect; P2 `agent "edit window"` 4 pass / 0 fail / 13 expect; P3 `agent "score args"` 6 pass / 0 fail / 36 expect; P4 `agent "guard false blocks full"` 480 pass / 3 skip / 0 fail (483 tests, 55 files) + `tsc --noEmit`.
  - Commits on fix/guard-false-blocks: 825e1ea (P1, Gemini), 01342b9 (P2, Gemini), 354a1e7 (P3, Gemini), 3f53446 (P4 CHANGELOG), 238b4e6 (P2 completion: `revertMainEdit` on error/restore + `withoutQuotedRedirects`). `git grep -nE "\[(IP_ADDRESS|REDACTED|EMAIL|API_KEY)"` before each of my commits: 0 hits. Nothing pushed/merged/tagged.
  - Resume: P5 is Main's (review, merge, release by tag, install after the owner's unlock, `neurastream doctor`).
  Findings: counting must happen in `editWindow` (pre-tool) because the one-shot guard CLI has no tool_result to count at; the adapter's `revertMainEdit` then drops the entry when the result is an error or `checkPlanEdit` restores the file — that is the only design that satisfies CLI and adapter paths at once. Quote-stripping in `MUTATING`/`writeTargets` must keep quote contents (only neutralize `>`) because 0.2.6's interpreter-write detection (`open(…,"w")`, `.write_text(`) matches inside quotes.
- 2026-10-25 ~00:30 Main: NsGuardFalseBlocksGemini died on a Gemini quota 429 (resets 2026-10-31). It wrote no Progress entry and ticked no phase. On fix/guard-false-blocks it left commits 825e1ea (P1: cap exemption + tests/cap-progress.test.ts), 01342b9 (P2: window counts on tool success, quoted redirects ignored + tests/edit-window.test.ts) and 354a1e7 (P3: agent-score positional/unknown-flag exit 2 + tests/agent-score-args.test.ts). It also left an UNCOMMITTED diff of 5 files, 34+/23−: CHANGELOG.md, src/adapters/omp/index.ts, src/core/guards.ts, src/core/queue/lib.ts, tests/edit-window.test.ts. No fail-before run is recorded for any phase. Its heavy-run "guard false blocks full" may still be in the lock. Next implementer:
  - review the uncommitted diff and keep it only if it is right;
  - prove fail-before for P1, P2 and P3 by running each phase's test file against the old code (`git -C <tmp worktree at 1d319f4>` with the new test files copied in), and record each red run here;
  - run each phase verify, tick P1–P3, then do P4.
  Findings: none
- 2026-10-24 ~23:30 Main: plan written from three incidents filed tonight. Evidence:
  - I-27: plan-guard.log has refused edits at the cap (NsChatUnlockGlm 20:05:17–20:06:00Z, NsOwnerNotifyGlm 20:19:54/20:20:38Z) and the composer's selector read at 20:20:54Z.
  - I-28: main-guard listed "edit:…/package.json" for a refused edit (file unchanged) and three "bash:…/50:\\n+-" entries from echo'd JSON.
  - I-29: events.jsonl lines 559-562 were hand-fixed earlier.
  A probe from the repo src is not valid evidence: when run from the repo, the package root itself is protected (lib.ts protectedPaths pkg.root). Next: worktree + spawn P1–P4. Findings: none
- 2026-10-25: Began P1 in `/home/ukd/projects/neurastream-guard-false-blocks` (`fix/guard-false-blocks`). Added `tests/cap-progress.test.ts`; after correcting inherited `QUEUE_*` test state and indexing only the own plan, `/home/ukd/Work/heavy-run.sh agent "cap progress" -- bun test tests/cap-progress.test.ts` passed (1 pass, 0 fail, 9 assertions; before adding the selector assertion). The cap exemption now reads edit targets from touched paths, fixing the regression test. A valid fail-before against unchanged code and replay of all historical refused tool inputs are not yet recorded. No commits. Resume: run the corrected P1 test with selector assertion; perform exact historical replays and establish remaining failing case; finish P1, then P2/P3 fail-before and fixes, P4 full suite/typecheck; commit each green unit and run forbidden-name scan. Findings: none

## Background
- The installed guard is 0.2.1, while the refusals happened. P1 must replay against current main, not assume the bug is still there. If a replay passes on main, record that with the replay as the regression test, and find the case that still fails.
