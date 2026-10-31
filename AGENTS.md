# neurastream: rules

What this is: the owner's agent-orchestration system (plan queue, guards, blockers, worker scoring, provider ledger, brief lint, machine/WIP health) as one installable npm package. It is harness-agnostic: today it runs under omp; later it must run under other agent harnesses (Claude Code, OpenCode, Codex, …) without touching the core.

## Architecture (hard rule)
- `src/core/`: all rules and state. Plain TypeScript, no harness imports, no harness names in logic. Talks to the outside only through the adapter interface in `src/core/adapter.ts`.
- `src/adapters/<harness>/`: thin glue per harness. Only these files may import or name a harness. First adapter: `omp` (plugin package `omp.extensions`, session/cost reader, subagent spawn names).
- `src/cli/`: the `neurastream` CLI (npm package `neurastream`) (subcommands) + compatibility bins with today's names. Every guard decision is also reachable as a CLI call with JSON in/out (`neurastream guard <event> --json`), so any harness that can run a hook command can use it.
- Adding a harness = one new adapter folder + tests; zero core changes. A core change needed for a new harness means the interface is wrong: fix the interface.

## Engineering
- Runtime: Bun + TypeScript only. CLI shebangs `#!/usr/bin/env bun`. No Python.
Green = `bun run typecheck` exit 0 AND `bun run lint` exit 0 AND `bun test` exit 0.
- No hardcoded `/home/ukd`, repo paths, branch names, provider names, models or prices in code. All from `~/.config/neurastream/config.yml` (defaults documented in README.md).
- Every ported command matches the original script it replaces (same exit codes, same refusal rules). Golden tests compare against recorded output of the original.
- Never read, copy or commit secrets: `~/.config/gateforge/**`, `*.env*`, `*keys*.txt`, `mcp.json`, keyrings.
- Never touch the live setup (`~/.omp/agent`, `~/.local/bin`, `~/.local/state`): read only. Tests and smokes run under a sandbox `HOME=/tmp/neurastream-home-*`.
- Never publish to npm. Never link/install into the real HOME. Never push. Main does push, cutover and publish with the owner.
- INDEX.md stays out of git.
