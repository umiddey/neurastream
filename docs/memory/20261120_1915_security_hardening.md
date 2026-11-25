# 20261120_1915_security_hardening
**Task**: Close security vulnerabilities in `owner-ui.ts` (`/knowledge/*` same-origin XSS), `pages.ts` (missing host/self-peer auth, same-origin HTML & SVG XSS / self-approval, malformed URI), and `blockers.ts` (quoted command bypass, incomplete mutator list, flag-prefixed `gh`/`glab` merge bypass)
**Status**: COMPLETE

## WHAT
- Plan created and revised after independent Plan Reviewer audit (all blockers & important findings incorporated) ✓
- Phase 1 (Sandbox `/knowledge/*` in `src/core/owner-ui.ts`) ✓
- Phase 2 (Harden `src/core/pages.ts` & `src/core/page-notes.ts`: auth, host allowlist, viewer-shell isolation, SVG CSP sandbox, HMAC tokens with normalized page names, duplicate-chrome stripping, URI safety) ✓
- Phase 3 (Close shell blocker bypasses in `src/core/blockers.ts`) ✓
- Implementation Reviewer fixes (scoped short prose flags in `src/core/blockers.ts`, HTML-escaped `urlPart` + `base-uri 'none'` CSP in `src/core/pages.ts`) ✓

## HOW
- Audited `src/core/owner-ui.ts`, `src/core/pages.ts`, `src/core/page-notes.ts`, `src/core/pages-setup.ts`, `src/core/blockers.ts`, and their test suites directly.
- Incorporated Plan Reviewer feedback: added `Content-Security-Policy: sandbox` for `.svg` assets, `stripInteractiveChrome` preserving `#ns-answered` on `/_raw/<name>`, `window.parent` guard for stub DOM tests, `normalizePageName` for HMAC token parity, strict `ev.source`/`ev.origin === "null"` `postMessage` validation, and `blockers.ts` edge cases (`--message="--no-verify"`, `git -C repo "tag"`, `git add "."`, `eval` parity).
- Phase 1: added `sandbox="allow-scripts"` to `<iframe class="knowframe">` in `knowledgeHtml()` and set `content-security-policy: sandbox allow-scripts` + `x-content-type-options: nosniff` on `GET /knowledge/<repo>/<topic>` in `src/core/owner-ui.ts`; updated and added security assertions in `tests/owner-ui.test.ts`. Verified with `bun test tests/owner-ui.test.ts tests/knowledge.test.ts` (135 pass, 0 fail).
- Phase 2: extended `hostAllowlist` in `src/core/owner-ui.ts` with `opts?: { allowLoopback?: boolean }`; added `stripInteractiveChrome` (preserving `#ns-answered`) and guarded `QUOTE_RELAY_SCRIPT` in `src/core/page-notes.ts`; cleanly reformatted and hardened `src/core/pages.ts` with `hostAllowlist`, `authenticate`, `originIsHost`, per-server HMAC-SHA256 `x-ns-token` bound to action + `normalizePageName(page)`, `URIError` -> 400 handling, `nosniff` on all responses, `Content-Security-Policy: sandbox` on `.svg`, `GET/HEAD /_raw/<name>` with `Content-Security-Policy: sandbox allow-scripts`, and a trusted nonce-CSP viewer shell with strict `ev.source === frame.contentWindow && ev.origin === "null"` message validation. Updated `tests/pages-cli.test.ts`, `tests/diagram-check.test.ts`, `tests/plan-approval.test.ts`, `tests/page-notes.test.ts`, and `tests/pages-server.test.ts` with comprehensive security E2E tests. Verified with `bun test tests/pages-server.test.ts tests/page-notes.test.ts tests/pages-cli.test.ts tests/diagram-check.test.ts tests/plan-approval.test.ts` (37 pass, 0 fail).
- Phase 3: replaced `seg.words.filter(w => !w.quoted)` in `src/core/blockers.ts` with `commandMatchText(seg)` preserving resolved command heads, subcommands (skipping global value options + emitting canonical form so `gi\t -C repo "tag" v1` matches `git\s+tag`), non-prose flags, `git add` single-token pathspecs (`"."`), and unquoted words while excluding prose flags/values (`-m`, `--message=*`, `-m*`, `--grep`, `-F`, `-am`). Expanded `MUTATING_NAMES`, `GIT_MUTATING`, destination-last commands (`cp`/`ln`/`install`/`rsync` with `-t`/`--target-directory`), `dd` (`of=`), `curl -o`/`wget -O`, `tar -x -C`, `CODE_MUTATING`, and added backtick splitting to `evalPaths` so `Bun.$\`...\`` targets resolve cleanly. Added `cliSubcommands` for flag-skipping `gh`/`glab` merge detection in both `bash` and `eval` paths. Added comprehensive regression tests in `tests/blockers-shell.test.ts`.
- Full verification:
  - `bun run typecheck` → exit 0
  - `bun run lint` → exit 0 (0 warnings, 0 errors across 322 files)
  - `bun test tests/owner-ui.test.ts tests/knowledge.test.ts tests/pages-server.test.ts tests/page-notes.test.ts tests/pages-cli.test.ts tests/diagram-check.test.ts tests/plan-approval.test.ts tests/blockers-shell.test.ts tests/host-neutral.test.ts tests/no-personal-markers.test.ts` → 210 pass, 0 fail
  - `bun test tests/guards.test.ts tests/guards-omp.test.ts tests/notes-check.test.ts tests/plan-page-template.test.ts tests/team-server.test.ts` + `bun test --timeout 15000 tests/golden/ports-p4.test.ts` → 91 pass, 0 fail
  - `bun test tests/tailnet-rebind.test.ts` → 5/6 pass inside sandbox; 1 pre-existing test (`freePort()` immediate `Bun.serve` stop+rebind of same ephemeral port) fails with EADDRINUSE inside the Linux sandbox (reproduced with a standalone 1-line `bun -e` with zero project code).

