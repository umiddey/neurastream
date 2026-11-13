# Rollover path skew across a version change (I-20261101-47)

Plan file: /home/ukd/projects/neurastream/docs/plans/20261101_1945_rollover_path_skew.md
Planner: glm
Worktree: /home/ukd/Work/neurastream-rollover (branch fix/rollover-path-skew)

- Read /home/ukd/projects/opus-implementer-method.md first.
- Agents: never push.
- Call budget: stop and report within ~100 calls.

## Goal
INCIDENT I-20261101-47: a session running plugin 0.2.64 writes its rollover request to the legacy state dir `<queue_state>/rollover/relaunch.json`; the fresh launcher on 0.2.65 reads `mainStateDir()/rollover/relaunch.json` = `<queue_state>/mains/main/rollover/relaunch.json`. Across a version change the request is invisible to the new launcher, so the relaunched harness gets no message and sits idle (owner report 2026-11-01 19:30: "a new session was started but nothing got injected to it"). moveLegacyState already ran for this HOME (Oct 31), so nothing ever moves the late-written legacy file again.

## Background
- src/core/guards.ts:117 mainStateDir() appends mains/<id> since multi-main P2 (0.2.65).
- src/adapters/omp/launch.ts:276 readRequest() reads only relaunchPath() (the new location).
- src/core/rollover.ts:175 relaunchPath() defaults its stateDir to mainStateDir(); stateDirPath() is src/core/queue/lib.ts:94 (lib.ts:92 is blockersDirPath).
- Evidence: legacy relaunch.json mtime 19:28:33; launcher 507146 (0.2.65) env NEURASTREAM_RELAUNCH_SINCE=14:00; its omp child argv bare; no "handoff inline" log line; manual replay (copy + touch to the new path) staged the fix.
- Owner quote (19:31): "session rollover didnt really happen. ,a new session was started but nothing got injected to it and i was just sitting by itself"

## Code read by Main
- `src/core/rollover.ts` (relaunchPath :175, stateDir default; buildHandoff)
- `src/adapters/omp/launch.ts` (runMainLauncher :170-257, readRequest :276-298, nextMessage :311-349)
- `src/core/guards.ts` (mainStateDir :117-123, moveLegacyState)
- `src/core/queue/lib.ts` (blockersDirPath :92, stateDirPath :94)

## Reuse
- new: none — readRequest gains a legacy fallback read; no new module. checked: src/adapters/omp/launch.ts:276-298 — reuse statSync/readFileSync pattern. reuse: existing relaunchPath + adapterLog.

