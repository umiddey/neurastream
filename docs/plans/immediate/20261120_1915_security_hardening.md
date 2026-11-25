# Plan: Security Hardening (Owner UI, Pages Server, Shell Blockers)

**Status**: COMPLETE
**Created**: 2026-11-20 19:15
**Revised**: 2026-11-20 19:30 (incorporated Plan Reviewer findings)
**Mapped Memory**: `docs/memory/20261120_1915_security_hardening.md`

## Thought Process & Context

During a full codebase review of `neurastream` (v0.3.20), we audited the HTTP servers (`src/core/owner-ui.ts`, `src/core/pages.ts`, `src/core/team-server.ts`) and the shell blocker engine (`src/core/blockers.ts`). While `team-server.ts` and most of `owner-ui.ts` have solid defenses (Tailscale peer verification, `hostAllowlist` DNS-rebinding guard, strict `Origin` checks, CSP nonces), three high-severity security gaps defeat the guardrail trust boundary:

1. **Same-Origin Untrusted HTML Execution in `owner-ui.ts`**:
   - `GET /knowledge/<repo>/<topic>` (`src/core/owner-ui.ts:2065-2073`) serves raw HTML from `<repo>/docs/knowledge/*.html` with `Content-Type: text/html; charset=utf-8`, zero `Content-Security-Policy` header, and on the **same origin** as `POST /unlock`, `POST /tier`, `POST /message`, and `POST /reorder`.
   - The `<iframe>` in `knowledgeHtml()` (`src/core/owner-ui.ts:1112`) has no `sandbox` attribute.
   - Any repo under `knowledge.roots` (or an agent writing `docs/knowledge/*.html`) can execute `fetch('/unlock', { method: 'POST', ... })` or `fetch('/tier', { method: 'POST', body: 'tier=full' })` when the owner opens it. The browser attaches matching `Host` and `Origin` headers automatically, bypassing owner auth and disabling all guardrails.

2. **Broken Auth, Local Self-Approval, Same-Origin HTML & SVG XSS, and Missing Host Check in `pages.ts`**:
   - `startPagesServer()` (`src/core/pages.ts:24-25`) does **not** reject `peer === tailscale.ip4()` and unconditionally allows `isLoopback(peer)` without checking `cfg.workspace.allow_this_machine`. Because `tailscale whois <own-ip>` returns `owner_login`, Main or any local subagent can `curl -X POST -H "Origin: http://<tailnet-ip>:<port>" "http://<tailnet-ip>:<port>/_approve?page=..."` and self-approve its own plans or forge owner notes via `/_notes`.
   - `pages.ts` checks `Origin === http://${Host}` (`pages.ts:35,57`) without validating `Host` against `hostAllowlist()`, leaving it open to DNS rebinding.
   - Any HTML page published to `pages` (including non-plan HTML pages not validated by `assertDrilldown`, or arbitrary JS placed in `/* === DATA === */` on plan pages) AND any `.svg` file (`pages.ts:13,82-83`, served as `image/svg+xml` with no CSP) runs scripts on the **same origin** as `POST /_approve` and `POST /_notes`, allowing an untrusted published file to approve plans or scrape tokens when opened by the owner.
   - `decodeURI(url.pathname.slice(1))` (`pages.ts:69`) throws an uncaught `URIError` on malformed percent-encoding. Also `pages.ts` is formatted in compressed 1-space style unlike the rest of the repo.

3. **Shell Blocker Bypasses in `blockers.ts`**:
   - `denyCommand()` (`src/core/blockers.ts:590`) filters out every quoted word (`seg.words.filter(w => !w.quoted)`). Running `'rm' -rf ...`, `"curl" ...`, `np\m publish`, `git -C repo "tag" v1`, `git add "."`, or `git commit "--no-verify" -m x` sets `quoted: true` and bypasses `deny-command` completely, while legitimate tests require quoted prose arguments like `git commit -m "tag the release: git tag later"`, `git commit --message="--no-verify"`, and heredoc bodies to remain allowed.
   - `denyPath()` (`src/core/blockers.ts:413-513`) has a narrow `MUTATING_NAMES` list (`rm`, `mv`, `truncate`, `tee`, `patch`) and misses common mutating commands (`ln`, `dd`, `chmod`, `chown`, `touch`, `mkdir`, `rmdir`, `unlink`, `install`, `rsync`, `tar -x -C <dir>`, `curl -o`, `wget -O`, and `git reset/clean/merge/rebase/cherry-pick`), and `CODE_MUTATING` (`blockers.ts:54`) lags behind.
   - `pushesOrMerges()` (`src/core/blockers.ts:557-566`) and the `eval` path (`blockers.ts:645`) assume `glab mr merge` / `gh pr merge` have `mr`/`pr` immediately after the binary, missing leading flags like `gh -R owner/repo pr merge` or `glab --repo group/proj mr merge`.

