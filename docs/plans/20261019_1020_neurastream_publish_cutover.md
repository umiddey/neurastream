# neurastream: publish to npm, keep it in sync, run our own setup from the npm package
Worktree: /home/ukd/Work/neurastream-publish
Branch: feat/publish-cutover
PRIORITY-ID:

## Goal
- Owner (2026-10-19): "Maybe also publish the Neura stream. By the way, every time we make a change to any of our scripts, it should also change in Neura stream. In fact, I think we should probably use the npm version ourselves."
- Owner's choices (2026-10-19): publish from GitHub Actions with an `NPM_TOKEN` repo secret, the same way Gateforge publishes; the live cutover happens only after PM MR !197 merges.
- Done = `neurastream` is on npm (published by a tag-triggered workflow), it has every live script change made since the port, and the live setup runs from the installed npm package with a tested rollback. Once that's done, a change to any orchestration script is made in this repo and released; a hand-edit to a live copy is reported by `neurastream doctor`.

## Forbidden
- Read /home/ukd/projects/opus-implementer-method.md first and work by it. `find` is broken: use grep/glob/read.
- Read /home/ukd/projects/neurastream/AGENTS.md first; its rules apply (core/adapter split is a hard rule).
- Never push, never tag, never publish (`npm publish`, `bun publish`). Main pushes and tags. Never `--no-verify`, never bypass a guard.
- Never link or install the package into the real HOME; every smoke uses `HOME=/tmp/neurastream-home-<name>`.
- Live setup is READ ONLY: /home/ukd/.omp/agent, /home/ukd/.local/bin, /home/ukd/.local/state. Never edit, move or delete anything there. The cutover itself (P4) is Main's step, not yours.
- Never read or copy secrets: /home/ukd/.config/gateforge/**, any `*.env*`, `*keys*.txt`, `mcp.json`, keyrings, `~/.npmrc`.
- Tests and builds run through `/home/ukd/Work/heavy-run.sh <Agent> "<label>" -- <cmd>` with timeout 0; check the exit code it prints directly.
- Claim rule: every "passes"/"done" in your Progress bullet names the command and its result as you saw it; anything you didn't run is written "unverified".
- Budget: stop within ~100 tool calls. Progress bullet by call 85: done, verified (command + result), commits, "Gate missing before -> after: n/a", next step.
- No questions at the end: decide by these rules and record the decision.

## Blockers
- no-push
- deny-path /home/ukd/.omp/agent/** /home/ukd/.local/bin/** /home/ukd/.local/state/** /home/ukd/.config/** /home/ukd/.npmrc INDEX.md
- deny-command npm\s+publish bun\s+publish npm\s+link git\s+tag ^(?!.*HOME=/tmp/neurastream-home).*bun\s+(link|add\s+-g) ^(?!.*HOME=/tmp/neurastream-home).*omp\s+(plugin\s+)?(install|link) --no-verify git\s+add\s+(-A|--all|\.)(\s|$)

## Phases
- [ ] P1 Port the live changes made since the package was built. Diff every in-scope live file (list: docs/inventory.md) against its port, and port each behaviour change with a golden or unit test. Known change: /home/ukd/.local/bin/queue-close `squashMerged()` + `contains()` + `declaredLanded()` (owner-approved 2026-10-19):
  - (c) a branch counts as landed if merging it into one of base's first-parent commits since the fork point (max 200) is clean and yields exactly that commit's tree (`git merge-tree --write-tree`);
  - (d) a plan line `Landed: <commit on base> from <pre-squash commit>` (optionally a `- ` bullet) counts only if: the first commit is on base, the branch tip is in the second's history, and the first already contains the second.
  - Tests, each on a temp git repo: a release squash with a later edit closes through (c); a stacked branch closes only through (d); an unmerged branch with new content fails (c) and (d); a forged Landed line whose pre-squash commit doesn't contain the branch fails.
  - Record each live file compared and the result in your Progress bullet.
  - difficulty: 3 — verify: `cd /home/ukd/Work/neurastream-publish && bun run typecheck && bun test`
- [ ] P2 `neurastream doctor`. For every live file the omp adapter installs (bins, extensions, queue lib, templates), report whether it is the installed package's copy or launcher, and whether the installed version equals the latest version on npm (`npm view neurastream version`; offline = warning, not failure).
  - Exit 1 lists each hand-edited or foreign file, plus a stale installed version.
  - `main-start` (core port) runs doctor and prints its result.
  - The README gets a "Changing a script" section: edit in this repo → test → Main tags → publish workflow → `neurastream update` (or `bun add -g neurastream@latest` + `neurastream adapter install omp`); live copies are never hand-edited.
  - Tests use sandbox HOMEs: clean install → 0; one edited bin → 1 naming it; older installed version → 1.
  - difficulty: 3 — verify: `cd /home/ukd/Work/neurastream-publish && bun run typecheck && bun test`
- [ ] P3 Publish workflow. `.github/workflows/publish.yml` on tags `v*`:
  1. bun install --frozen-lockfile;
  2. typecheck + test;
  3. fail if the tag ≠ `v` + package.json version;
  4. `npm publish --access public --provenance` with `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}`.

  Set package.json `version` to `0.1.0`, `files` (only what the package needs: src, bin, templates, blockers, README; no docs/plans, tests, scripts unless used at runtime), `repository`, `license`, `publishConfig.access=public`. Add `.github/workflows/ci.yml` (typecheck + test on push/PR). `npm pack --dry-run` content list goes in your Progress bullet: no plans, no INDEX.md, no secrets, no `/home/ukd` paths.
  - Sandbox smoke: tarball → `HOME=/tmp/neurastream-home-pub bun add -g ./neurastream-0.1.0.tgz` → `neurastream init` → `neurastream adapter install omp` → `queue-check` exit 0 → `neurastream doctor` exit 0.
  - difficulty: 2 — verify: `cd /home/ukd/Work/neurastream-publish && bun run typecheck && bun test && npm pack --dry-run >/dev/null`
- [ ] P4 Cutover scripts, tested only in sandbox HOMEs: `scripts/cutover.sh` and `scripts/rollback.sh`.
  - **cutover.sh:**
    1. Back up every live file it will replace into `~/.local/state/neurastream/cutover-<date>.tar` and print the path.
    2. `bun add -g neurastream@<version>`.
    3. `neurastream init`: keep the existing INDEX.md, notes and queue state; write config.yml with today's values.
    4. `neurastream adapter install omp`.
    5. Run queue-check, agent-ledger --cap, brief-lint on an open plan, and main-start, and diff their output against a capture taken before step 1.
    6. Any difference or non-zero exit → rollback automatically.
  - **rollback.sh:** restores the tar byte-for-byte.
  - Sandbox test: build a fake "today" HOME from copies of the live layout (no secrets, no sessions), run cutover → same outputs; break one bin → cutover rolls back and the tree hash equals the pre-cutover hash.
  - Main runs the real cutover after MR !197 merges.
  - difficulty: 4 — verify: `cd /home/ukd/Work/neurastream-publish && bun test && HOME=/tmp/neurastream-home-cut bash scripts/cutover-sandbox-test.sh`

## Done check
`cd /home/ukd/Work/neurastream-publish && git fetch -q origin && git merge-base --is-ancestor HEAD origin/main && bun run typecheck && bun test && test "$(npm view neurastream version)" = "$(node -p "require('./package.json').version")" && neurastream doctor`

## Progress
Status: open
- 2026-10-19 10:20 (Main): plan written from the owner's message and his two answers (Actions + NPM_TOKEN; cutover after !197). Base: origin/main 316befc (feat/package merged and pushed by Main). Owner prerequisite before Main tags v0.1.0: `gh secret set NPM_TOKEN -R umiddey/neurastream`. Live drift since the port: only /home/ukd/.local/bin/queue-close (mtime 2026-10-19 10:09); all other in-scope live files predate the 2026-10-18 23:07 port start (Main's `ls -l`). P1 still compares every file, not just this one.

## Background
- Previous plan (complete): docs/plans/20261018_2306_neurastream_package.md; inventory in docs/inventory.md, smoke transcript in docs/smoke.md.
- Gateforge publishes the same way: /home/ukd/Work/gf-declared-delete/.github/workflows/publish.yml (read it for the pattern; don't copy its secrets names blindly).
