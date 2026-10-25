# neurastream: pin GitHub Actions to commit SHAs + 7-day release cooldown
Worktree: /home/ukd/Work/neurastream-sc-pins
Branch: sec/supply-chain-pins

## Goal
- Owner (2026-10-22 ~15:20, after the LiteLLM incident): supply-chain audit of all our repos, then plan the fixes. Findings: /home/ukd/Work/cp-sec-audit/docs/security/SUPPLY_CHAIN_20261022.md (SC-6 no release cooldown, SC-9 Actions pinned by tag in the `id-token: write` publish job).
- When done: every `uses:` in `.github/workflows/*.yml` is pinned to a full 40-hex commit SHA with the tag as a trailing comment, and `bunfig.toml` sets `[install] minimumReleaseAge = 604800` (7 days), so a freshly hijacked release cannot reach the npm publish job or a local install.

## Forbidden
- Never push, tag, publish, or open a PR; never bump the version. Commit only on sec/supply-chain-pins, files added by name; never `git add -A`/`git add .`; never `--no-verify`.
- Changing anything other than `.github/workflows/ci.yml`, `.github/workflows/publish.yml`, `bunfig.toml` (new), `CHANGELOG.md` (one Unreleased line).
- Using a SHA that Main did not list below without re-resolving it yourself with `git ls-remote https://github.com/<owner>/<repo> 'refs/tags/<tag>^{}'` (the peeled `^{}` line; the plain tag line of an annotated tag is the tag object, not the commit).
- Every `bun test`/typecheck run goes through `/home/ukd/Work/heavy-run.sh <agent> "<label>" -- <cmd>` with tool timeout 0, in the FOREGROUND. Probe one test file (`bun test tests/init.test.ts`) before the full suite.
- `find` is broken: use grep/glob/read. One failed tool call is never a blocker; try two other ways.
- Claim rule: report only what you ran and saw (label + exit code + log path).
- Call budget: stop and report within ~100 tool calls per run (warning at 90, hard stop at 100). Commit each green unit immediately. You cannot write this plan file; put your progress in your final answer.
- Read /home/ukd/projects/opus-implementer-method.md first and work by it.
- Editing anything under /home/ukd/.omp/agent/, /home/ukd/.local/bin/, /home/ukd/.local/state/, /home/ukd/.config/.
- STOP and report if a pinned SHA does not resolve, or if `bun install --frozen-lockfile` fails with the cooldown set.

## Blockers
- no-push
- deny-path /home/ukd/.omp/agent/** /home/ukd/.local/bin/** /home/ukd/.local/state/** /home/ukd/.config/** /home/ukd/.npmrc INDEX.md docs/plans/**
- deny-command npm\s+publish bun\s+publish npm\s+link git\s+tag --no-verify git\s+add\s+(-A|--all|\.)

## Phases
- [x] P1 Pin all 5 `uses:` lines to SHAs, keeping the tag as a comment, e.g. `uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4`. SHAs Main resolved 2026-10-22 (peeled): actions/checkout v4 `11d5960a326750d5838078e36cf38b85af677262`, oven-sh/setup-bun v2 `0c5077e51419868618aeaa5fe8019c62421857d6`, actions/setup-node v4 `49933ea5288caeca8642d1e84afbd3f7d6820020` — difficulty: 1 — verify: `! grep -rhE '^\s*-?\s*uses:' .github/workflows | grep -vE '@[0-9a-f]{40} # '`
- [x] P2 New `bunfig.toml` with `[install]` `minimumReleaseAge = 604800`; one CHANGELOG Unreleased line for P1+P2 — difficulty: 1 — verify: `heavy-run.sh <agent> "ns sc install" -- bun install --frozen-lockfile` exit 0, then `heavy-run.sh <agent> "ns sc typecheck+test" -- bash -c 'bun run typecheck && bun test'` exit 0

## Done check
`! grep -rhE '^\s*-?\s*uses:' .github/workflows | grep -vE '@[0-9a-f]{40} # ' && grep -qE '^minimumReleaseAge\s*=\s*604800' bunfig.toml && bun install --frozen-lockfile && bun run typecheck && bun test`

## Code read by Main
- `/home/ukd/Work/neurastream-sc-pins/.github/workflows/ci.yml`
- `/home/ukd/Work/neurastream-sc-pins/.github/workflows/publish.yml`
- `/home/ukd/Work/neurastream-sc-pins/package.json`
- `/home/ukd/Work/neurastream-sc-pins/AGENTS.md`

## Progress
Status: complete
- 2026-10-22 17:0x Main: CI 39800033390 green; fast-forwarded into main and scored.
- 2026-10-22 16:5x Main: NsScPinsGlm's work is reviewed. All 5 `uses:` lines are pinned to the given SHAs and `bunfig.toml` has `minimumReleaseAge = 604800`. Main rebased the branch onto 0.1.12 (907e462); the only conflict was CHANGELOG, resolved as Unreleased above 0.1.12. The commits are now f4ba1f6 (P1) and 05bf999 (P2). In the worktree: install frozen OK, typecheck exit 0, `bun test` 175/0. Branch pushed; CI run 39800033390. No npm release is needed, since `bunfig.toml` and the workflows are not in package `files`. Follow-up seen by the worker: `tests/golden/ports-p4.test.ts` priority-watch fails when a run crosses a minute tick (oracle and port both print HH:MM). Needs a separate small fix that normalizes the clock in the comparison.
- 2026-10-22 17:4x Main: worktree /home/ukd/Work/neurastream-sc-pins on sec/supply-chain-pins from origin/main e38ff1d. Local bun 1.3.14 has `--minimum-release-age` (seconds), so bunfig `minimumReleaseAge` is supported. neurastream has only devDependencies (@types/bun, typescript); the cooldown guards future adds and the publish job's `bun install`. After merge Main releases per the neurastream flow (tag → OIDC publish → `bun add -g neurastream@latest` → `neurastream doctor`).

## Background
- LiteLLM (2026): the PyPI artifact differed from git and carried a `.pth` stealer; tag-pinned Actions in an `id-token: write` job let a moved tag run attacker code with publish rights. SHA pins make a tag move inert; a 7-day cooldown lets the community catch a bad release before we install it.