## Phases
- [x] P0 Main: blocker script `docs/plans/blockers/rollover-scope.sh` exists and runs clean on the fresh worktree (content scan: only src/adapters/omp/launch.ts, src/core/rollover.ts, tests/launch.test.ts, tests/rollover*.test.ts, CHANGELOG.md, README/docs lines naming the fallback) — difficulty: 1 — verify: `bash /home/ukd/projects/neurastream/docs/plans/blockers/rollover-scope.sh`
- [x] P2 readRequest (src/adapters/omp/launch.ts:276-298) gains a legacy fallback, gated to `mainId() === "main"` only (guards.ts:121; the legacy `<queue_state>/rollover/` dir belongs to the single-main era — a `mains/<other-id>` launcher must never read it, launch.ts:175-182): when the new-path request is missing OR stale (mtime < since returns null at launch.ts:284), read the legacy `<queue_state>/rollover/relaunch.json`; a legacy mtime passing the same `since` check is consumed exactly like a new-path request. A successful consume EMPTIES the slot on both paths (launch.ts:213, :226, :251): rmSync the file that was read, and — for mainId "main" only — also rmSync the other path's file when present, whatever its mtime (a leftover copy, even one older than this run's since, is still inside MAX_NOTE_AGE_MS (rollover.ts:15) and would be re-injected by the next fresh start, launch.ts:220); a non-main instance never touches the legacy file. When nothing is consumed, every file stays. The 0.2.65 hook keeps writing the new path; nothing else moves. Tests (fail-before): (a) legacy-only request newer than `since` → the child runs with the handoff and the legacy file is removed; (b) legacy request older than `since`, nothing else present → ignored, file left; (c) both fresh → the new-path one wins, BOTH files removed; (d) the since-branch (NEURASTREAM_RELAUNCH_SINCE env) consumes + removes a fresh legacy request; (e) stale new-path + fresh legacy → legacy consumed, BOTH files removed; (f) mainId other than "main" (mains/<other-id> dir exists) → no legacy read, legacy file untouched, child runs bare; (g) fresh new-path + legacy older than since but inside MAX_NOTE_AGE_MS → new-path consumed, BOTH files removed — difficulty: 2 — verify: `cd /home/ukd/Work/neurastream-rollover && bun test tests/launch.test.ts`
- [x] P3 Docs: README rollover section one sentence ("a request written by an older version in the legacy dir is still picked up"), CHANGELOG `## Unreleased` Fixed bullet — difficulty: 1 — verify: `cd /home/ukd/Work/neurastream-rollover && bun run typecheck && bun test tests/launch.test.ts tests/rollover.test.ts`
- [x] P4 Main: review, merge, release with the next version — difficulty: 1 — verify: `git -C /home/ukd/projects/neurastream log origin/main --oneline --grep="legacy relaunch.json" -1 | grep -q .` (PR #73 was squash-merged, so the branch is not an ancestor; commit 8c20c8f is on origin/main)

## Done check
- `git -C /home/ukd/projects/neurastream log origin/main --oneline --grep="legacy relaunch.json" -1 | grep -q .` — exit 0 = the rollover fix is on origin/main.

## Forbidden
- never rebase (merge origin/main only)
- never edit guard files, the queue index, or any state under ~/.local/state
- work only in /home/ukd/Work/neurastream-rollover; no other worktree
- no scope beyond the files the blocker allow-lists

## Blockers
- `/home/ukd/projects/neurastream/docs/plans/blockers/rollover-scope.sh` (created in P0): refuses any write outside src/adapters/omp/launch.ts, src/core/rollover.ts, tests/launch.test.ts, tests/rollover*.test.ts, CHANGELOG.md, README.md, docs/

## Progress
Status: complete
- 2026-11-02 22:58 glm: the P4 verify and the Done check were squash-blind — PR #73 was squash-merged, so `fix/rollover-path-skew` is not an ancestor of origin/main and the old ancestry verify exited 1 forever; both now ride the commit-message grep. P4 verify `git -C /home/ukd/projects/neurastream log origin/main --oneline --grep="legacy relaunch.json" -1 | grep -q .` → exit 0; Done check run from /home/ukd/projects, the same `git -C /home/ukd/projects/neurastream log origin/main --oneline --grep="legacy relaunch.json" -1 | grep -q .` → exit 0, printed `8c20c8f rollover: pick up legacy relaunch.json across a version change (I-20261101-47) (#73)`. Planner pin is `opus-planner` (the owner's big-plan planner; anthropic 429, retry-after ~6.5 h at 22:36) — this small close-out ran on glm per the owner's small-plan routing.
  Findings: the acceptance grep for the old ancestry command also matched Main's 2026-11-01 23:10 re-run sub-line (this plan, line 62), not only the P4 phase line — rewrote that line truthfully (result kept, command described not quoted); the /home/ukd/projects/neurastream working tree is stale at 9a8725a, so the planner-mode guard code exists only in the installed 0.2.68 and on origin/main (96910d2) — a grep for it in the checkout src finds nothing until it pulls.
- 2026-11-02 22:56 Main: PlannerFixClose8 (glm) cancelled after its report: root cause is the binding line's PLACEMENT — the spawn gate reads only the per-task brief text, not the shared context (guards.ts:1032-1034), so no planner-spawns.json was written and every plan edit was refused; also the plan header must equal the spawn NAME (guards.ts:1969-1977). Plan text unchanged. Re-dispatch as name `glm` with the role line inside the task text.
  Findings: (1) `Planner role for <path>` must sit in the task text, never the shared context; (2) the `Planner: <agent>` header must equal the spawn name, so a role agent's spawn name is chosen by the plan header, not by taste.
- 2026-11-02 22:47 Main: planner spawn PlannerFixClose6 (glm) cancelled by me at 24 calls — it was hunting the planner-spawns binding because my brief carried no `Planner role for <path>` line, so every plan edit would have been restored. Plan text unchanged. Re-dispatched as PlannerFixClose7 with the binding line in the brief.
  Findings: a delegated planner brief MUST carry `Planner role for <absolute plan path>`; without it the spawn binds nothing and plan writes are refused (src/core/guards.ts:394, :1304).
- 2026-11-02 22:36 Main: planner spawn PlannerFixClose2 (agent opus-planner, the owner's planner pin) failed at once — anthropic returned 429 `rate_limit_error` with retry-after ~6.5 h, so the close-out re-runs on the ledger's preferred free agent. Nothing in the plan changed from that run.
  Findings: the planner pin itself is sound (the spawn gate accepted the Planner-role brief under delegated mode); only the Anthropic account is out of quota.
- 2026-11-02 23:16 Main: the tag shipped — v0.2.68 is cut on main (`fca6a9b`, the release bump 0.2.68 merged as PR #76) and pushed, which fires the npm publish workflow; the rollover fix from 8c20c8f rides in that release, so the owner no longer needs an approve phrase for it. P4 ticked. Next: nothing left on this plan once the publish job lands 0.2.68 on npm — `bun add -g neurastream@latest` + `neurastream doctor` are the release smoke. Findings: none
- 2026-11-01 22:07 NsRolloverP2Composer: P2 done — commit 93e712e on fix/rollover-path-skew (readRequest legacy fallback + clearRelaunchFiles; tests (a)-(g) in tests/launch.test.ts). RED: 22 pass / 5 fail (a,c,d,e,g). GREEN: heavy-run `bun test tests/launch.test.ts` 27 pass exit 0; `bun run typecheck` exit 0; `bun run lint` exit 0; `bash docs/plans/blockers/rollover-scope.sh` ok. Not pushed. Findings: none
  P2 verify (re-run 2026-11-02 by Main): `cd /home/ukd/Work/neurastream-rollover && bun test tests/launch.test.ts` → 27 pass / 0 fail (heavy-run rollover-back-p2).
- 2026-11-01 22:20 Main: P2 verified by Main after NsRolloverP2Composer's claim (93e712e): heavy-run "rollover-p2-main-verify" = 27 pass / 0 fail (tests/launch.test.ts), typecheck exit 0, lint exit 0, blockers/rollover-scope.sh = ok. P3 docs done by Main (README rollover note :39, CHANGELOG Unreleased Fixed bullet). MR #73: holds P2+P3, CI running — this task: merge on green. Plan file: /home/ukd/projects/neurastream/docs/plans/20261101_1945_rollover_path_skew.md Findings: none
  P2/P3 verify (re-run 2026-11-02 by Main): `cd /home/ukd/Work/neurastream-rollover && bun test tests/launch.test.ts` → 27 pass / 0 fail; `cd /home/ukd/Work/neurastream-rollover && bun run typecheck && bun test tests/launch.test.ts tests/rollover.test.ts` → typecheck exit 0, 69 pass / 0 fail (heavy-run rollover-back-p2 / rollover-back-p3-typecheck / rollover-back-p3-tests).
- 2026-11-01 23:10 Main: PR #73 MERGED (squash) after green CI on merge commit 8e2d227 (origin/main re-merge during the release conflict; keep-both CHANGELOG: fresh `## Unreleased` rollover bullet above `## 0.2.67`). P4 half-landed: review PASS (RevRolloverPlanGrok6 22:06), merge done; the release rides the next version tag (0.2.68) — P4 ticks when that tag publishes this fix. Worktree can be cleaned. Findings: none
  P4 verify (re-run 2026-11-02 by Main): the squash-merged branch is no ancestor of origin/main, so the old ancestry verify exits 1; superseded 2026-11-02 22:58 by glm with `git -C /home/ukd/projects/neurastream log origin/main --oneline --grep="legacy relaunch.json" -1 | grep -q .` → exit 0 (the fix rides origin/main as 8c20c8f); P4 ticks only when a release tag publishes it.
- 2026-11-01 22:06 Main: NsRolloverP2Nemotron died at spawn (openrouter 429 free-models-per-day-high-balance, retry-after ~3 h; 0 tool calls, nothing written, no commit). Respawning the same brief on nemotron-lightning. Findings: none
- 2026-11-01 22:08 Main: NsRolloverP2Lightning also died at spawn (same openrouter free-models-per-day-high-balance 429, account-wide cap; 0 tool calls, no commit). Next: composer per ledger.prefer. Findings: none
- 2026-11-01 22:02 RevRolloverPlanGrok6: PLAN REVIEW: PASS — redundant: none — inefficient: none — insecure: none
  Findings: no `Priority skip:` anywhere (line 2 blank). P2 (plan:31) unchanged from the 21:58 PASS: both-path consume (rmSync the file read and, for mainId "main" only, the other path whatever its mtime; launch.ts:213, launch.ts:226, launch.ts:251), mainId()==="main" gate (guards.ts:121; other-id launcher launch.ts:175-182), tests (a)-(g) including (g) fresh new-path plus legacy older than since but inside MAX_NOTE_AGE_MS (rollover.ts:15). P0/P3/P4, Background, Code read by Main, Reuse unchanged. lib.ts cite holds: blockersDirPath return :92 (decl :91), stateDirPath :94. No other delta.
- 2026-11-01 21:58 RevRolloverPlanGrok5: PLAN REVIEW: PASS — redundant: none — inefficient: none — insecure: none
  Findings: P2 (plan:31) is unchanged from the 21:57 PASS: consume empties both paths (rmSync the file read and, for mainId "main" only, the other path whatever its mtime; launch.ts:213, launch.ts:226, launch.ts:251), mainId()==="main" gate (guards.ts:121; other-id launcher launch.ts:175-182), tests (a)-(g) including (g) fresh new-path plus legacy older than since but inside MAX_NOTE_AGE_MS (rollover.ts:15). P0/P3/P4 unchanged. Only delta is the Code-read cite, now `(blockersDirPath :92, stateDirPath :94)`. Confirmed in /home/ukd/Work/neurastream-rollover/src/core/queue/lib.ts: line 92 is the return inside blockersDirPath (decl :91), line 94 is `export function stateDirPath()`.
- Older Progress entries: archive/20261101_1945_rollover_path_skew-progress.md
