# Orchestrator setup as an npm package + omp plugin
Worktree: /home/ukd/projects/omp-orchestrator
Branch: feat/package
PRIORITY-ID:

## Goal
- Owner (2026-10-18 23:00): "is there a way we can version control our entire setup like the way we run shit here along with the scripts and everything" → "by version control i meant productionize, with npm and shit".
- Done = one versioned package (`omp-orchestrator`) that a fresh machine installs with `bun add -g` + `omp plugin link`, then `omp-orchestrator init`, and gets the same queue, guards, blockers, scoring, ledger and brief rules we run today, driven by one config file instead of hardcoded paths.

## Forbidden
- Read /home/ukd/projects/opus-implementer-method.md first and work by it. `find` is broken: use grep/glob/read.
- Read /home/ukd/projects/omp-orchestrator/AGENTS.md first; its rules apply.
- Never push. Never publish to npm. Never link or install the package into the real HOME; every smoke uses `HOME=/tmp/orch-home-<name>`.
- Live setup is READ ONLY (source to port from): /home/ukd/.omp/agent, /home/ukd/.local/bin, /home/ukd/.local/state. Never edit, move or delete anything there.
- Never read or copy secrets: /home/ukd/.config/gateforge/**, any `*.env*`, `*keys*.txt`, `mcp.json`, keyrings.
- No behaviour change while porting: same rules, same thresholds, same exit codes. Anything that looks wrong in an original goes in your Progress bullet, not into the port.
- Out of scope (personal tools, not orchestration): ai-terminal, claude-*, codex/gemini/copilot/opencode/pi wrappers, kbd/voice/mic/pamixer scripts, muse, qwen-local, omp-local-qwen, token-*, git wrapper, git-secret-gate, python entry-point shims.
- Budget: stop and write your Progress bullet within ~100 tool calls (bullet by call 85: done, verified with command+result, commits, next step).
- No questions at the end: decide by the rules here, record the decision.

## Blockers
- no-push
- deny-path /home/ukd/.omp/agent/** /home/ukd/.local/bin/** /home/ukd/.local/state/** /home/ukd/.config/** INDEX.md
- deny-command npm\s+publish bun\s+publish npm\s+link bun\s+link\b(?!.*HOME=/tmp/orch-home) --no-verify git\s+add\s+(-A|--all|\.)(\s|$)

## Phases
- [ ] P1 Inventory: `docs/inventory.md` lists every in-scope file (below) with: language, lines, what it enforces, every hardcoded path/branch/provider/price/threshold it uses, and the config key that replaces it; `docs/config.md` defines the config file (`~/.config/omp-orchestrator/config.yml`) with defaults equal to today's values — difficulty: 3 — verify: `cd /home/ukd/projects/omp-orchestrator && test -s docs/inventory.md && test -s docs/config.md && grep -c "config key" docs/inventory.md`
- [ ] P2 Package skeleton: package.json (`name: omp-orchestrator`, `bin` for every command, `omp.extensions`, `files`), tsconfig, `typecheck` + `test` scripts, config loader with schema validation and defaults, README install section — difficulty: 2 — verify: `cd /home/ukd/projects/omp-orchestrator && bun install && bun run typecheck && bun test`
- [ ] P3 Port the Python commands to Bun TS on the config loader: agent-score, agent-ledger, brief-lint, oc-run, wip-check, wip-backup, wip-snapshot, pm-fail-facts, main-health. Golden tests: for each, record the original's stdout+exit code on a sandbox copy of real state (copy the needed state files into /tmp/orch-home-golden, never secrets), and assert the port matches — difficulty: 4 — verify: `cd /home/ukd/projects/omp-orchestrator && bun test tests/golden && bun run typecheck`
- [ ] P4 Move the Bun/bash commands onto the config loader: queue-check, queue-close, queue-cancel (+ queue/lib.ts, queue/TEMPLATE.md), main-start, machine-guard, glm-reset, priority-watch, resource-alerts, tmp-snapshot, heavy-run (from /home/ukd/Work/heavy-run.sh); same golden tests — difficulty: 4 — verify: `cd /home/ukd/projects/omp-orchestrator && bun test tests/golden && bun run typecheck`
- [ ] P5 Plugin content: extensions main-guard.ts, plan-guard.ts, herdr-omp-agent-state.ts (path constants → config); blockers (_blocker, deny-command, deny-path, deny-text, no-push) ported to TS with the same CLI contract plan-guard calls; agent pins from /home/ukd/.omp/agent/agents/*.md (skip `.bak*`) under `agents/` as templates; rules templates for AGENTS.md / subagents.md allowed list. Tests: plan-guard refuses a denied command and a denied path for a toy plan; main-guard counts the 5-change window — difficulty: 4 — verify: `cd /home/ukd/projects/omp-orchestrator && bun test tests/plugin && bun run typecheck`
- [ ] P6 `omp-orchestrator init`: creates config with defaults, INDEX.md, notes/ (ranking, subagents, lessons), queue template, state dirs; idempotent (second run changes nothing). End-to-end sandbox smoke: `bun pm pack` → install tarball under HOME=/tmp/orch-home-e2e → init → write a toy repo + plan → queue-check exit 0 → agent-score accept + board → a blocker refusal → queue-close on a merged toy branch. Paste the transcript into `docs/smoke.md` — difficulty: 3 — verify: `cd /home/ukd/projects/omp-orchestrator && test -s docs/smoke.md && grep -q "queue-close" docs/smoke.md`

## Done check
`cd /home/ukd/projects/omp-orchestrator && git merge-base --is-ancestor HEAD origin/main && bun run typecheck && bun test`

## Progress
Status: open
- 2026-10-18 23:10 (Main): repo created, plan written. Implementer: GLM. Acceptance per phase = its verify command exits 0 in your own latest run plus the golden/plugin tests named there; report Gate missing before -> after as "n/a (no gateforge)".

## Background
- Source inventory (read-only): bins in /home/ukd/.local/bin (python: agent-score 312 lines, agent-ledger 128, brief-lint 81, oc-run 39, wip-check 70, wip-backup 112, wip-snapshot 110, pm-fail-facts 77, main-health 47; bun: queue-check, queue-close, queue-cancel; bash: main-start, machine-guard, glm-reset, priority-watch, resource-alerts, tmp-snapshot.sh); /home/ukd/Work/heavy-run.sh; /home/ukd/.omp/agent/{extensions,queue,blockers,agents,notes}; rules in /home/ukd/.omp/agent/AGENTS.md.
- Not packaged: sessions, databases, memories, blobs (runtime data); secrets; project-specific PM batch scripts in ~/.config/gateforge/pm-batch (they hold keys).
- After review Main does the cutover with the owner (guard files are locked: owner `touch ~/.omp/agent/.guard-unlock`): link the package, retire the old copies, keep command names identical so AGENTS.md needs no rename. npm publish (public vs private scope) is an owner decision after cutover.
