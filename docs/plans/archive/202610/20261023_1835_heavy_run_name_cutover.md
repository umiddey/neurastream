# Finish the heavy-run.sh → heavy-run cutover (release 0.1.25)

Status: complete
Priority: high
Difficulty: 2

INCIDENT I-20261023-18 follow-up (same-day discovery while closing that plan).

## Goal
No shipped or live artifact may reference the retired name or run heavy-run via a shell prefix: the bin is a **bun** script (`#!/usr/bin/env bun`), so `bash ~/.local/bin/heavy-run …` makes bash execute the `import { basename }` line as the ImageMagick `import` command — mouse-grab hang (killed two queue-close done checks at 420s/900s today; `bash ~/.local/bin/heavy-run.sh …` is exit 127, that file no longer exists).
Correct form everywhere: `~/.local/bin/heavy-run <who> <what> -- <command...>` — never a `bash` prefix, and args without `<who> <what> --` print usage and exit 2.

## Forbidden
- Never push or merge; commit and report.
- No behavior changes to the lock/owner/log logic in `src/core/heavy-run.ts` beyond the name/marker fixes and the P3 usage line.
- No new dependencies.

## Blockers
- blockers/no-bash-heavyrun.sh (guard semantics: only files BOTH changed vs origin/main AND in the scan set are checked — green on a pristine tree, red the moment a changed file carries the retired name or a shell-invoked heavy-run; the strict whole-tree grep lives in the Done check)

## Phases
- [ ] P1 Ship-side rename in `templates/config.yml`: the brief marker key (line 54, currently the retired name with `.sh`) → `heavy-run`; the path key (line 60, currently `$HOME/.local/bin/` + retired name) → `$HOME/.local/bin/heavy-run`. Then grep the whole shipped set + `docs/` for the retired name and for `bash ~/.local/bin/heavy-run` and fix every hit. verify: `! grep -rn "heavy-run\.sh\|bash .*heavy-run" src bin templates blockers README.md docs/`
- [ ] P2 Brief-lint guard: add a generic rule in `src/core/brief-lint.ts` that flags `bash <path>heavy-run` and any heavy-run mention NOT followed by `<who> <what> --` on the same line; the message shows the correct form. verify: `bun test` (new cases red-first on pristine, then green)
- [ ] P3 heavy-run UX: when args do not match `<who> <what> -- <cmd>`, print a correct-form example line before exiting 2. verify: `~/.local/bin/heavy-run bun test; test $? -eq 2` prints usage WITH example and never hangs
- [ ] P4 Test: `tests/heavy-run-name.test.ts` — asserts the shipped brief marker equals `heavy-run`, the Phase-0 blocker passes on the patched tree, and (unit) `heavyRun(["bun","test"], cfg)` returns 2 with the example in stderr. verify: `bun test tests/heavy-run-name.test.ts && bun run typecheck`

Call budget: stop and report within ~60 calls. Suite runs: `~/.local/bin/heavy-run <agent> <phase> -- bun test`.

## Done check
```bash
cd /home/ukd/projects/neurastream && bash docs/plans/blockers/no-bash-heavyrun.sh \
  && ! grep -rnE 'heavy-run\.sh|bash +[^ ]*heavy-run' src bin templates blockers README.md docs/config.md docs/visual \
  && bun run typecheck && ~/.local/bin/heavy-run main done-check -- bun test \
  && echo HEAVYRUN-CUTOVER-DONE
```

## Code read by Main
- `/home/ukd/.bun/install/global/node_modules/neurastream/bin/heavy-run` (bun shebang; the `import { basename }` line 2 is the ImageMagick bait; identical to `~/.local/bin/heavy-run` via symlink)
- `/home/ukd/projects/neurastream/src/core/heavy-run.ts` (flock lock/owner/log; the `<who> <what> -- <cmd>` contract and usage-exit-2 at lines 26-28)
- `/home/ukd/projects/neurastream/templates/config.yml` (lines 54 and 60 still carry the retired name — verified 2026-10-23 18:3x; lines 17-20 heavy lock/owner/log paths already use the bare name)
- `/home/ukd/projects/neurastream/docs/config.md` (lines 89 and 95 mirror the retired marker/path — verified by grep)
- `/home/ukd/projects/neurastream/README.md` (tool list lines 32/62 use the bare name — clean)

## Background
- Live evidence 2026-10-23: two queue-close done checks hung after `tsc --noEmit` (420s and 900s bash timeouts, both killed); direct repro `timeout 40 bash ~/.local/bin/heavy-run bun test` produced ImageMagick mouse-grab spam and exit 124; the correct form ran the full suite 321 pass / 0 fail in 77s.

## Progress
- 2026-10-23 queue-close: done check failed (exit 1); reopened.

Status: complete
- 2026-10-23 18:3x Main: plan written after the hung closes; the scrub plan's own Done check line was fixed separately (correct form, suite verified green) — not this plan's scope.
- 2026-10-23 22:xx Main: shipped in 0.1.25 (fc6c371 P9 default heavy_marker/heavy_path = `heavy-run`); blocker clean, retired-name grep empty on origin/main 0a7d912.
- 2026-10-23 22:xx Main: close refused only by the TZ-dependent quota-reset golden test (357 pass / 1 fail); open until plan 20261023_2215_quota_reset_zone_abbrev lands, then close.
- 2026-10-23 23:1x Main: blocking test fixed in 0.1.26 (1906ec5); full suite 361 pass / 0 fail on main. Live config heavy_marker/heavy_path also moved to `heavy-run` / `$HOME/.local/bin/heavy-run`.