---

## Architecture & Design Decisions

- **No core/harness violations**: All changes stay strictly inside `src/core/` and `tests/`, naming no harness anywhere in `src/core/` (checked by `tests/host-neutral.test.ts`).
- **Pages server viewer-shell & static-asset isolation**:
  - **All non-HTML static assets** (including `.svg`, `.js`, `.css`, `.png`, etc.): serve with `X-Content-Type-Options: nosniff`; for `.svg` (`image/svg+xml`) and any other active non-shell media types, also send `Content-Security-Policy: sandbox` (NO `allow-scripts`, NO `allow-same-origin`!) so an uploaded `.svg` can NEVER execute scripts or scrape viewer-shell tokens on the pages origin.
  - **Raw HTML route (`GET /_raw/<name>` and `HEAD /_raw/<name>`)**:
    - Shares the exact same `URIError` catch (`400`), path-traversal rejection (`404`), and `lstatSync(path).isFile()` symlink rejection (`404`) as `GET /<name>`.
    - Serves `.html` files with `Content-Security-Policy: sandbox allow-scripts` (NO `allow-same-origin`!) and `X-Content-Type-Options: nosniff`, forcing an opaque `null` origin so interactive diagrams/SVG/Canvas/JS continue working while being completely unable to `fetch("/_approve")`, `fetch("/_notes")`, or read `window.parent`.
    - **Suppressing duplicate broken chrome while preserving answered notes**: Before serving HTML from `/_raw/<name>`, strip ONLY the interactive baked chrome (`STYLE_RE`, `PANEL_RE`, `APPROVE_RE`, `FAB_RE`, `SCRIPT_RE`) via a dedicated helper `stripInteractiveChrome(html)` in `src/core/page-notes.ts` — deliberately **preserving** `ANSWERED_RE` (`#ns-answered`) so answered notes remain visible — and append a minimal 10-line read-only selection-quote relay script that calls `window.parent.postMessage({ type: "ns-quote", quote }, "*")` when text is selected.
  - **Trusted Viewer Shell (`GET /<name>` for `.html` files, including `GET /` when `index.html` exists)**:
    - Served directly by `pages.ts` with strict per-request CSP nonce (`default-src 'none'; script-src 'nonce-<nonce>'; style-src 'unsafe-inline'; frame-src 'self'; connect-src 'self'; frame-ancestors 'none'`) and `X-Content-Type-Options: nosniff`.
    - Embeds `<iframe id="ns-frame" sandbox="allow-scripts" src="/_raw/<name>">` filling the viewport, plus the trusted Approve bar (when `.meta/<name>.json` exists) and the trusted Notes panel in the outer shell.
    - The viewer shell's `window.addEventListener("message", ...)` listener strictly validates `ev.source === frame.contentWindow && ev.origin === "null"` and ONLY opens/populates the quote composer textarea (NEVER auto-submits `POST /_notes`).
  - **HMAC-SHA256 Action Tokens with Consistent Page Normalization**:
    - Generate a per-server 32-byte random secret (`randomBytes(32)`).
    - Normalize page names with one shared helper `normalizePageName(raw: string): string`: strip leading `/+`, map `""` to `"index.html"`.
    - Sign `signActionToken(secret, action: "approve" | "notes", page: string)` over `${action}\0${normalizePageName(page)}` and verify with `timingSafeEqual` on `POST /_approve` (against normalized `url.searchParams.get("page")`) and `POST /_notes` (against normalized `body.page`), sent via header `x-ns-token`.
    - Thus a token minted for page A cannot approve or submit notes for page B, and `"/why.html"` vs `"why.html"` always normalize identically.
  - **Standalone `injectPageNotes()` compatibility**:
    - Keep `injectPageNotes()`, `stripPageNotes()`, and `publishPage()` intact. In `page-notes.ts`'s `SCRIPT`, guard `if (window.parent && window.parent !== window)` before any `postMessage` so stubbed DOM tests (`tests/page-notes.test.ts:90-91` where `window.parent` is `undefined`) never throw `TypeError`.
