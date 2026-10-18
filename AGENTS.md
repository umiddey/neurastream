# omp-orchestrator: rules

What this is: the owner's agent-orchestration setup (queue, guards, blockers, scoring, ledger, briefs, health scripts) packaged as one installable npm package + omp plugin.

- Runtime: Bun + TypeScript only. CLI shebangs `#!/usr/bin/env bun`. No Python, no Node-only entry points.
- Green = `bun run typecheck` exit 0 AND `bun test` exit 0.
- No hardcoded `/home/ukd`, repo paths, branch names, provider names or prices in code. Everything comes from the config file (defaults documented in README.md).
- Behaviour of every ported command must match the original script it replaces (same exit codes, same refusal rules). Golden tests compare against recorded output of the original.
- Never read, copy or commit secrets: `~/.config/gateforge/**`, `*.env*`, `*keys*.txt`, `mcp.json`, keyrings.
- Never touch the live setup (`~/.omp/agent`, `~/.local/bin`, `~/.local/state`): read only. Tests and smokes run under a sandbox `HOME=/tmp/orch-home-*`.
- Never publish to npm. Never link/install the package into the real HOME. Main does the cutover with the owner.
- Never push. Main pushes.
- INDEX.md stays out of git.
