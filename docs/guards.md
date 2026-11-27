# Guards, Queue, and Autonomy

This document covers the core enforcement rules implemented in `src/core/guards.ts`, `src/core/queue/lib.ts`, `src/core/blockers.ts`, and `src/core/autonomy.ts`.

## Plan queue

- **One flat index**: Every open plan is a file in a repo's main checkout, listed as one absolute path per line in `paths.queue_index` (`INDEX.md`). The index file is kept `0444` on disk; agents modify it only through `neurastream queue add <plan.md> [--rank N]` and `neurastream queue move <plan.md> <rank>`.
- **One plan = one worktree**: Two open plans cannot name the same `Worktree:`. A plan file itself must live in the main checkout, never inside a linked worktree.
- **Merge-verified close (`queue-close`)**: A plan leaves the queue only when git verifies its branch landed on the upstream default branch (ancestor, squash/rebase probe via `git merge-tree` / `git cherry`, or verified `Landed:` commit) and its `## Done check` passes. A failing check reopens the plan.
- **Worktree & branch cleanup**: Closing removes a clean, landed worktree via `git worktree remove` (dirty, unmerged, or main checkouts are kept with the reason) and deletes merged branches only via `git branch -d`.
- **Forge sweep & finished search**: `queue-check` flags open forge MRs not referenced by any open plan (skipping unreachable repos). `queue-finished <word>` searches `FINISHED.md`.
- **Legacy migration**: `neurastream queue migrate` folds older per-repo `INDEX.md` files into the single main index.

## Blockers and guards

- **Plan blockers**: Each plan's `## Blockers` section lists executable guards (`no-push`, `deny-path`, `deny-command`, `deny-text`, or plan-local scripts). Blockers judge the actual command and modified files rather than words inside commit messages, quoted text, or heredoc bodies.
- **Progress-only edits for helpers**: Subagents may only append to `## Progress`. Every new entry must end with a `Findings:` line (`Findings: none`, or semicolon-separated items with `file:line` evidence) or the edit is refused and the file restored.
- **Helper call budgets**: Default warning at call 90 (`guards.sub_warn_calls`), hard stop at call 100 (`guards.sub_max_calls`). Main can override per run via `Call budget: <N>` in the task brief (10 to `guards.sub_max_calls_cap`, default 200; requires a task `name`).
- **Main call cap**: At most `guards.main_max_calls` (default 15) tool calls per Main turn, warning at `guards.main_warn_calls` (12). Tools in `guards.main_call_exempt_tools` (`task`, `todo`, `ask`, `wait`) are exempt; `0` or `tier full` disables the cap.
- **Tools and limits card**: Each owner prompt (not a `main-guard:` continuation) gets a card of at most three lines beside the queue summary: `Tools and limits`, then `Calls: N per turn (warn at W)` (or `Calls: off` when the cap is off), then, when open plans carry `deny-command` blockers, `Deny-commands (open plans): <plan>: <args> | … | +N more` (three shown). The card shows the caps only: no live counts, no reset times, no unlock path.
- **Limit wake**: When a stop is allowed while a call cap or edit window is spent (calls at `guards.main_max_calls`, or edits at the tier's edit limit) and open plans remain (WAITING and awaiting-merge plans do not count), a 30-second timer arms and sends one `main-guard: the call/edit limit has reset — continue the queue where you stopped.` message at the latest pending reset. Nothing is sent if the queue is empty at reset, and an unreadable queue never arms it. Any owner prompt cancels it. It lives in memory only: a restart or reload drops it, and the next owner prompt or stop re-checks the limits. There is no config key: it is on exactly when the caps are on, so tier `full` never arms it.
- **Protected files & unlock**: Guard files, state directories, and `~/.config/neurastream/config.yml` require an owner unlock (`paths.unlock`, valid `guards.unlock_minutes`, default 30). When `guards.chat_unlock` is enabled, the owner's whole chat message `unlock` / `unlock N` / `lock` updates the unlock file directly.
- **Write-time lint checks (`write_check`)**: Off by default. When `write_check.enabled: true`, subagent writes/edits to configured extensions are linted before and after the call; adding a lint finding or suppression comment (`noqa`, etc.) restores the file and returns an error. Rules in `write_check.defer_rules` are checked at turn end instead so declare-then-use edits work.

## Review, read, and brief gates

- **Code read by Main**: Main's non-`task` tool calls log touched file paths to `<queue_state>/main-reads.json`. Every file listed under `## Code read by Main` must exist and have been read within `guards.plan_read_max_hours` (default 24h; reads in either the main checkout or the plan's worktree count). Cited files that Main *did* read are auto-listed on save; unread citations are refused.
- **Plan & code review (`review.*`)**:
  - Plans require a `## Reuse` section.
  - Spawns require a current reviewer `PLAN REVIEW: PASS` recorded by a read-only reviewer subagent from `review.agents` (default `["reviewer"]`; must be listed in `## Allowed` of `notes/subagents.md`). Editing the plan body expires the pass; ticking a phase checkbox does not.
  - With `review.code: true`, ticking a phase requires a `CODE REVIEW: PASS` covering that phase after the last implementer entry.
  - Spawns are also refused if the plan's repo has unmerged MRs/branches not named in the brief (`MR !N:` / `Branch <name>:`).