- **Pages server authentication & Host allowlist**:
  - Reuse `authenticate(cfg, tailscale, peer)` from `src/core/owner-ui.ts` in `src/core/pages.ts`, rejecting `peer === tailscale.ip4()` and rejecting loopback unless `cfg.workspace.allow_this_machine === true`.
  - Reuse `hostAllowlist(tailscale, { allowLoopback: cfg.workspace.allow_this_machine })` so `127.0.0.1:<port>`, `localhost:<port>`, and `[::1]:<port>` are accepted ONLY when `allow_this_machine` is true, and strictly Tailscale IP / MagicDNS `Host` otherwise.

---

## Phases

### Phase 1: Sandbox `/knowledge/*` in `src/core/owner-ui.ts`
**Status**: COMPLETE (verified: `bun test tests/owner-ui.test.ts tests/knowledge.test.ts` → 135 pass, 0 fail)

**Justification**: Closing the same-origin XSS vector in `owner-ui.ts` is the highest-impact single fix because `owner-ui` controls `POST /unlock` and `POST /tier`. Sandboxing `/knowledge/*` with an opaque origin eliminates the exploit without breaking read-only HTML explainers.

**Tasks**:
1. In `src/core/owner-ui.ts`:
   - In `knowledgeHtml()` (~line 1112), add `sandbox="allow-scripts"` (explicitly NO `allow-same-origin`) to `<iframe class="knowframe" ...>`.
   - In `GET /knowledge/<repo>/<topic>` (~line 2072), set response headers:
     - `"content-type": "text/html; charset=utf-8"`
     - `"content-security-policy": "sandbox allow-scripts"`
     - `"x-content-type-options": "nosniff"`
2. In `tests/owner-ui.test.ts`:
   - Update line 1962 assertion for the sandboxed `<iframe>` tag.
   - Add tests verifying:
     - The iframe carries `sandbox="allow-scripts"` and does NOT contain `allow-same-origin`.
     - `GET /knowledge/demo-app/arch` returns `content-security-policy: sandbox allow-scripts` (without `allow-same-origin`) and `x-content-type-options: nosniff`.

**Verification**: `bun test tests/owner-ui.test.ts tests/knowledge.test.ts`

---

### Phase 2: Harden `src/core/pages.ts` & `src/core/page-notes.ts` (Auth, DNS Rebinding, Same-Origin HTML/SVG Isolation, URI Safety & Formatting)
**Status**: COMPLETE (verified: `bun test tests/pages-server.test.ts tests/page-notes.test.ts tests/pages-cli.test.ts tests/diagram-check.test.ts tests/plan-approval.test.ts` → 37 pass, 0 fail; `tests/tailnet-rebind.test.ts` → 5/6 pass in sandbox, 1 pre-existing `freePort()` immediate-rebind EADDRINUSE inside sandbox)

**Justification**: `pages.ts` currently lets local agents self-approve plans via loopback or the host's own tailnet IP, lets published HTML or SVG self-approve via same-origin JS, and lacks DNS-rebinding host validation. Bringing `pages.ts` up to the same security standard as `owner-ui.ts` and `team-server.ts` closes all of these vulnerabilities together.

**Tasks**:
1. Reformat `src/core/pages.ts` cleanly to standard repository TypeScript formatting (tabs, readable blocks, docstrings on functions).
2. Extend `hostAllowlist` in `src/core/owner-ui.ts` with optional `opts?: { allowLoopback?: boolean }`: when `allowLoopback` is true, permit `127.0.0.1:${port}`, `localhost:${port}`, and `[::1]:${port}` in addition to Tailscale IP / MagicDNS.
3. In `src/core/page-notes.ts`:
   - Export `stripInteractiveChrome(html: string): string` which strips `STYLE_RE`, `PANEL_RE`, `APPROVE_RE`, `FAB_RE`, `SCRIPT_RE` while **preserving** `ANSWERED_RE` (`#ns-answered`).
   - Export `QUOTE_RELAY_SCRIPT` (minimal read-only selection listener that calls `window.parent.postMessage({ type: "ns-quote", quote }, "*")` when `window.parent && window.parent !== window`).
   - Guard `window.parent && window.parent !== window` in any parent check so `tests/page-notes.test.ts:90-91` stub DOM stays green.
