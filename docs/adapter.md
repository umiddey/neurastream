# Adapter interface

Core (`src/core`) never imports a harness and never names one. It calls `RunSource` for run data, and it exports the guard functions below. An adapter translates harness events into those calls. A harness that can only run a hook command uses `neurastream guard <event> --json` with the same JSON.

That is enough for a later hooks adapter (Claude Code), an OpenCode adapter, or a Codex adapter: one new folder under `src/adapters/`, zero core changes. If a new harness needs a core change, this interface is wrong. Fix this file and `src/core/adapter.ts` together.

## Run source (core calls the adapter)

```ts
export type RunStatus = "running" | "waiting" | "done" | "died";

export interface RunMessage {
  role: string;
  cost: number;
  text: string; // capped at 20000 chars, same as today's steering scan
}

export interface Run {
  id: string; // agent name, or "MAIN <stamp>" for the main thread
  kind: "main" | "sub";
  model: string; // "provider/model", or "?"
  calls: number;
  tokens: number;
  cacheRead: number;
  cost: number; // list dollars, whole run
  inputTokens: number; // last assistant call: input + cacheRead + cacheWrite
  status: RunStatus;
  statusDetail: string; // "done" | "RUNNING" | "WAITING: …" | "DIED: …" | "OVER-BUDGET(…)"
  startedAt: number | null;
  lastWriteAt: number; // mtime, unix seconds
  endedAt: number | null;
  messages: RunMessage[]; // main runs only; empty for sub runs
}

export interface MainSession {
  file: string;
  calls: { inputPlusCache: number }[];
  lastUser: { at: string; text: string } | null;
}

export interface RunSource {
  /** Runs whose last write is >= since (unix seconds). Includes main and sub. */
  listRuns(since: number): Run[];
  /** Newest main-thread session, or null. Used by main-health. */
  mainSession(): MainSession | null;
}
```

Core never opens a session file. The omp reader (only `src/adapters/omp/sessions.ts`) walks `adapter.sessions`:

- main file: `sessions/<project>/<session>.jsonl`, stem matches `/^\d{4}/`
- sub file: one level deeper, stem is the agent name
- model is `provider/model` when both fields are set, else a `model` string that already contains `/`
- a call is a message whose `usage.totalTokens` is set
- cost is the sum of `usage.cost.total`
- `session_exit` followed by later assistant activity means still running
- a `toolResult` with `toolName == "yield"` and no error means done, until a later assistant message
- `tool_execution_start` with `toolName == "wait"` means waiting
- status strings and the OVER-BUDGET suffix stay byte-for-byte with `agent-ledger` (thresholds from config)

External runs (the `oc-run` log) are core state under `paths.score_state`, not an adapter. `agent-score` merges them after `listRuns`. Their cost stays 0, matching today.

Steering cost is core: split each main assistant turn's cost across agent ids named in that turn or in the previous non-assistant text.

## Guard events (adapter or CLI calls core)

Every function returns a decision. It does not print, exit, or touch the harness.

```ts
export interface Decision {
  allow: boolean;
  reason: string; // empty when allow
  inject?: string; // extra context when allow (warn at call 90, edits left)
  restore?: { path: string; text: string }; // plan-edit: write this back
  state?: { callsSinceStop: number; idleStops: number }; // next stop counters to feed back
}

export interface ToolEvent {
  tool: string;
  input: Record<string, unknown>;
  cwd: string;
  agent: "main" | "sub";
  agentId: string;
  calls: number; // subagent calls so far, before this one
  paths: string[]; // optional: paths the harness knows about; core unions them with its own derivation
  writes: string[]; // optional: same, for write targets
  command: string; // shell or eval text, else ""
}

export interface SpawnEvent {
  agent: string;
  invocationKind: string; // "task" is the only allowed kind today
  brief: string; // context + task text, or the shell command for a bypass launch
}

export interface InjectEvent {
  inject: string; // the CLI stdin field accepts both spellings: "prompt" or "inject"
  agent: "main" | "sub";
}

export interface PlanEditEvent {
  path: string;
  before: string;
  after: string;
  agent: "main" | "sub";
}

export interface StopEvent {
  agent: "main" | "sub";
  callsSinceStop: number;
  idleStops: number;
  ledgerText: string; // agent-ledger stdout; core parses RUNNING/WAITING
}
```

| Function | Event | Today |
|---|---|---|
| `checkTool(e: ToolEvent)` | pre-tool | plan-guard `checkCall` plus the main edit limit and spawn-via-tool |
| `checkSpawn(e: SpawnEvent)` | spawn | allow-list, task-only, plan gate |
| `checkInject(e: InjectEvent)` | prompt-inject | queue summary + cancel flag; `{ allow: true, inject }`; resets Main's edit window and the stop counters (returned in `state`) |
| `checkPlanEdit(e: PlanEditEvent)` | plan-edit | outside `## Progress`, a Main-only line changed, or a subagent entry added without a `Findings:` line: `allow: false` and `restore`; each finding item of an allowed entry becomes a `findings` incident |
| `checkStop(e: StopEvent)` | stop | block while the queue is open and no live subagent, unless 3 idle stops; the next counters come back in `state` |

`checkTool` for a subagent also runs blocker scripts. Stdin JSON (unchanged):

```json
{"tool":"","input":{},"cwd":"","agent":"sub","repo":"","plan":"","paths":[]}
```

Exit 0 allows. Exit 2 plus one stderr line refuses. Timeout is `guards.blocker_timeout_ms` (10000).

