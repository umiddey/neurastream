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
}

export interface ToolEvent {
  tool: string;
  input: Record<string, unknown>;
  cwd: string;
  agent: "main" | "sub";
  agentId: string;
  calls: number; // subagent calls so far, before this one
  paths: string[];
  writes: string[];
  command: string; // shell or eval text, else ""
}

export interface SpawnEvent {
  agent: string;
  invocationKind: string; // "task" is the only allowed kind today
  brief: string; // context + task text, or the shell command for a bypass launch
}

export interface PromptEvent {
  prompt: string;
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
| `promptInject(e: PromptEvent)` | prompt-inject | queue summary + cancel flag; `{ allow: true, inject }` |
| `checkPlanEdit(e: PlanEditEvent)` | plan-edit | outside `## Progress`, or a Main-only line changed: `allow: false` and `restore` |
| `checkStop(e: StopEvent)` | stop | block while the queue is open and no live subagent, unless 3 idle stops |

`checkTool` for a subagent also runs blocker scripts. Stdin JSON (unchanged):

```json
{"tool":"","input":{},"cwd":"","agent":"sub","repo":"","plan":"","paths":[]}
```

Exit 0 allows. Exit 2 plus one stderr line refuses. Timeout is `guards.blocker_timeout_ms` (10000).

Main-only lines: `Status:`, `WAITING on owner:`, `Cancelled by owner:`, `False positive:`.

Protected paths come from `guards.protected`. Unlock is `paths.unlock` newer than `guards.unlock_minutes`.

## CLI (any harness)

```
neurastream guard <event> --json
```

Events: `pre-tool`, `prompt`, `spawn`, `plan-edit`, `stop`.

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
2. An extension module (`package.json` key `omp.extensions` → `["./src/adapters/omp/index.ts"]`) that subscribes to `session_start`, `before_agent_start`, `before_subagent_spawn`, `tool_call`, `tool_result`, and `session_stop`, and calls the core functions. Return values map to the harness shapes `{ block, reason }`, `{ additionalContext }`, `{ message }`, and `{ decision: "block", reason }`.
3. A copy of the herdr pane reporter. It talks to a socket. Core does not. Adapter install links the extension entry under the sandbox HOME and does not edit the live agent directory.

Agent pins ship as templates. Adapter install copies `templates/agents/*.md` (no `.bak*`) into `adapter.pins` only when that file is absent.

Spawn names are the pin `name` field. Core checks the name against `## Allowed` in `paths.subagents`. It does not know which names exist.

## What a later adapter must supply

| Need | If the harness has it | If it does not |
|---|---|---|
| runs with model, calls, dollars, status | `RunSource.listRuns` | return `[]` |
| main context size | `RunSource.mainSession` | return null |
| pre-tool | call `checkTool` or the CLI | |
| prompt-inject | call `promptInject` or the CLI | |
| spawn check | call `checkSpawn` or the CLI | |
| plan-edit restriction | call `checkPlanEdit` or the CLI, and apply `restore` if the harness will not | |
| stop | call `checkStop` or the CLI | |

Nothing else. Queue files, blockers, score events, and config are core.