4. In `src/core/pages.ts`:
   - Enforce `hostAllowlist(opts.tailscale, { allowLoopback: opts.cfg.workspace.allow_this_machine })` on every request (403 on mismatch).
   - Enforce `authenticate(opts.cfg, opts.tailscale, peer)` on every request (403 on failure — rejects own tailnet IP and loopback unless `cfg.workspace.allow_this_machine` is true).
   - Use a shared path resolver helper for both `GET/HEAD /<name>` and `GET/HEAD /_raw/<name>` that catches `URIError` from `decodeURI` (returning `400 bad request`), rejects traversal / hidden files / symlinks (`lstatSync(path).isFile()`), and sets `X-Content-Type-Options: nosniff` on all responses.
   - Serve `.svg` (`image/svg+xml`) with `Content-Security-Policy: sandbox` (NO `allow-scripts`, NO `allow-same-origin`) so SVG files cannot run scripts on the pages origin.
   - Generate a per-server 32-byte HMAC secret (`randomBytes(32)`) and normalize page names via `normalizePageName(raw)` (strip leading `/+`, `""` -> `"index.html"`).
   - Enforce `originIsHost(req.headers.get("origin"), hostHeader)` AND `timingSafeEqual` verification of `x-ns-token` on `POST /_approve` (action `"approve"`, bound to normalized `page` query param) and `POST /_notes` (action `"notes"`, bound to normalized `body.page`).
   - Implement `GET/HEAD /_raw/<name>`: serves the `.html` file transformed through `stripInteractiveChrome(html)` + `QUOTE_RELAY_SCRIPT` with `Content-Security-Policy: sandbox allow-scripts` and `X-Content-Type-Options: nosniff`.
   - Implement `GET/HEAD /<name>` for `.html` files (including `GET /` when `index.html` exists): returns the trusted server-rendered viewer shell with per-request CSP nonce, `<iframe id="ns-frame" sandbox="allow-scripts" src="/_raw/<name>">`, the Approve bar (when `.meta/<name>.json` exists, using signed approve token), and the Notes panel (listening for `ev.source === frame.contentWindow && ev.origin === "null"` `ns-quote` messages to populate the composer without auto-submitting, using signed notes token).
5. Update existing `startPagesServer` tests (`tests/pages-server.test.ts`, `tests/page-notes.test.ts`, `tests/pages-cli.test.ts`, `tests/diagram-check.test.ts`, `tests/plan-approval.test.ts`, `tests/tailnet-rebind.test.ts`):
   - Opt into `cfg.workspace.allow_this_machine = true` where loopback fixtures are intentionally used, or use tailnet fixture peers + Host header (matching `tests/owner-ui.test.ts`).
   - Extract the viewer-shell `x-ns-token` when testing `POST /_approve` and `POST /_notes`.
   - In `tests/page-notes.test.ts:122-123`, assert that `GET /why.html` renders the trusted viewer shell (`<iframe ... src="/_raw/why.html">`) with CSP nonce, and `GET /_raw/why.html` returns the sandboxed page without duplicate interactive chrome and with `Content-Security-Policy: sandbox allow-scripts`.
6. Add explicit security E2E tests in `tests/pages-server.test.ts` proving:
   - Loopback and own-tailnet-IP peers are rejected with 403 when `allow_this_machine` is false.
   - Forged `Host` header (DNS rebinding) is rejected with 403 even with matching `Origin`.
   - `GET /x.svg` returns `content-security-policy: sandbox` and `x-content-type-options: nosniff`.
   - `POST /_approve` and `POST /_notes` without a valid `x-ns-token`, or with a token minted for a different page, or with a `notes` token used on `/_approve`, are rejected with 403.
   - `POST /_notes` succeeds when viewer shell minted token for `"why.html"` and client posts `body.page: "/why.html"`.
   - `GET /_raw/<name>` returns `content-security-policy: sandbox allow-scripts` (no `allow-same-origin`), strips duplicate `#ns-approve`/`#ns-notes`, preserves `#ns-answered`, and rejects traversal/symlinks/malformed URIs identically to `GET /<name>`.
   - Malformed percent-encoding (`/%E0%A4%A` and `/_raw/%E0%A4%A`) returns 400 instead of throwing.

**Verification**: `bun test tests/pages-server.test.ts tests/page-notes.test.ts tests/pages-cli.test.ts tests/diagram-check.test.ts tests/plan-approval.test.ts tests/tailnet-rebind.test.ts`

---

### Phase 3: Close Shell Blocker Bypasses in `src/core/blockers.ts`
**Status**: COMPLETE (verified: `bun test tests/blockers-shell.test.ts` → 34 pass, 0 fail; `bun run typecheck` → exit 0; `bun run lint` → 0 warnings, 0 errors; targeted suite across 10 files → 210 pass, 0 fail; guards/team/notes/golden suite → 91 pass, 0 fail with `--timeout 15000`)

**Justification**: Quoting a command name (`'rm'`, `"curl"`, `np\m`), quoting subcommands/flags (`git -C repo "tag"`, `git add "."`, `git commit "--no-verify"`), using common file-mutating binaries (`ln`, `dd`, `chmod`, `rsync`, `curl -o`, `git reset/clean`), or passing flags before `gh pr merge` currently bypasses plan blockers outright.

