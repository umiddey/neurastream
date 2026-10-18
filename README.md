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

`init` writes `~/.config/neurastream/config.yml` from the defaults in `docs/config.md`. A second run changes nothing. `adapter install omp` links the extension under that same home. Neither command touches `~/.omp` or `~/.local` of the real user.

Until those two commands land, check the loader:

```sh
neurastream config --json
```

Compatibility bins keep today's names (`agent-score`, `agent-ledger`, `brief-lint`, `oc-run`, `wip-check`, `wip-backup`, `wip-snapshot`, `pm-fail-facts`, `main-health`, `queue-check`, `queue-close`, `queue-cancel`, `main-start`, `machine-guard`, `glm-reset`, `priority-watch`, `resource-alerts`, `tmp-snapshot`, `heavy-run`). They are the same program, selected by the bin name.

Green is `bun run typecheck` and `bun test`, both exit 0.
