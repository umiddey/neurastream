# Team server

The team server is one small HTTP process per team. It keeps the team's shared plan queue, claims, members, approvals and audit log in a single SQLite file. It runs on the team's Tailscale network, not on a personal machine.

Config and commands are in [config.md](config.md) (`teams:`) and the README "Team queue" section. This page covers what the server does and keeps, how to back it up, and the route table.

## Auth

Every route, including `GET /health`, runs the same chain in this order:

1. The `Host` header must be this server's tailnet IP or DNS name, with the bound port.
2. A loopback peer is refused.
3. A peer outside the tailnet is refused.
4. The server's own tailnet IP is refused as a peer.
5. Tailscale `whois` names the login of the peer.
6. The login must be on the member list. Admin and leader are roles on that list.

Every write method (`PUT`, `POST`, `DELETE`) also needs an `Origin` header that is exactly `http://` plus the `Host` header. The server does not check cookies or tokens; the tailnet identity is the credential.

Role checks apply after the chain:

- `member`: any listed login.
- `leader`: the leader login (starts as the admin; see `workspace` in the README).
- `admin`: the admin login only.

Each login may make at most 60 write requests in any rolling 60 seconds. Request bodies are capped at 1 MiB, and plan text at 256 KiB. Owner answers are capped at 2000 characters, distinct reasons at 1 to 200 characters, and plan id lists at 1 to 500 entries.

## Data kept

One SQLite file: `<queue_state>/team-server/<name>.sqlite`. It holds these tables:

- `plans`: plan text, only for plans whose header says `Queue: team`. Personal plans and plans from repos that are not team-labelled are never sent.
- `members`: logins and roles.
- `claims`: who holds each plan, with a heartbeat time.
- `audit`: one row per accepted or refused action.
- `approvals`, `answers`: approvals and owner answers; the first answer to a question is the one that counts.
- `vote_ranks`: each member's whole rank map, replaced on every vote.
- `paused`: members paused from claiming.
- `meta`: the leader's order override.

The audit log is written by `INSERT` only. This is a code convention, not a database rule: the schema has no trigger that blocks `UPDATE` or `DELETE`, so anyone with file access can change it.

## Backup

The single `.sqlite` file above is the whole server state, so backing it up backs up the team queue.

**(a) Offline copy.** Stop the team unit, copy the file, start the unit again:

```sh
systemctl --user stop neurastream-team-<name>
cp <queue_state>/team-server/<name>.sqlite <dest>
systemctl --user start neurastream-team-<name>
```

Do not use `workspace off --team <name>` for this. It disables the unit and removes the team settings file, so bringing the server back needs `workspace on --team <name> --admin <login> --repo <glob>`. The database file stays on disk through `off`, but this method is simpler.

**(b) Live copy.** Use the `sqlite3` command-line tool. Neurastream does not install it; it must be on `PATH` (on Arch, the `sqlite` package; on Debian and Ubuntu, `sqlite3`):

```sh
sqlite3 <queue_state>/team-server/<name>.sqlite ".backup <dest>"
```

`.backup` takes a consistent copy while the server keeps running. A plain `cp` of a live file can copy it mid-write, so use `.backup` for a live copy.

## Routes

Paths are as the server matches them. `:id` is a plan id or claim id; `:login` is a member login. The `Body` column is the request format: JSON, a form post, or a page (HTML).

| Method | Path | Body | Role |
|---|---|---|---|
| GET | /health | JSON | member |
| GET | /plans | JSON | member |
| GET | /plans/:id | JSON | member |
| PUT | /plans/:id | JSON | member |
| GET | /claims | JSON | member |
| GET | /claims/:id | JSON | member |
| POST | /claims/:id | JSON | member |
| DELETE | /claims/:id | JSON | member |
| POST | /claims/:id/beat | JSON | member |
| GET | /view | JSON | member |
| GET | /audit | JSON | admin |
| POST | /members | JSON | admin |
| DELETE | /members/:login | JSON | admin |
| POST | /approve/:id | JSON | member |
| POST | /answer/:id | JSON | member |
| POST | /order | JSON | member |
| POST | /order/override | JSON | leader |
| POST | /pause | JSON | member |
| POST | /resume | JSON | member |
| GET | / | page | member |
| POST | /approve | form | member |
| POST | /answer | form | member |
| POST | /member | form | admin |
| POST | /vote | form | member |
| POST | /override | form | leader |

`PUT /plans/:id` is handled at `src/core/team-server.ts:897-947` (commit `b1dbf4d`); the gate is at 897 and the handler runs to 947. The server accepts a plan only when its header says `Queue: team`.

A claim beat is `POST /claims/:id/beat` only; there is no `GET` form of it.
