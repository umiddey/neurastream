# Changelog

## Unreleased
### Added
- Provider-honesty rules (plan 20261024_0302): `model-swap` (announced model vs the model/provider assistant messages show, fallback resolutions included), `odd-response-id` (a present responseId vs `traces.provider.id_patterns`; a missing id is not checked), `unoffered-tool` (calls nothing in the allow-list, the request's own tool list or a result other than an unknown-tool refusal backs — a guard-refused call of a real tool is not flagged), `phantom-output` (billed output tokens for a message that wrote nothing; aborted or errored streams are not judged) and `cost-mismatch` (`model_usage` cost beyond ±20% of `traces.provider.prices`, $ per million tokens, either direction). `neurastream metrics report` ends with a weekly `Provider honesty over N runs: …` line. The `traces.provider` maps are open: an empty object in the template accepts your keys, and an assistant message with no content now parses as an empty-text event so phantom output is visible.
- `neurastream traces actions <runId|--since 24h> [--json]`: flag suspicious tool actions in a run's trace — reads of secret paths, network commands to hosts not on the allow list (exfil-shaped ones are high), writes outside the work roots or into deny paths, and `curl … | sh`. Every list lives in the new `traces:` config section. High findings become `suspicious-action` incidents; evidence is masked and capped.
- Owned-product read rule: a subagent run reading files of another owned product (`traces.owned_repos`; installed copies under `node_modules` and global installs included) while its final report says `Findings: none` becomes an `unreported-finding` incident (source `traces`) and records an `agent-score penalty` event for that agent on the plan.
- Live traces wiring: right after an allowed subagent Progress edit, the adapter parses the sub's own session file and folds its high suspicious tool actions as `suspicious-action` incidents, and — when the new Progress bullet claims `Findings: none` — the cross-product reads hidden behind that claim as `unreported-finding` incidents with the agent-score penalty; the verified bullet replaces the final-text check. Detector failures are logged, never thrown, so a broken detector cannot break the edit.
- Cross-run claim backing (`neurastream traces claims`, INCIDENT I-20261025-23): a Main run's claim that cites a subagent result — a test count, a fail count, an exit code — is no longer unbacked when only the subagent's own session shows it. The CLI also checks the toolResult text of the subagent runs under Main's session dir and reports the match as backed `subagent:<name>`; claims no related run shows stay unbacked.

### Fixed
- A subagent's Progress entry that quoted `Findings: none` mid-text (e.g. in its resume steps) and ended with its real `Findings:` items had the quoted text read as its findings: the resume steps after the quote were split on `;` into bogus agent-finding incidents (24 on 2026-10-25). The guard now reads the value after the entry's last `Findings:`.
- `neurastream adapter install omp` broke a config.yml whose `guards:` section had no `protected:` key: it inserted the adapter paths as bare `- "…"` items before `ledger_command`, so the YAML no longer parsed. The overlay now always writes them under their own key — an empty `protected: []` becomes a block list, an existing block list gains them under its header, a missing key is added at the top of `guards:` — and refuses a flow list with items instead of adding a second key.
- A Main turn that ended on a provider rate limit was re-asked straight into the limit: at 02:07Z the stop guard re-prompted three times within 4 s (every retry hit `429 … retry-after-ms=731000` again), then allowed the stop and posted nothing, and nothing resumed Main — 3h20m idle before the owner noticed. The stop guard now recognizes a rate-limited turn end (`guards.rate_limit.patterns` on the error text), allows the stop without touching the idle-stop counters or the normal stop rules, posts `⏳ Main is rate limited by its provider until HH:MM (local); it resumes on its own.` once per episode, and arms exactly one resume timer (a longer retry-after or a second limited turn doubles the wait, clamped to `max_wait_s`, plus `slack_s`) that hands Main a new turn with "continue the queue where you stopped" when the wait is over; the owner's own message cancels it, and a rate-limited deferred hand-back arms the timer instead of logging "no reply text".

## 0.2.13
### Changed
- The owner page is rebuilt for one-handed phone use (design: `docs/owner-ui-design.md`): a sticky status strip with the amber needs-you count and working/CI/disk signals that turn red only when something is wrong; each open `WAITING on owner:` plan is a card with its `#` title, the ask in plain words, the goal folded into a Background block and named actions ("Yes, go ahead", "No", "Reply…") whose answer lands as a one-time receipt ("Sent to Main · 08:12"); running/waiting agents as rows; queue (one flat ranked list, see Added), merges/CI, incidents, agent scores (a real table) and machine health as closed details blocks with count chips; and a sticky bottom bar for the guard unlock that explains itself, with the exact config line, when `guards.chat_unlock` is off. The meta refresh is gone: an inline script reloads every 20 s only while no field has focus or text and keeps `<details>` open state in `sessionStorage`; every GET sends a per-response `Content-Security-Policy` with the inline script's nonce. Unlock/lock refused because `chat_unlock` is off now redirect to the page (receipt + bar explanation) instead of a bare 409. Page data (typed rows per source) is separate from rendering, so `bun scripts/ui-preview.ts <out.html>` renders a fixture preview without a server.

### Added
- `INDEX.md` order is priority: the queue summary is one flat ranked list in index order (`N. <file> [flags] <goal>`, rank 1 = the top line; per-repo cancelled counts move to one footer line), and the spawn guard refuses a spawn on a plan while a higher plan is idle (open, not waiting, not awaiting merge, has an unticked phase) and unstaffed, unless the brief carries `Priority skip: <plan> — <why>` with a non-empty why. Staffing comes from `staffing.json` (each plan's newest spawn's task names) matched against omp's running job labels; without job info (CLI `neurastream guard spawn`) the gate logs `PRIORITY unknown jobs` and lets the spawn through. `Priority skip:` lines no longer make the skipped plan a spawn target. The managed AGENTS.md block states the rule.
- Queue reorder by drag and drop on the owner page: the queue is one flat list in `INDEX.md` order (rank number + repo chip per card); each card has a pointer-events drag handle (touch and mouse, no HTML5 drag API) plus "↑ top"/"↑"/"↓" buttons, and a drop POSTs `/reorder` with the full new order, the order the page was rendered with and the moved plan. The server reuses the /answer auth; it refuses an order that is not exactly the index's plans (400) or a page stale against the current `INDEX.md` (409), rewrites `INDEX.md` atomically (temp file + rename, every comment and blank line stays attached above the plan that follows it), appends one `reorder` record to the owner inbox (Main gets "Owner moved … from #1 to #2 … INDEX.md has the new order") and confirms on the page with "Moved to #2 · Main sees it next turn".
- `neurastream traces claims <runId|--since 24h> [--json]`: check what a run's final report claims (test counts, exit codes, commit SHAs, heavy-run labels, changed paths) against what the same run's tool output actually shows; anything nothing backs becomes a `claim-unbacked` finding. A SHA only counts when the git command whose output printed it is the call the run itself made (results pair with their own tool calls), paths must end in a real file extension (dotted API symbols and session-UUID fragments are not files), and files agents wrote through the shell (redirect, heredoc, `tee`/`touch`/`cp`/`mv`) back changed-path claims like edit/write calls do.

### Fixed
- Queue reorder worked only while the index listed open plans alone: `POST /reorder` compared the posted `order` (exact set → 400) and `before` (→ 409) against every `INDEX.md` line, so a `Status: complete` plan kept in the index while awaiting merge made every drag answer 400 and the page ranks differed from the file ranks. It now checks against the open plans the page renders (the same list as the queue cards), rewrites only the open slots — each open plan moves with its attached comment/blank lines, non-open lines keep their slots, a path listed twice keeps both lines — and the inbox `from`/`to` are 1-based ranks in the open list.

## 0.2.12
### Added
- "Needs you" pings: when a Main turn ends with an open plan whose `WAITING on owner:` line has not been pinged before, neurastream posts `🔔 Needs you — <plan title>: <question>` (plus the `neurastream ui` phone-page link when `ui.enabled: true` and the machine's MagicDNS name is known) to the configured Discord/Slack webhooks; and when the guard refuses a Main tool call because it touches a protected guard file, it posts `🔓 Main needs an unlock to continue (<file>). Tap "unlock N" on the phone page.` at most once per 30 minutes. Deterministic, no model call, Main session only, fire-and-forget; each waiting question posts once until its line changes or disappears (keys remembered in `<queue_state>/notify-waiting.json`), and every decision logs one `notify: needs-you posted|skipped (<why>)` guard-log line.
### Fixed
- Chat notify missed most real hand-backs: omp fires `session_stop` BEFORE `agent_end` and skips it entirely while an async job (subagent, background bash) is pending, and the adapter read the reply from the session file, so it posted the previous turn's reply or nothing. The adapter now takes the reply from the event itself — the stop's `last_assistant_message` (falling back to the last assistant entry of `messages`) and the `agent_end` `messages` — and posts at an allowed `session_stop` and at a `willContinue: true` `agent_end` whose last assistant message ends with a `stop` reason, text and no tool call (the deferred hand-back). Still once per distinct text, never for a subagent, never on a blocked stop; every notify decision now logs one guard-log line `notify: posted|skipped (<why>)`.

## 0.2.11
### Fixed
- Tapping unlock or lock on the owner page did not tell Main; the owner had to say it in chat. The page now writes an `unlock`/`lock` record to the owner inbox, and Main gets it as a user message ("Owner unlocked the guards from the phone page for 5 min (until 01:12)…"). The inbox also understands a `reorder` record for the coming drag-and-drop queue.

## 0.2.10
### Fixed
- The owner page answered 403 to the owner's own phone: the real `tailscale whois --json` reader parsed only the first stdout line (`{`) and looked for the login under `User` instead of `UserProfile`, so every peer's login was empty. It now parses the whole output and reads `UserProfile.LoginName`.

### Added
- `neurastream ui on --login <tailscale login> [--port N]` and `neurastream ui off`: one command instead of the hand-rolled cp + systemctl recipe. `on` writes `ui.enabled: true` and `ui.owner_login` (and `ui.port` with `--port`) into the user config — line-based, every other line of the file kept byte-for-byte, nothing written if the edited file would not load — copies `templates/systemd/neurastream-ui.service` to `~/.config/systemd/user/neurastream-ui.service`, runs `systemctl --user daemon-reload`, `enable` and `restart`, and prints the phone link `http://<MagicDNS name>:<port>`; the login is checked against the tailnet's logins (new `logins()` Tailscale call, `tailscale status --json`) and a tailscale failure only prints a warning, never refuses. `off` runs `systemctl --user disable --now neurastream-ui` and sets `ui.enabled: false`, keeping `owner_login`. Both stay refused to agents like every `neurastream ui` command.

## 0.2.9
### Fixed
- `neurastream ui` (and the `neurastream-ui` user unit) exited with code 0 about 90 ms after starting, so the owner page was never reachable: the CLI exits with the command's return code, and `runUi` returned right after starting the server. Serving now never returns; the process runs until systemd or a signal stops it.

## 0.2.8
### Added
- Owner phone page (`neurastream ui`, off until `ui.enabled: true`): one server-rendered page over Tailscale — plans waiting on the owner with answer buttons, guard unlock/lock, running agents, the queue, recent merges/CI, open incidents, agent scores, machine health — bound to the tailnet address only. A request is served only to a tailnet peer whose `tailscale whois` login equals `ui.owner_login`, and only with a Host header naming this machine (tailnet address or MagicDNS name from the new `dnsName()` Tailscale call, `tailscale status --self --json`) with the served port — checked on every request before whois, with the POST Origin matched against it, so DNS rebinding gets a 403. Answers append to `<queue_state>/owner-inbox.jsonl`; unlock/lock reuse the chat-unlock core function and log `UNLOCK ui source=ui:<login> minutes=N`. The omp adapter delivers each record once to Main (turn end and a 15 s idle poll, cursor in `<queue_state>/owner-inbox.cursor`; subagent sessions never deliver). Guards refuse agent writes to the inbox and cursor and refuse agent commands that start the page (`neurastream ui`, `systemctl --user start/restart/enable` of `neurastream-ui`). `neurastream doctor` checks `ui.enabled` against the login and a silent tailscale; README "Owner page" has the details.

### Fixed
- Subagents at their call cap can read their own plan file (with or without selectors) and edit its `## Progress` section (INCIDENT I-20261024-27); other file reads and edits remain refused.
- Main's edit window counts only actual project-file modifications from successful tool results and ignores quoted redirect syntax inside shell commands (INCIDENT I-20261024-28).
- `agent-score accept|diagnose|penalty|validate` requires a positional agent name and rejects a missing agent or unknown flags with exit 2 and the usage line (INCIDENT I-20261024-29).

## 0.2.7
### Added
- Chat unlock (`guards.chat_unlock`, default off): the owner's whole chat message `unlock` / `unlock N` / `lock` (trimmed, case-insensitive; N clamped to 1..`guards.unlock_minutes`, `unlock 0` and partial matches like "please unlock 30" do nothing) moves the guard unlock file the same way a terminal `touch` does — `unlock N` backdates the mtime so the existing window closes after exactly N minutes. Only two paths reach it: the omp input event with source `interactive` in the main session, and a collab guest prompt from a peer with write access (the `collab-prompt` custom message, seen on the `context` event; replays of the same message act once, stale ones not at all). Model output, tool results, machine prompts (`before_agent_start`), non-interactive sources and subagent contexts never unlock. Every applied unlock/lock is logged to `paths.plan_guard_log` as `UNLOCK chat source=<interactive|collab:NAME> minutes=N` / `LOCK chat …`, the protected-file refusal names `unlock 30` in chat when the flag is on, and the managed AGENTS.md block documents it.
- Chat notify (Discord and/or Slack): when a session stop hands the turn back to the owner, the adapter posts Main's final reply to the configured channels — deterministic, no model call, once per distinct text, never for a subagent session, never on a blocked stop, never delaying the stop decision (5 s timeout per chunk, one attempt, one guard-log line on failure). The webhook URLs live in secret files only the owner can touch; `notify.discord_webhook_file` / `notify.slack_webhook_file` (default "", off) hold their paths and `notify.prefix` labels the post. The guard refuses every agent's read of a secret file, its directory, or a glob over it — unlock or not — and the neurastream config file and the secret files need the owner's unlock to change. `neurastream doctor` reports a secret file readable by group/others, a raw webhook URL in the config file, or a secret file next to config.yml, and warns about a configured file that is missing. `neurastream notify test` posts one line to every configured channel and exits 1 when one fails.

### Fixed
- tests/guards-scope.test.ts no longer writes into the real guard log (INCIDENT I-20261024-26): the child `neurastream guard` CLI got the temp HOME, but the copy of process.env then put the real HOME back.

## 0.2.6
### Fixed
- `deny-path` catches file writes done through interpreter code (INCIDENT I-20261024-24): a refused subagent could still write or remove denied files with `python3 -c` / a `python3` heredoc / `ruby -e` running `Path(…).write_text()`, `open(…, "w")`, `os.remove/rename/replace/unlink`, `shutil.*`, `.writelines()`, `File.write`, `rmSync` or `appendFile`. These code-write forms are one shared list (the code parts of queue/lib.ts `MUTATING` plus `File.write`) used for both shell command targets and `eval` code, and heredoc bodies are kept as their interpreter segment's code — a heredoc to `cat` is still prose. Reading a denied file (`open('x')`, `Path('x').read_text()`) and writes outside the deny globs stay allowed.

## 0.2.5
### Added
- Per-spawn call budget: a `Call budget: <N>` line in a `task` brief (the task's own text, or the shared `context`; the task's own line wins) gives that run a hard stop at N calls — warning at N − (`guards.sub_max_calls` − `guards.sub_warn_calls`), floored at 1 — instead of the global warn 90 / stop 100, and the ledger's OVER-BUDGET flag uses the same N. The spawn is refused when N is outside 10..`guards.sub_max_calls_cap` (new config key, default 200, must be ≥ `guards.sub_max_calls`) or the task has no `name` (the budget is keyed by it, stored as `<queue_state>/spawn-budgets.json`). A task without the line keeps the global values. brief-lint accepts the line as the brief's call-budget rule.

## 0.2.4
### Fixed
- brief-lint no longer fails a plan on paths from finished work. When the file has a `## Phases` heading, the path check scans only the live parts — the header lines, Goal, Forbidden, Blockers, unticked phase lines and Done check. Paths in ticked phase lines and in the history sections (`## Code read by Main`, `## Progress`, `## Background`) cite worktrees removed after their phases landed and are skipped; a plain brief without `## Phases` is still checked whole.

## 0.2.3
### Fixed
- Plan blockers no longer leak across worktrees of one repo (the 0.2.0 one-index regression). With every plan file living in the main checkout, `planCovers` fell back to "same repo", so the union of all open plans' blockers ran on every worktree of that repo: a subagent working in its own plan's worktree was refused by the `deny-path` rule of a different open plan. A path whose git worktree top is another open plan's `Worktree:` is now covered only by that plan (plus plans whose `## Applies to` lists it); paths in the main checkout and in worktrees no open plan names stay covered as before.

## 0.2.2
### Fixed
- The spawn guard did not see lettered sub-phases (`- [ ] P4a …`): a plan whose only open phases were `P4a`–`P4e` was refused with "no unticked phase left". Phase ids now include one trailing letter.

## 0.2.1
### Fixed
- `neurastream queue migrate` resolved repo-relative lines of an old repo `INDEX.md` (`docs/plans/x.md`) against the current directory instead of that repo, so the main index got wrong plan paths. They now resolve against the repo.

## 0.2.0
### Added
- Plan-guard requires a `Findings:` line in every `## Progress` entry a subagent adds to a plan: `Findings: none`, or one item per finding (bug, workaround, improvement — any repo) with `file:line` evidence, items separated by `;`. An edit that adds an entry without the line is refused and the file restored. Each finding item of an allowed edit becomes an incident (source `findings`, kind `agent-finding`, evidence = plan path + agent); the same item text again dedupes into the open incident, and `Findings: none` records nothing. Main's own entries are unaffected. (The penalty for a false `Findings: none` needs the trace scan and is not part of this.)
### Changed
- The queue is one file (incident I-20261024-7): the main index (`paths.queue_index`) lists plan files, one absolute path per line; the per-repo `INDEX.md` files are gone. A plan file must live in a main checkout, never in a linked worktree, and two open plans may not name one worktree — `queue-check` reports both. Release as 0.2.0 (queue format change): run `neurastream queue migrate` once, it folds the old repo `INDEX.md` lines into the main index, deletes them and is idempotent; plans still inside a worktree are reported, not moved. `neurastream doctor` flags a main index that still lists repo directories.
### Fixed
- queue-close removes the plan's worktree after a successful close only when it is clean and its branch landed, with a plain `git worktree remove` — never `--force`, no `rm -rf`, no docker fallback. A dirty, unmerged or unremovable worktree and the repo's main checkout are kept and the reason printed. Branches leave only via `git branch -d`: when git cannot see the merge (a stale upstream hides the landing), the branch stays. The uncommitted-work stash and the queue-archive branch copy are gone — what is kept is kept in place. The done check for a missing worktree runs in a throwaway shared clone instead of a registered worktree; a scratch the check dirtied is kept, never force-removed.

## 0.1.28
### Fixed
- The relaunch is requested only at a run's real end (incident I-20261024-4). A tool result mid-run no longer writes `relaunch.json` and shuts the session down while Main keeps working; while a relaunch is pending, every later terminal run end calls `shutdown()` again, because omp 18.11.1 re-runs its deferred exit check only then.
- A relaunch omp does not exit falls back to an in-process rollover. If omp still has not exited `rollover.exit_grace_s` seconds (default 20, new config key) after the request, the adapter rolls over in the running process — fresh session, handoff, the owner's typed messages included — instead of leaving a dead UI that swallows every message. A real shutdown cancels the fallback.
- The launcher says what it is doing (`neurastream: starting a new session from the handoff (collecting state, about a minute)…`) and removes `relaunch.json` only after the handoff message is built, so a kill during main-start no longer costs the owner's messages. A fresh `neurastream main` with no message of its own continues an interrupted rollover whose request is at most an hour old.

## 0.1.27
### Fixed
- An upgrade while the launcher runs no longer crashes it (incident I-20261023-6). A relaunch request left after an upgrade goes to a fresh launcher from the installed package, so the handoff is built with the new code. Version helpers live in `src/adapters/omp/package-root.ts`.
- A main-start failure during a rollover no longer stops the launcher. The handoff carries a `main-start failed during the rollover (…)` line, and the note still reaches the next run.
- An incident planned before its fix ships becomes FIXED when the plan that cites it closes. A plan that names an incident several times records it once.

## 0.1.26
### Fixed
- quota-reset prints the local zone abbreviation from `date` (CEST, CET, CST) like the original glm-reset, where Intl's US-only short names printed GMT+2 on non-US hosts; CI re-runs the golden and quota-reset tests under Europe/Berlin on both OSes.
- `neurastream incident plan` finds the repo of a plan at any depth (it walks up to the folder holding INDEX.md), so plans under `docs/plans/immediate/` are accepted instead of refused as "not listed in …/docs/INDEX.md".

## 0.1.25
### Fixed
- Runs on macOS. main-start no longer crashes reading `/proc/loadavg` (incident I-20261023-3). machine-guard reads load, memory, swap, disk and processes with macOS tools. tmp-snapshot runs without `ionice` or GNU `date`. queue-close finds worktrees behind symlinked paths (`/tmp` → `/private/tmp`).
- heavy-run holds its lock for the whole command. Before, it took the lock and dropped it at once, so two heavy-runs overlapped. Locking now uses `flock(2)` through `bun:ffi`, so the external `flock` program is no longer needed. machine-guard's heavy-lock line and lock check use the package's own `heavy-run --status`.
- The subagent guard refuses only shell commands that run queue-close or queue-cancel (including `sh -c`, `$( )` and backticks), not commands that merely name such a file.
### Added
- `neurastream agents list|allow|deny` edits the spawn allow-list (`## Allowed` in notes/subagents.md). allow and deny count as writes to that protected file.
- `neurastream init --allow a,b`, or a one-time prompt on a terminal, sets the allow-list.
- `quota-reset "<time>" [--tz <zone>]` replaces glm-reset (config section `quota:`; works on macOS).
### Changed
- A config with `glm:` still loads (as `quota:`), and `pm:` is ignored. Each prints a notice in `doctor` and main-start.
- brief-lint applies the method-read rule only when `brief.method_marker` is set. The "`find` is broken" and coverage Probe rules are gone; add your own through `brief.repo_rules`. Default `heavy_marker` and `heavy_path`: `heavy-run`.
- CI runs the suite on macOS as well as Linux.
### Removed
- pm-fail-facts and the `pm:` config section; the unused herdr reporter.

## 0.1.24
### Security
- The public package no longer ships personal machine data. Neutral defaults in `templates/config.yml`, one neutral pin example instead of 18 personal pin files, help texts and queue template without personal remotes/paths, `docs/config.md` rewritten, `docs/inventory.md` deleted. npm identity (license, repo URLs) kept.
- `src` is config-driven: the repo-specific init special case and brief-lint rules moved to `brief.repo_rules` in config (default empty).
- New guard test `tests/no-personal-markers.test.ts` fails the suite if a marker reaches the shipped set.
### Added
- `neurastream uninstall [--purge]`: inverse of install + init. Removes bins pointing into the package, the omp plugin copy, template-identical pins; strips the managed AGENTS.md block keeping personal lines. `--purge` also removes config + agent_dir state (listed first, requires `--yes`, refuses outside `$HOME`).


## 0.1.23
### Added
- `templates/AGENTS.md` ships the neurastream orchestrator rules as a managed block. `adapter install omp` writes it into the live `~/.omp/agent/AGENTS.md` between markers, keeps every line outside them, and `doctor` reports `stale:` or `missing:` for the block.
### Changed
- The edit limit Main sees in each prompt comes from `guards.main_edit_limit` and `guards.main_window_min`, not from the rules text.
### Fixed
- `doctor` reports an absent bin as `missing:`, not `foreign:`.

## 0.1.22
### Added
- Progress trim: when Main ticks a plan phase, Progress entries beyond `queue.progress_keep` (default 6) move to `<plan dir>/archive/<name>-progress.md`; `queue-trim <plan> [--keep N]` does the same by hand.
### Fixed
- The plan-read guard refuses only new plan-read problems, and the cite scan skips the Progress section (incident I-20261023-14).
- Machine prompts (guard and rollover text sent as user messages) are not owner corrections, so they no longer count as owner messages or corrections in metrics (incident I-20261023-11).

## 0.1.21
### Fixed
- The edit-window guard no longer counts heredoc bodies (`python3 - <<'EOF'` prose) or punctuation-only redirect targets (`>,`) as project-file writes, so plan text no longer shows up as changes to files such as `<cwd>/,`.

## 0.1.20
### Fixed
- A pending rollover wins over the stop guard: `session_stop` reads the rollover state before `checkStop`. In `ready` and `wait-jobs` the stop is allowed (no queue, incident or cancel block and no "spawn an agent" text), and in `need-note` it is blocked by the note request only.

## 0.1.19
### Fixed
- The rollover request after a neurastream update says "a new neurastream version is installed (…)" instead of claiming the session grew past `rollover.max_session_mb`.

## 0.1.18
### Fixed
- Session rollover has one owner while a relaunch is pending: under neurastream main the owner's messages join the pending handoff (no second session, no stale relaunch) and `/main-rollover` is refused there; a second `/main-rollover` adds its text to the rollover in progress; `ready` refuses new subagent spawns like the other pending states.

## 0.1.17
### Fixed
- queue-close judges the real upstream default branch (local-path origin chains are followed and the default is fetched), keeps a plan worktree that is on another branch, falls back to docker chown and `worktree prune` when git cannot remove a worktree, and runs the done check in a temp worktree of that base when the plan worktree is missing or kept.

## 0.1.16
### Added
- Incidents: bugs this system finds in itself are written to `<paths.queue_state>/incidents.jsonl` and the guards push Main until each open incident has a plan or a recorded dismissal. Sources: real-time detectors (D1 ledger contradiction, D2 tool crash, D3 guard-block loop, D4 owner correction) at Main's prompt and after each Main bash result — D2/D4 on every event, D1/D3 at most once per `incidents.scan_interval_sec` (default 120) — a once-a-day M1-M5 regression check (`incidents.daily_worse_pct`, `incidents.daily_floor`), the weekly report's worst metric, and `neurastream incident add`. While incidents are open, every Main prompt lists them, spawns and bypass launches are refused unless the brief names a plan citing `INCIDENT <id>`, and the stop is gated. `neurastream incident plan/dismiss` records the resolution; a plan citing `INCIDENT <id>` must have a fail-before phase (its regression test has to fail on the old code), and closing such a plan records `fixed` for each id. `neurastream metrics report` gained M6: incidents opened / planned / dismissed / fixed and the median hours from open to fixed. Detectors read Main `wait` toolResults as finished results too.

## 0.1.15
### Fixed
- agent-ledger: a helper whose session ends on a final answer (last assistant message `stop`/`end_turn` with text, no `yield`) shows `done` instead of staying `RUNNING`, so it no longer trips `agent-ledger --cap` with a phantom `OVER-BUDGET`; `MAIN` sessions keep today's rule.

## 0.1.14
### Fixed
- Main rolls over even when the running plugin is older than the installed package: at every turn end the adapter re-reads the `package.json` it was loaded from, a different or unreadable version counts as over the rollover threshold, and the note request names both versions.
- A handoff note that is no longer fresh (it expired while own jobs ran) is asked for again — exactly once per expired note — instead of leaving the rollover stuck.
### Added
- While a rollover is pending (no fresh note, or own jobs still running), Main's `task` spawns are refused until the running jobs finish and the session rolls over.
### Changed
- `neurastream metrics report` groups every `open: <plan list>` guard-block reason into one `open: <list>` key instead of one key per list.

## 0.1.13
### Security
- GitHub Actions in `ci.yml` and `publish.yml` are pinned to full commit SHAs (tags kept as trailing comments) and a new `bunfig.toml` sets a 7-day `minimumReleaseAge` install cooldown: a moved tag or a fresh malicious release can no longer reach the `id-token: write` publish job or a local install.
### Added
- Self-metrics: `neurastream metrics report [--days N]` compares this window with the previous one (M1 cost per merge, M2 idle calls, M3 CI tries, M4 owner corrections, M5 guard blocks), writes `<notes>/metrics.md`, and marks the worst change. `metrics ci`, `metrics false-alarm` and `metrics rule` record CI tries (via `metrics.ci_pipelines_cmd`), guard false alarms and the owner's rule decisions. main-start shows the report as due when it is missing or older than `metrics.report_days`.


## 0.1.12
### Fixed
- Fixed: blockers judged words, not actions. `no-push` refused any command containing "push" (commit messages included), `deny-path` treated every word of a shell command as a path (`git diff uv.lock` was refused), and `deny-command` matched heredoc bodies and quoted text. Blockers now judge the command that runs and the files it writes; `git push`, `rm uv.lock` and `echo y > uv.lock` stay refused.

## 0.1.11
### Fixed
- A `neurastream main` relaunch ran on the default model and wrote its session outside `--session-dir`: it got only the handoff, not the first run's flags. A relaunch now keeps the first run's flags and drops only the first message and the session-picking or one-shot flags (`-r`, `-c`, `--restore`, `--goal`, `-p`, …).

## 0.1.10
### Changed
- Rollover threshold default `rollover.max_session_mb` is 5 MB (was 10). Existing config files keep their own value.
### Added
- `neurastream main` runs omp under a launcher: a session over the rollover threshold rolls over automatically once its handoff note is written and no own jobs are running. The launcher starts a fresh omp with the handoff as its first message; nobody has to type. Plain `omp` keeps the owner-message path. Handoffs over 100000 bytes are written to a file the first message points at.
### Fixed
- The rollover note sat in the protected queue state dir, so Main could not write it without the owner's unlock. Main may now `write` a `.md` directly in `<state>/rollover/`; subagents, shell writes and every other state file stay protected.
- The note request reached Main only on turns started by a prompt; turns started by a finished job never saw it. The request is now sent at turn end and starts a turn itself.

## 0.1.9
### Changed
- README rewritten for a public audience (what it is, what each part enforces, requirements, install, develop); package metadata adds keywords, homepage, bugs and `engines.bun`. No code changes.

## 0.1.8
### Fixed
- Session rollover froze omp for about 90 s: `main-rollover` ran the six `main-start` children with `spawnSync` on omp's only thread. The command now shows a notice at once and gathers main-start asynchronously; the `main-start` CLI output is unchanged.
- `agent-ledger` parsed every session file under the sessions dir before filtering by age (about 45 s for `--hours 12` on a 12 GB sessions dir). Files older than the window are now skipped unread.
- `agent-ledger --cap` counted every RUNNING or WAITING agent as using a provider slot, so agents whose sessions had died hours earlier could still make a provider FULL. An agent with no write for `ledger.idle_not_live_min` minutes (default 60) is now left out of the count and listed on a `NOT LIVE` line.

## 0.1.7
### Fixed
- `wip-check` no longer crashes on a linked worktree under a work root (git prints its common dir as an absolute path; it was joined onto the repo path), and lists unlanded branches with equal commit times in the same order as the original. `main-start` showed "wip-check gave no summary" because of the crash.
- `scripts/cutover.sh`: the plan picker's sed works on GNU sed; the before/after capture ignores finished agent-ledger rows that age out of the 12 h window during the run and the owner-hold reason the queue summary now shows.

## 0.1.6
### Fixed
- Cutover on a machine whose queue lives under `~/.omp/agent` no longer points the package at an empty `~/.config/neurastream/INDEX.md`: `neurastream init --agent-dir <dir>` keeps the index, notes, blockers, CANCELLED and unlock under `<dir>` and leaves `<dir>/queue/` to the adapter; `scripts/cutover.sh` passes `--agent-dir ~/.omp/agent` when `~/.omp/agent/INDEX.md` exists.
- `scripts/cutover.sh`: the HOME listing skips dirs the owner cannot read (rootless container storage); the before/after capture ignores idle-minute counters and lints the first plan the queue lists instead of any file under `docs/plans`.

## 0.1.5
### Fixed
- Process storm (fork bomb) under omp: auto-close and main-start ran `process.execPath <pkg>/src/cli/main.ts …`. Inside omp, `process.execPath` is the omp binary, so each close started a new omp session that loaded the plugin and auto-closed again, until memory ran out. Both now run the package's own executables (`bin/queue-close`, `src/cli/main.ts`). Regression test fakes `process.execPath` and checks it is never called.
- The idle-stop spin guard reset on the guard's own stop continuation, so a model that only replied text was nudged forever. Continuation turns now keep the streak.
- Main can no longer rewrite a plan file through the shell (`cat > plan`, `sed -i`): that route skipped Main's plan-text checks. Plans change through edit/write.
- One load route: `install` no longer links the extensions dir (plugin only) and removes only a stale symlink there; `doctor` lists the plugin link.
- Guard parity for the installed package (P8).
### Added
- `scripts/omp-sandbox-session-test.sh`: isolated real-omp session test (sandbox HOME, nine checks C1-C9, reaps its omp processes, refuses low memory, watchdog on process count/memory, no live `~/.local/bin` on the model's PATH).

## 0.1.4
### Fixed
- Release 0.1.3 was never published: its CI went red on GitHub runners only. `rollover-omp.test.ts` runs the omp adapter in-process, which writes `QUEUE_*` into the test process env. When bun ran that file first, the guard children in the guard tests inherited the runner's default `QUEUE_AGENT`, which beats the sandbox config, so 4 refusal tests saw "allowed". The guard tests now drop inherited `QUEUE_*`, and the rollover test restores what it wrote. A regression test simulates the leak. 0.1.4 ships everything listed under 0.1.3.

## 0.1.3
### Added
- Main reads the code for its plans: the omp adapter logs every file Main reads (Main read log; `touchedPaths` now applies `cd` left to right). Main's plan text must cite code it read within `plan_read_max_hours`. Plans stamped `20261021_0100` or later need a `Code read by Main` section (queue-check).
- Spawn guard: a brief must name an unticked phase of an open plan; research spawns for a plan are refused (Main researches its own plans).
- Session rollover: when Main's session file grows past `rollover.max_session_mb`, Main writes a handoff note, waits for running jobs and the owner's next message, then continues in a fresh session. Manual `/main-rollover` command. Rollover config and events are documented in the README "Session rollover".
- Owner holds come only from plans: the queue summary, compaction and handoff carry each plan's `WAITING on owner:` line, never holds from carried session notes.

## 0.1.2
### Added
- `agent-score validate <Agent> --plan <plan.md> --phase <P> --evidence <report.md> --section "<heading prefix>" [--weight N] [--rework] [--note T]`: score a validation phase (checks/tests ran, report section written, no commits). Records one `type: "validate"` jsonl line only when every guard holds: the plan's phase line is ticked `- [x]` (weight from its `difficulty: N`; `--weight` overrides), the evidence file has a heading starting with `--section` where the prefix ends at end-of-line, space or `(` (`## CP` matches `## CP (P5, ...)`, not `## CPX`) and its body to the next same-or-higher heading is non-blank, the body cites verbatim at least one `paths.heavy_log` `END   <Agent> | <label> | exit <n>` label run by that agent (the cited labels are recorded), and no earlier `accept`/`validate` covers the same agent+plan+phase. Any failed guard exits 1 with the reason and records nothing.
- Ranking board: column `Accepted (diag)` is now `Accepted (diag/val)`, cells `N (d/v)`; `validate` adds points and first-pass counts like `accept` (unless `--rework`).