**Tasks**:
1. In `src/core/blockers.ts`:
   - **Fix `denyCommand()`**: Replace `seg.words.filter(w => !w.quoted)` with a helper `commandMatchText(seg)` that preserves:
     - the resolved command word (index of `commandOf(seg)`'s head word, even if quoted/escaped),
     - the subcommand word for subcommand-style tools (`git`, `npm`, `bun`, `gh`, `glab`, `docker`, `kubectl`, `cargo`, `uv`, `yarn`, `pnpm`), skipping value-taking global options like `git -C repo "tag"` / `git -c k=v "tag"` / `gh -R owner/repo "pr"`,
     - flag tokens matching `/^--?[A-Za-z0-9]/` even if quoted — **excluding** prose-value flags (`-m*`, `--message*`, `--grep*`, `-F*`, combined `-am*`) and excluding the argument word immediately following `-m`, `--message`, `-F`, `--grep`, `-am`,
     - for `git add`, also include quoted pathspec tokens like `"."` (single non-whitespace token not after a prose flag) so `git add "."` cannot bypass `git\s+add\s+(-A|--all|\.)`,
     - and all unquoted words (keeping `git commit -m "tag the release: git tag later"`, `git commit --message="--no-verify"`, `echo "npm publish"`, and heredoc bodies allowed).
   - **Expand `mutationTargets()` & `CODE_MUTATING`**:
     - Add `chmod`, `chown`, `touch`, `mkdir`, `rmdir`, `unlink` to `MUTATING_NAMES`.
     - Add `reset`, `clean`, `merge`, `rebase`, `cherry-pick` to `GIT_MUTATING` (note: do NOT treat `git apply foo.patch`'s patch filename as the mutated target path).
     - Handle destination-last copy/link commands (`cp`, `ln`, `install`, `rsync`): extract `-t <dir>` / `--target-directory=<dir>` if present, else the last non-option operand.
     - Handle `dd`: extract `of=<path>` targets.
     - Handle `curl` (`-o <path>`, `--output <path>`, `--output=<path>`) and `wget` (`-O <path>`, `--output-document <path>`, `--output-document=<path>`).
     - Handle `tar` extraction (`-x` / `--extract` / leading `x` flag): extract `-C <dir>` / `--directory=<dir>` if present (matches directory globs like `deny-path secret`).
     - Update `CODE_MUTATING` (`line 54`) to also cover `ln`, `dd`, `chmod`, `chown`, `touch`, `install`, `rsync`, `curl -o`, `wget -O`, and `git (reset|clean|merge|rebase|cherry-pick)` for `eval` parity.
   - **Fix `pushesOrMerges()` & `eval` `noPush`**:
     - Add a small helper `cliSubcommands(args, valueOpts)` that skips leading flags (e.g. `-R <repo>`, `--repo <repo>`, `-H <host>`, `--hostname <host>`) before checking `mr merge` on `glab` and `pr merge` on `gh`.
     - Update `noPush` on the `eval` path (`line 645`) to use the same token-aware `glab`/`gh` flag-skipping check so `Bun.$`\`gh -R owner/repo pr merge 3\` is also blocked.
2. Add comprehensive regression tests in `tests/blockers-shell.test.ts` covering:
   - Quoted commands/subcommands/flags (`'rm' -rf /`, `"npm" "publish"`, `gi\t -C repo "tag" v1`, `git commit "--no-verify" -m x`, `git add "."`) are blocked.
   - Prose arguments (`git commit -m "tag the release: git tag later"`, `git commit --message="--no-verify"`, `git commit -m"--no-verify"`, `echo "npm publish"`, heredocs) remain allowed.
   - `ln -sf`, `dd if=/dev/zero of=...`, `chmod 777`, `touch`, `install`, `rsync`, `curl -o`, `wget -O`, `tar -xf a.tar -C secret`, `git reset -- uv.lock`, `git clean -f uv.lock` on denied paths are blocked.
   - `gh -R owner/repo pr merge 3`, `glab --repo group/proj mr merge 3` (both `bash` and `eval`) are blocked by `no-push`.

**Verification**: `bun test tests/blockers-shell.test.ts` + full `bun run typecheck && bun run lint && bun test --timeout 15000`

---

## Definition of Done
- All 3 phases implemented and marked COMPLETE.
- Mapped memory file `docs/memory/20261120_1915_security_hardening.md` updated after every phase.
- `bun run typecheck` exits 0.
- `bun run lint` exits 0.
- Targeted security tests and full test suite pass with 0 failures.
- Independent reviewer subagent reviews and approves all changes.
