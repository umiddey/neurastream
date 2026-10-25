# neurastream pages: any HTML artifact the owner asks for is hosted on the tailnet, permanently
Worktree: /home/ukd/Work/neurastream-pages
Branch: feat/pages
Read /home/ukd/projects/opus-implementer-method.md first.

## Goal
- Owner (2026-10-25, after the architecture diagram went live): any diagram/HTML he asks for should be hosted on the tailnet as a permanent neurastream feature, not ad-hoc servers Main starts.
- Today the diagram (http://ukd.tailc0aee7.ts.net:7788) runs on a throwaway bun process that dies with Main's session. The owner phone page (port 7787) already shows the permanent pattern: systemd user unit + tailnet-only bind + whois auth (src/core/owner-ui.ts, src/core/ui-setup.ts).
- Done when: `neurastream pages on` installs and starts a systemd user unit serving a pages dir over the tailnet; `neurastream pages publish <file> [<name>]` copies a file in and prints its MagicDNS URL; `pages off` and `pages list` work; doctor checks the unit; the architecture diagram is served by the real feature on port 7788 and the throwaway server is killed.

## Forbidden
- Work only in /home/ukd/Work/neurastream-pages on feat/pages. Never push, merge, tag or publish. Commit files by name; never `git add -A`/`.`; never `--no-verify`.
- No new dependencies. No changes to src/adapters/**, src/core/queue/**, src/core/guards.ts, src/core/notify.ts, src/core/traces*.ts, src/core/episodes*.ts, or templates/systemd/neurastream-ui.service.
- src/core/owner-ui.ts may only gain `export` on its existing pure auth helpers (isLoopback, isTailnet, the whois/login check); every other line of it stays byte-identical, its tests untouched.
- The server serves only regular files directly inside the configured dir: dotfiles 404, symlinked paths 404, traversal 404, directory listing never; GET/HEAD only (405 otherwise). Never follow anything out of the dir.
- Never run real systemctl, never start/stop units; tests inject the Runner and bind 127.0.0.1 with fixture peers (the owner-ui test pattern).
- Every test run via `/home/ukd/Work/heavy-run.sh <agent> "<label>" -- <cmd>` with tool timeout 0.
- Call budget: stop and report within ~80 calls. One dated bullet under `## Progress` after the `Status:` line, ending with `Findings:`.

## Blockers
- no-push
- deny-path /home/ukd/.omp/agent/** /home/ukd/.bun/** INDEX.md src/adapters/** src/core/guards.ts src/core/queue/** src/core/notify.ts src/core/traces*.ts src/core/episodes*.ts templates/systemd/neurastream-ui.service
- deny-command --no-verify git\s+add\s+(-A|--all|\.)(\s|$) git\s+push\b git\s+merge\b git\s+tag\b npm\s+publish reset\s+--hard systemctl\s+--user curl\b sudo\b

## Phases
- [ ] P1 Core server. src/core/pages.ts + tests/pages-server.test.ts. `startPagesServer({cfg, tailscale, source, hostname?, port?, peerOf?, root?})` → `{stop(), hostname, port}` mirroring the owner-ui server shape (UiHttpServer seam, injectable peerOf; tests bind 127.0.0.1, production binds the tailnet IPv4 from `tailscale ip -4`). Root default: the pages dir from config. Auth = the owner page's doors reused via the exported helpers: loopback passes; tailnet peer requires whois login == the configured owner login (config read-only); anything else 403 plain-text. Serving per Forbidden rules; `/` serves index.html when present, else a minimal HTML list of published file names (no sizes, no paths); content-type map for html css js mjs svg png jpg jpeg webp json txt ico woff2 map; unknown extension → application/octet-stream + Content-Disposition attachment. Tests: 200 + content-type for html/svg; HEAD sends headers, empty body; POST/PUT 405; `..` traversal 404; symlink 404; dotfile 404; non-tailnet peer 403; loopback 200; index fallback lists names. — difficulty: 3 — verify: `cd /home/ukd/Work/neurastream-pages && /home/ukd/Work/heavy-run.sh agent "pages p1" -- bun test tests/pages-server.test.ts`
- [ ] P2 CLI + setup. src/core/pages-setup.ts + src/cli/pages.ts (wired into src/cli/index.ts). `pages on [--port N] [--dir D]`: line-based edit of the pages block in config.yml exactly like ui-setup.ts does for the ui block (enabled true, port, dir; never rewrites unrelated lines), install templates/systemd/neurastream-pages.service (new template, modeled on the ui unit; ExecStart runs `pages serve`), daemon-reload + start + print the MagicDNS URL. `pages off` (stop + enabled false, unit stays). `pages serve`: production entry the unit runs. `pages publish <file> [<name>] [--force]`: copy into the pages dir, name slugified (default = source basename), refuse overwriting different content without --force, print the URL path. `pages list`. All systemctl goes through the Runner seam (argv recorded in tests, never executed). Tests: config round-trip preserves unrelated lines; unit install + start argv; publish copy/collision/--force/list. — difficulty: 3 — verify: `cd /home/ukd/Work/neurastream-pages && /home/ukd/Work/heavy-run.sh agent "pages p2" -- bun test tests/pages-cli.test.ts`
- [ ] P3 Doctor + docs. src/core/doctor.ts gains a pages check: when pages is enabled — config block parses, dir exists, unit file exists, runner `systemctl --user is-active neurastream-pages` reports active (via seam; warn, not fail); always warn when the dir contains a symlink. README gets one pages paragraph next to the owner-page section; CHANGELOG Unreleased → Added. Full suite + typecheck green. — difficulty: 2 — verify: `cd /home/ukd/Work/neurastream-pages && /home/ukd/Work/heavy-run.sh agent "pages p3" -- sh -c 'bun test && bun run typecheck'`
- [ ] P4 Main: review, merge, release by tag, install. Then `neurastream pages on --port 7788`, `pages publish /home/ukd/Work/neurastream-architecture.html architecture` plus index.html, kill the throwaway arch-diagram server, curl 200 on http://ukd.tailc0aee7.ts.net:7788/, owner checks his phone. — difficulty: 1 — verify: `git -C /home/ukd/projects/neurastream merge-base --is-ancestor feat/pages origin/main && curl -fs -o /dev/null http://100.109.146.109:7788/`

## Done check
`git -C /home/ukd/projects/neurastream fetch -q origin && git -C /home/ukd/projects/neurastream merge-base --is-ancestor feat/pages origin/main`

## Code read by Main
- `/home/ukd/projects/neurastream/src/core/owner-ui.ts` (:29-63 UiHttpServer, OwnerUiServer, OwnerUiOptions seams, Auth, inboxPath, isLoopback, isTailnet)
- `/home/ukd/projects/neurastream/src/core/ui-setup.ts` (:15-16 UI_UNIT_TEMPLATE, :18-29 Runner seam + systemRunner, :31-48 options and the line-based ui-block edit)
- `/home/ukd/projects/neurastream/README.md` (owner-page section: tailnet-only bind, whois==login doors, MagicDNS link, systemd unit)

## Progress
Status: open
- 2026-10-25 17:05 Main: plan written while the diagram runs on the throwaway server; P4 replaces it with the real feature. Findings: none
- 2026-10-25 NsPagesP1P3: completed P1–P3 in `/home/ukd/Work/neurastream-pages`; commits `db68c08`, `01751ff`, `4b5aa5d`. Full suite: 816 passed, 3 skipped; typecheck passed. Findings: none