The four blockers ship as executable scripts in the package (`blockers/deny-command`, `deny-path`, `deny-text`, `no-push`, shebang `bun`); the logic they share lives in `src/core/blockers.ts`. `neurastream init` copies them into `paths.blockers` so a plan's `- deny-command <regex>` line resolves (P6).

Main-only lines: `Status:`, `WAITING on owner:`, `Cancelled by owner:`, `False positive:`.

Protected paths come from `guards.protected`. Unlock is `paths.unlock` newer than `guards.unlock_minutes`.

## CLI (any harness)

```
neurastream guard <event> --json
```

Events: `pre-tool`, `prompt` (core id `inject`), `spawn`, `plan-edit`, `stop`.

Stdin is the matching event object. Stdout is one JSON `Decision`. Exit 0 when `allow` is true, exit 2 when false (same as a blocker). Extra context is the `inject` field, not a second channel.

A hook-only harness maps:

| Hook | Command |
|---|---|
| before tool | `neurastream guard pre-tool --json` |
| before prompt | `neurastream guard prompt --json` |
| before spawn | `neurastream guard spawn --json` |
| after a plan write | `neurastream guard plan-edit --json` |
| before stop | `neurastream guard stop --json` |

No core change. The adapter is a hook table plus a `RunSource` if that harness has session files. If it has none, `listRuns` returns `[]` and score/ledger show only `oc-run` records.

## omp adapter (`src/adapters/omp`)

Only this folder may name the harness. It does three things:

1. Session reader implementing `RunSource` (the jsonl rules above).
2. An extension module (`package.json` key `omp.extensions` → `["./src/adapters/omp/index.ts"]`) that subscribes to `session_start`, `before_agent_start`, `before_subagent_spawn`, `tool_call`, `tool_result`, and `session_stop`, and calls the core functions. Return values map to the harness shapes `{ block, reason }`, `{ additionalContext }`, `{ message }`, and `{ decision: "block", reason }`. `before_agent_start` is where an agent's context is filled: Main's queue summary (`checkInject`), a subagent's first turn (its plan's repo rules plus the owner's burden rule, both from `src/core/repo-rules.ts`), and the rules of a repo Main has just worked in — each handed over once per session and file version, never on every prompt.
3. A pane-state reporter owned by the pane host; this package does not ship it. It talks to a socket. Core does not. Adapter install links the extension entry under the sandbox HOME and does not edit the live agent directory.

Agent pins ship as templates. Adapter install copies `templates/agents/*.md` (no `.bak*`) into `adapter.pins` only when that file is absent.

Spawn names are the pin `name` field. Core checks the name against `## Allowed` in `paths.subagents`. It does not know which names exist.

The adapter comes up only under `neurastream main`: that launcher sets `NEURASTREAM_MAIN_LAUNCHER=1` (`MAIN_ENV` in `launch.ts`) for the omp it starts, and `ompExtension` registers nothing without it. The switch is an env var, not a flag, because children inherit the env: an omp a tool starts from inside Main stays guarded.

## Adding a feature

Core logic and its types live in `src/core` and name no harness — `tests/host-neutral.test.ts` and the substring scan in `tests/config.test.ts` hold that line. Whatever the feature must learn from the harness (sessions, traces, dumps, launch, install, doctor) goes through a `HarnessAdapter` member, and the CLI picks the adapter with `getAdapter(cfg)` on the config key `harness` — never an import from `src/adapters/omp/`.

- A hook-only harness needs no adapter code for guard decisions: it calls `neurastream guard <event> --json`, so a feature built on the guard functions works there unchanged.
- A feature that needs a harness capability no member covers adds one optional `HarnessAdapter` member (`member?`), and its doc comment states what happens when an adapter leaves it absent — normally the feature skips its harness-side part (empty list, `null`) and the core result still stands. A member a real second adapter cannot fill is an interface bug: make it optional with a documented absent behaviour, or fix the interface.

## Adding a harness

One folder under `src/adapters/`, one registry entry, zero core changes:

1. `src/adapters/<name>/` implements `HarnessAdapter` (the readers, `launchMain`, `install`, `doctor`). Only this folder may name the harness.
2. One entry in `ADAPTERS` in `src/adapters/index.ts`.
3. Nothing under `src/core` or `src/cli` changes: the CLI reaches the harness only through the registry, and `tests/host-neutral.test.ts` holds both rules.

The user picks it with `harness: <name>` in the config (default `omp`; an unknown name throws `unknown harness "<x>"; known: …`). What the new adapter must supply is the table below; a hook-only harness starts with `neurastream guard <event> --json` and, if it has no session files, a `RunSource` whose `listRuns` returns `[]` and whose `mainSession` returns `null`.

## What a later adapter must supply

| Need | If the harness has it | If it does not |
|---|---|---|
| runs with model, calls, dollars, status | `RunSource.listRuns` | return `[]` |
| main context size | `RunSource.mainSession` | return null |
| pre-tool | call `checkTool` or the CLI | |
| prompt-inject | call `checkInject` or the CLI, then append `repoRules` text for a repo this session has just worked in when `rulesChanged` says it is new (src/core/repo-rules.ts) | skip: no repo rules are injected, the queue summary still is |
| subagent rules | on the subagent's first turn, find the plan its brief names in the index, then inject `repoRules` + `burdenRule` once per session | skip: subagents start without the repo's AGENTS.md |
| spawn check | call `checkSpawn` or the CLI | |
| plan-edit restriction | call `checkPlanEdit` or the CLI, and apply `restore` if the harness will not | |
| stop | call `checkStop` or the CLI | |

Nothing else. Queue files, blockers, score events, and config are core.