- Review fixes (post-Implementation Reviewer audit):
  - Scoped short prose flags (`-m`, `/^-[a-zA-Z]*m$/`, `/^-[a-zA-Z]*m.+$/`, `-F`, `/^-F.+$/`) strictly to `git` message subcommands (`commit`, `tag`, `merge`, `notes`, `stash`, `revert`) and kept the prose flag token itself in `keptIndices` while skipping only the prose value, so `python3 -m pip install foo`, `python -m http.server`, `git branch -m main`, and `find . -maxdepth 1 -delete` are all matched properly while `git commit` prose exclusions stay intact.
  - Wrapped `urlPart(...)` in `esc(...)` inside `src="/_raw/..."` and directory listing `href="/..."` in `src/core/pages.ts`, and added `base-uri 'none';` to the viewer-shell and directory-listing CSP headers.
  - Added regression tests in `tests/blockers-shell.test.ts` and `tests/pages-server.test.ts`.
  - Re-verified: `bun run typecheck` → exit 0; `bun run lint` → exit 0 (0 warnings, 0 errors across 343 files); `bun test tests/blockers-shell.test.ts tests/pages-server.test.ts tests/page-notes.test.ts tests/host-neutral.test.ts tests/no-personal-markers.test.ts` → 53 pass, 0 fail (251 expects).

## WHY
- A full codebase review found that untrusted repo HTML in `/knowledge/*` and published HTML/SVG on `pages.ts` execute JavaScript on the same origin as privileged guardrail routes (`/unlock`, `/tier`, `/_approve`, `/_notes`), and that `pages.ts` fails to reject local loopback / own-tailnet-IP peers or validate the `Host` header.
- Additionally, `denyCommand` in `blockers.ts` drops quoted words (allowing `'rm'` or `"npm" publish`), `denyPath` misses common file-mutating commands (`ln`, `dd`, `chmod`, `curl -o`, `git reset/clean`), and `noPush` misses `gh -R owner/repo pr merge`.

## FILES MODIFIED
- `docs/plans/immediate/20261120_1915_security_hardening.md`: marked all 3 phases and plan COMPLETE with verification results
- `docs/memory/20261120_1915_security_hardening.md`: updated to COMPLETE with full verification log
- `src/core/owner-ui.ts`: sandboxed `/knowledge/*` iframe, added CSP sandbox + nosniff headers, extended `hostAllowlist` with `allowLoopback`
- `src/core/page-notes.ts`: exported `stripInteractiveChrome` (preserving `#ns-answered`) and guarded `QUOTE_RELAY_SCRIPT`
- `src/core/pages.ts`: reformatted and hardened with `hostAllowlist`, `authenticate`, `originIsHost`, HMAC-SHA256 `x-ns-token`, `URIError` -> 400, `.svg` sandbox CSP, `/_raw/<name>` sandbox isolation, and trusted nonce-CSP viewer shell
- `src/core/blockers.ts`: added `commandMatchText` (quoted command/subcommand/flag/pathspec matching + prose exclusions), expanded mutators (`MUTATING_NAMES`, `GIT_MUTATING`, `destLastTargets`, `dd`, `downloadTargets`, `tarExtractTargets`, `CODE_MUTATING`, backtick splitting in `evalPaths`), and flag-skipping `cliSubcommands` for `gh`/`glab` merges in bash and eval
- `tests/owner-ui.test.ts`: verified `/knowledge/*` iframe sandbox and response security headers
- `tests/pages-server.test.ts`, `tests/page-notes.test.ts`, `tests/pages-cli.test.ts`, `tests/diagram-check.test.ts`, `tests/plan-approval.test.ts`: updated loopback fixtures / action tokens and added Phase 2 security E2E tests
- `tests/blockers-shell.test.ts`: added Phase 3 regression tests for quoted commands/flags, prose exclusions, expanded mutators, `eval` parity, and flag-prefixed `gh`/`glab` merges

## NEXT SESSION
- Re-verify with Implementation Reviewer for final PASS; run `tests/tailnet-rebind.test.ts` outside sandbox if full socket-rebind confirmation is desired.

## REFERENCES
- Plan: `docs/plans/immediate/20261120_1915_security_hardening.md`
- Key files: `src/core/owner-ui.ts`, `src/core/pages.ts`, `src/core/page-notes.ts`, `src/core/blockers.ts`