- **Brief lint (`brief-lint`)**: Enforces required brief sections (acceptance criteria, stop condition, no push, call budget, unticked phase id, main-checkout plan path, and allowed file paths).
- **Reuse map gate (`reuse_map`, opt-in via `neurastream reuse on`)**: A plan's `## Reuse` section needs either a map line or a none line, not both. The map line is `- map: graphify "t1", "t2" → a.ts, b.ts — cite: N` (N = min(min_cited, files)); the none line is `- new: none to reuse — searched: "t1", "t2", "t3"` (at least 3 distinct terms, and no term may match a file). Each `new:` citation quotes the file's line as `checked: <path>:<n> "<exact text>"`. At most 8 terms per line. Refusals name the fix: run `neurastream reuse map <plan> "<term>"...` and paste its line when the map moved or is stale; run `neurastream reuse on <repo>` when the repo is not mapped; `uv tool install graphifyy==0.9.100` when the pinned graphify is missing; `neurastream reuse off` to drop the gate. A term starting with `-` is refused because graphify reads it as an option.

## Queue holds and live re-check

- A parked plan carries one Main-only line:
  ```text
  WAITING on owner: <what to do> — blocked: <what stays stuck> — why you: <why Main cannot do it> — still true if: `<cmd>`
  ```
  (`blocked`, `why you`, and `still true if` are optional).
- When `still true if: \`<cmd>\`` is present, `neurastream` runs `<cmd>` in the plan's worktree (timeout `queue.waiting_check_timeout_sec`, default 60s; cached `queue.waiting_check_ttl_sec`, default 600s). A non-zero exit hides the phone card, flags `[STALE?]` in the queue summary, fails `queue-check`, and opens a `stale-hold` incident without editing the plan.
- Dated `## Progress` entries claiming a phase done/complete/finished must quote that phase's `verify:` command (or `## Done check`) with a result mark (`exit 0`, `N pass`, `fail`, `result`), or `queue-check` fails with `unbacked done claim`.

## Queue priority

- `INDEX.md` line order is priority (rank 1 = top).
- Spawning on a lower-ranked plan while a higher plan is idle (open, unstaffed, no `WAITING on owner:`, not awaiting merge, not waiting via `Waits on:`) is refused unless the brief includes `Priority skip: <plan> — owner: "<at least 4 words from a last-24h owner message>"` (or `Main: "<reason>"` in `tier full`).
- `Waits on: <plan>` lines (Main-only) enforce dependency ordering: an open plan cannot sit above an open plan it waits on (`queue-check` fails and UI drag-reorders are refused).

## Autonomy tiers and planner mode

- **Autonomy tiers (`autonomy.tier`, default `opinionated`)**: Switched via chat `tier strict|opinionated|full` (when `guards.chat_unlock: true`) or the owner phone page; stored in guard-protected `<queue_state>/autonomy-tier`.
  - `strict`: Caps Main edits at `autonomy.strict_edit_limit` per `guards.main_window_min` and blocks `git push` / `glab mr merge` / `gh pr merge` until the owner sends `autonomy.go_phrase` (default `go push`, valid `autonomy.go_minutes` for one landing).
  - `opinionated`: Standard `guards.main_edit_limit` and `guards.main_max_calls`.
  - `full`: Drops edit/call caps and allows Main-authored `Priority skip:` lines.
  - Owner-only protections (guard files, phone UI start, notify secrets, local `npm publish`, tier file) never loosen in any tier.
- **Planner mode (`autonomy.planner`, default `main`)**: Switched via chat `planner main|delegated` or `neurastream config set autonomy.planner delegated`.
  - `main`: Main researches code and writes plans.
  - `delegated`: A planner subagent (`Planner role for <plan path>` brief, `Planner: <agent>` header) owns the plan body and `## Code read by Main`; Main routes asks, dispatches implementers, verifies outcomes, and may only adjust `## Done check` and `verify:` commands.
  - Anchored by an owner-only `<config_dir>/guard-baseline` file; non-owner edits to the mode file or config key are automatically reverted.

## Several Mains

Run multiple Mains on the same queue with distinct names (`[a-z0-9-]{1,24}`):

```sh
neurastream main --name a
neurastream main --name b
```

- Each Main holds its own kernel-released running lock, inbox cursor, rollover notes, and edit window under `<queue_state>/mains/<id>/`.
- Spawning, editing, ticking, closing, or pushing on a plan claims it under `<queue_state>/claims/`. Another Main's live claim refuses the action.
- Claims stay alive via a 1-minute heartbeat while the session runs and expire automatically after `queue.claim_ttl_min` (default 30 min) if a Main dies.
- CLI: `neurastream claim list`, `neurastream claim next`, `neurastream claim release <plan> [--force]` (`--force` is owner-only in a terminal).
- Owner inbox messages prefixed with `@<id> ` route only to that running Main; unprefixed messages go to all running Mains.

## Managed `AGENTS.md`, project rules, and skill pack

- **Main rules**: Under `neurastream main`, rules rendered from `templates/AGENTS.md` are injected into Main's system prompt each turn rather than modifying your personal `AGENTS.md`.
- **Project rules (`src/core/repo-rules.ts`)**: Subagents receive their plan repo's live `AGENTS.md` once on turn 1; Main receives a repo's `AGENTS.md` the first time a session touches that repo (and again only if the file changes), capped at `rules.max_bytes` (default 24,000).
- **Skill pack (`templates/skills/`)**: `neurastream adapter install omp` copies bundled skills (such as `architecture-drilldown`) to `~/.agents/skills/<name>/` only if missing, preserving local edits.
