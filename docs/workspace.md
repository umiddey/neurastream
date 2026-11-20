# Owner Workspace, Static Pages, and Knowledge Base

All web surfaces bind exclusively to this machine's Tailscale IPv4 address (never `0.0.0.0`), have zero external assets or build steps, and exit automatically within 30s if `tailscale ip -4` changes so systemd restarts them on the new address.

## Owner page (`neurastream workspace`)

### Setup

```sh
neurastream workspace on --login <tailscale-login> [--port 7787]
neurastream workspace off
```

`workspace on` updates `workspace.enabled` and `workspace.owner_login` in `~/.config/neurastream/config.yml` (preserving all other lines byte-for-byte), installs and enables `~/.config/systemd/user/neurastream-workspace.service`, and prints the Tailscale MagicDNS URL.

Preview locally without starting a server:
```sh
bun scripts/ui-preview.ts /tmp/preview.html [--tab now|queue|agents|spend|knowledge|results]
```

### Tabs
- **Now**: 24h summary tiles (needs-you count, spend sparkline, agent runs, open plans), `WAITING on owner:` question/task cards with one-tap answers (`Yes` / `No` / `Reply…` / `Done`), "Tell Main" message box (text + up to 4 images, kept 12 hours), and the top 8 ranked queue rows.
- **Queue**: Full ranked `INDEX.md` list with drag-and-drop and tap reorder controls (`↑ top` / `↑` / `↓`). Reorders respect `Waits on:` dependencies and notify Main.
- **Agents**: Live running agents, `agent-score` board, open incidents (including `False alarm` / `It's a bug — plan it` buttons for finding incidents), recent merges/CI, and machine health.
- **Spend**: 24h spend tile paired with per-model spend breakdown.
- **Base (`/?tab=knowledge`)**: Read-only browser for repo-local HTML explainers under `docs/knowledge/<topic>.html` across git repos directly under `knowledge.roots` (default `$HOME/projects`, `$HOME/Work`, cached for `knowledge.max_age_s`, default 300s). Linked worktrees are skipped so each repo appears once.
- **Results**: Release-over-release line chart and table (`$/feature`, `features/day`, `calls`, `tokens`, `fix rate`, and configured `metrics.product_cmds`).

### Security model
- Serves only a Tailscale peer that is neither loopback nor this machine's own tailnet IP, whose `tailscale whois` login equals `workspace.owner_login`, and whose `Host` header matches this machine's tailnet IP or MagicDNS name + port.
- Every `POST` must also pass an `Origin` check matching `Host` (blocking DNS rebinding).
- Setting `workspace.allow_this_machine: true` relaxes only the local-peer check (with the trade-off that local processes can hit the endpoints).
- Answers append to guard-protected `<queue_state>/owner-inbox.jsonl`. Main's adapter delivers each record once as a user message (at turn end and on a 15s idle poll), tracking its cursor in `<queue_state>/mains/<id>/inbox-cursor`. Guards refuse agent attempts to start the workspace service or write the inbox.

## Static pages and plan approval (`neurastream pages`)

```sh
neurastream pages on [--port N] [--dir D]
neurastream pages publish <file> [name] [--force] [--keep] [--plan <plan.md>]
neurastream pages list
neurastream pages off
```

- Serves regular files in `pages.dir` over Tailscale (owner login or loopback; refuses symlinks, hidden files, and path traversal).
- Pages without `--keep` expire after `pages.keep_days` (default 15) and are swept on publish, list, serve startup, and hourly.
- **Review notes**: Published HTML pages include an injected notes panel. `neurastream notes check <page>` exits `1` while any note lacks an answer in `<queue_state>/page-notes/<page>.answers.json`, and `pages publish` refuses to republish until all open note IDs are answered.
- **Plan diagrams & approval**:
  - `pages publish <html> <name> --plan <plan.md>` runs `neurastream diagram check <html> <plan.md>` (verifying every phase and cited path/command appears in the drilldown tree with 2+ children per drilldown) and attaches an **Approve** bar.
  - Approving records the plan's text hash in `<queue_state>/plan-approvals.json` without editing the plan (disabled and returns `409` while any note is unanswered or the diagram check fails).
  - When `approval.since` is configured (or a plan has a published diagram page), `main-guard` refuses spawns until an approval record matches the plan's current body hash.
