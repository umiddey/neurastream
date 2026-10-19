# neurastream: publish to npm, keep it in sync, run our own setup from the npm package
Worktree: /home/ukd/Work/neurastream-publish
Branch: feat/publish-cutover
PRIORITY-ID:

## Goal
- Owner (2026-10-19): "Maybe also publish the Neura stream. By the way, every time we make a change to any of our scripts, it should also change in Neura stream. In fact, I think we should probably use the npm version ourselves."
- Owner's choices (2026-10-19): publish from GitHub Actions, the same way Gateforge publishes (npm trusted publishing over OIDC, no NPM_TOKEN; owner already has an npm account); the live cutover happens only after PM MR !197 merges.
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
- [ ] P1 Port the live changes made since the package was built (details: Background "P1"). Diff every in-scope live file (docs/inventory.md) against its port; port each behaviour change with a test; record every file compared + result in Progress — difficulty: 3 — verify: `cd /home/ukd/Work/neurastream-publish && bun run typecheck && bun test`
- [ ] P2 `neurastream doctor` + "Changing a script" README section (details: Background "P2") — difficulty: 3 — verify: `cd /home/ukd/Work/neurastream-publish && bun run typecheck && bun test`
- [ ] P3 Publish + CI workflows, package.json 0.1.0 publish fields, sandbox install smoke (details: Background "P3") — difficulty: 2 — verify: `cd /home/ukd/Work/neurastream-publish && bun run typecheck && bun test && npm pack --dry-run >/dev/null`
- [ ] P4 `scripts/cutover.sh` + `scripts/rollback.sh` + `scripts/cutover-sandbox-test.sh`, tested only in sandbox HOMEs; Main runs the real cutover after MR !197 merges (details: Background "P4") — difficulty: 4 — verify: `cd /home/ukd/Work/neurastream-publish && bun test && HOME=/tmp/neurastream-home-cut bash scripts/cutover-sandbox-test.sh`

## Done check
`cd /home/ukd/Work/neurastream-publish && git fetch -q origin && git merge-base --is-ancestor HEAD origin/main && bun run typecheck && bun test && test "$(npm view neurastream version)" = "$(node -p "require('./package.json').version")" && neurastream doctor`

## Progress
Status: open
- 2026-10-19 10:40 (Main): owner: "i have an npm acc already". Gateforge publishes with npm trusted publishing (OIDC, no token; /home/ukd/Work/gf-declared-delete/.github/workflows/publish.yml:1-30), so this plan does the same: no NPM_TOKEN secret. Bootstrap: npm only lets a package get a trusted publisher once it exists, so 0.1.0 is published once by hand (owner `npm login`, then Main `npm publish --access public` from the verified tarball), then the owner registers umiddey/neurastream + publish.yml as Trusted Publisher on npmjs.com; every later `v*` tag publishes from Actions.
- 2026-10-19 10:20 (Main): plan written from the owner's message and his two answers (Actions publish; cutover after !197). Base: origin/main 316befc (feat/package merged and pushed by Main). Live drift since the port: only /home/ukd/.local/bin/queue-close (mtime 2026-10-19 10:09); all other in-scope live files predate the 2026-10-18 23:07 port start (Main's `ls -l`). P1 still compares every file, not just this one.

## Background
- Previous plan (complete): docs/plans/20261018_2306_neurastream_package.md; inventory in docs/inventory.md, smoke transcript in docs/smoke.md.
- Gateforge publishes the same way: /home/ukd/Work/gf-declared-delete/.github/workflows/publish.yml (read it for the pattern; don't copy its secrets names blindly).
- P1: known change = /home/ukd/.local/bin/queue-close `squashMerged()` + `contains()` + `declaredLanded()` (owner-approved 2026-10-19). (c) a branch is landed if merging it into one of base's first-parent commits since the fork point (max 200) is clean and yields exactly that commit's tree (`git merge-tree --write-tree`). (d) a plan line `Landed: <commit on base> from <pre-squash commit>` (optional `- ` bullet) counts only if the first is on base, the branch tip is in the second's history, and the first already contains the second. Tests on temp git repos: release squash with a later edit closes via (c); stacked branch closes only via (d); unmerged branch with new content fails (c) and (d); forged Landed line whose pre-squash commit lacks the branch fails.
- P2: for every live file the omp adapter installs (bins, extensions, queue lib, templates) report whether it is the installed package's copy/launcher, and whether the installed version equals `npm view neurastream version` (offline = warning). Exit 1 lists each hand-edited/foreign file and a stale version. The core `main-start` runs doctor and prints the result. README "Changing a script": edit in this repo → test → Main tags → publish workflow → `bun add -g neurastream@latest` + `neurastream adapter install omp`; live copies are never hand-edited. Tests (sandbox HOMEs): clean install → 0; one edited bin → 1 naming it; older installed version → 1.
- P3: `.github/workflows/publish.yml` on tags `v*`, modelled on /home/ukd/Work/gf-declared-delete/.github/workflows/publish.yml (trusted publishing: `permissions: id-token: write`, setup-node with registry-url, npm pinned to a version that supports OIDC publish, NO NPM_TOKEN / NODE_AUTH_TOKEN secret): bun install --frozen-lockfile; typecheck + test; fail if tag ≠ `v`+package.json version; `npm publish --access public --provenance`. Header comment explains the one-time bootstrap (first version by hand, then Trusted Publisher on npmjs.com). `.github/workflows/ci.yml`: typecheck + test on push/PR. package.json: version 0.1.0, `files` (runtime only: src, bin, templates, blockers, README; no docs/plans, tests, unused scripts), repository, license, publishConfig.access=public. Progress bullet lists `npm pack --dry-run` contents: no plans, INDEX.md, secrets or `/home/ukd`. Sandbox smoke: tarball → `HOME=/tmp/neurastream-home-pub bun add -g ./neurastream-0.1.0.tgz` → init → adapter install omp → queue-check 0 → doctor 0.
- P4: cutover.sh: (1) capture outputs of queue-check, agent-ledger --cap, brief-lint <open plan>, main-start; (2) tar every live file it replaces to `~/.local/state/neurastream/cutover-<date>.tar`, print path; (3) `bun add -g neurastream@<version>`; (4) `neurastream init` keeping INDEX.md, notes, queue state, config = today's values; (5) `neurastream adapter install omp`; (6) rerun the captures and diff; any diff or non-zero exit → rollback.sh automatically. rollback.sh restores the tar byte-for-byte. cutover-sandbox-test.sh builds a fake "today" HOME from copies of the live layout (no secrets, no sessions): cutover → same outputs; a broken bin → rollback, tree hash equals the pre-cutover hash.
