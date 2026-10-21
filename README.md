# neurastream

Agent orchestration (queue, guards, blockers, scoring, ledger) as one installable package. The core does not name a harness. Adapters translate harness events into core calls. The first adapter is omp.

## Install

Do not install into the real home while this package is still being built. Use a sandbox home.

```sh
export HOME=/tmp/neurastream-home-dev
bun add -g neurastream
neurastream init
neurastream adapter install omp
```

`init` writes `~/.config/neurastream/config.yml` from the defaults in `docs/config.md`, plus an empty index, notes, the queue template, blocker wrappers, and the state directories. A second run changes nothing. `adapter install omp` links the extension under that same home (`~/.omp/agent/extensions` and `omp plugin link`). Neither command touches `~/.omp` or `~/.local` of the real user.

Check the merged result:

```sh
neurastream config --json
```

Compatibility bins keep today's names (`agent-score`, `agent-ledger`, `brief-lint`, `oc-run`, `wip-check`, `wip-backup`, `wip-snapshot`, `pm-fail-facts`, `main-health`, `queue-check`, `queue-close`, `queue-cancel`, `main-start`, `machine-guard`, `glm-reset`, `priority-watch`, `resource-alerts`, `tmp-snapshot`, `heavy-run`). They are the same program, selected by the bin name.

Scoring: `agent-score accept` records accepted work by commit; `agent-score validate <Agent> --plan <plan.md> --phase <P> --evidence <report.md> --section "<heading prefix>"` records a validation phase (checks/tests ran, report section written, no commits) with proof Main cannot fake by typing: the plan line must be ticked `- [x]`, the cited section body must name a heavy-run label run by that agent (from `paths.heavy_log`), and the phase must not be scored already. The ranking board counts it in `Accepted (diag/val)` as `N (d/v)`.

Green is `bun run typecheck` and `bun test`, both exit 0.

## Main reads the code for its plans

Owner rule: never write a plan when another agent is doing the research or reading for you. When Main writes a plan, Main reads the relevant code itself and lists those files in the plan.

- Logged: every non-`task` call Main makes adds the paths it touches to `main-reads.json` in the queue state dir (`paths.queue_state`), with the time. A `grep -n` result adds each file it names (`path:line:` at a line start), resolved against the call's directory.
- Window: `guards.plan_read_max_hours` (default 24, `docs/config.md`). Every file listed under `## Code read by Main` must exist and have a logged read within that many hours. A backticked path cited elsewhere in the plan, outside `docs/plans/`, must also be listed there.
- Cutoff: plans whose filename stamp is `20261021_0100` or later must carry a non-empty `## Code read by Main` section. Older plans are grandfathered.
- Retention: entries older than 7 days are dropped on each write.
- Spawn briefs: a brief must name an unticked phase id of the plan (for example `P4`). A brief that asks for research for a plan to be written is refused, quoting the owner rule.

## Changing a script

Edit the script in this repo. Green is `bun run typecheck` and `bun test`, both exit 0. Main tags the release. The publish workflow puts that tag on npm. Then:

```sh
bun add -g neurastream@latest
neurastream adapter install omp
```

Live copies are never hand-edited. `neurastream doctor` names each hand-edited or foreign installed file, and a stale install (the installed version is not `npm view neurastream version`). If the registry cannot be reached, that check is a warning, not a failure.
