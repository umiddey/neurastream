# neurastream P6 sandbox smoke

date: 2026-10-19T04:24:40+02:00
HOME=/tmp/neurastream-home-e2e

## bun pm pack
bun pack v1.3.14 (0d9b296a)

packed 1.24KB package.json
packed 2.14KB AGENTS.md
packed 1.34KB README.md
packed 210B bin/agent-ledger
packed 210B bin/agent-score
packed 210B bin/brief-lint
packed 210B bin/glm-reset
packed 210B bin/heavy-run
packed 210B bin/machine-guard
packed 210B bin/main-health
packed 210B bin/main-start
packed 210B bin/oc-run
packed 210B bin/pm-fail-facts
packed 210B bin/priority-watch
packed 210B bin/queue-cancel
packed 210B bin/queue-check
packed 210B bin/queue-close
packed 210B bin/resource-alerts
packed 210B bin/tmp-snapshot
packed 210B bin/wip-backup
packed 210B bin/wip-check
packed 210B bin/wip-snapshot
packed 124B blockers/deny-command
packed 118B blockers/deny-path
packed 118B blockers/deny-text
packed 114B blockers/no-push
packed 8.42KB docs/adapter.md
packed 7.47KB docs/config.md
packed 21.89KB docs/inventory.md
packed 28.24KB docs/plans/20261018_2306_neurastream_package.md
packed 10.00KB docs/smoke.md
packed 5.92KB scripts/smoke-e2e.sh
packed 14.38KB src/adapters/omp/herdr-agent-state.ts
packed 10.94KB src/adapters/omp/index.ts
packed 4.73KB src/adapters/omp/install.ts
packed 8.68KB src/adapters/omp/sessions.ts
packed 2.68KB src/cli/commands.ts
packed 2.40KB src/cli/dispatch.ts
packed 3.69KB src/cli/guard.ts
packed 6.68KB src/cli/init.ts
packed 387B src/cli/main.ts
packed 357B src/cli/runtime.ts
packed 1.92KB src/core/adapter.ts
packed 4.84KB src/core/agent-ledger.ts
packed 14.43KB src/core/agent-score.ts
packed 7.27KB src/core/blockers.ts
packed 4.96KB src/core/brief-lint.ts
packed 0.70KB src/core/clock.ts
packed 9.69KB src/core/config.ts
packed 1.54KB src/core/glm-reset.ts
packed 22.43KB src/core/guards.ts
packed 1.82KB src/core/heavy-run.ts
packed 0.68KB src/core/help.ts
packed 59B src/core/index.ts
packed 1.51KB src/core/machine-guard.ts
packed 1.36KB src/core/main-health.ts
packed 1.91KB src/core/main-start.ts
packed 3.63KB src/core/oc-run.ts
packed 4.92KB src/core/pm-fail-facts.ts
packed 0.89KB src/core/priority-watch.ts
packed 0.94KB src/core/proc.ts
packed 3.97KB src/core/pyfmt.ts
packed 2.12KB src/core/pyjson.ts
packed 4.36KB src/core/queue-cancel.ts
packed 1.82KB src/core/queue-check.ts
packed 11.85KB src/core/queue-close.ts
packed 0.59KB src/core/queue/env.ts
packed 23.75KB src/core/queue/lib.ts
packed 0.78KB src/core/resource-alerts.ts
packed 0.77KB src/core/tmp-snapshot.ts
packed 4.86KB src/core/wip-backup.ts
packed 3.24KB src/core/wip-check.ts
packed 5.32KB src/core/wip-snapshot.ts
packed 453B templates/agents/apodex.md
packed 1.13KB templates/agents/bunny-user.md
packed 12.72KB templates/agents/bunny.md
packed 0.87KB templates/agents/composer.md
packed 13.22KB templates/agents/deepseek.md
packed 12.71KB templates/agents/gemini.md
packed 13.16KB templates/agents/glm.md
packed 12.69KB templates/agents/grok.md
packed 12.86KB templates/agents/haiku.md
packed 12.86KB templates/agents/hiko.md
packed 12.75KB templates/agents/ling.md
packed 11.94KB templates/agents/local-qwen.md
packed 12.0KB templates/agents/luna-medium.md
packed 14.95KB templates/agents/luna.md
packed 13.19KB templates/agents/muse.md
packed 13.19KB templates/agents/sol-xhigh.md
packed 13.21KB templates/agents/sol.md
packed 3.94KB templates/config.yml
packed 295B templates/help/agent-ledger.txt
packed 1.66KB templates/help/agent-score.txt
packed 291B templates/help/brief-lint.txt
packed 243B templates/help/main-health.txt
packed 374B templates/help/oc-run.txt
packed 441B templates/help/pm-fail-facts.txt
packed 0.77KB templates/help/wip-backup.txt
packed 315B templates/help/wip-check.txt
packed 0.74KB templates/help/wip-snapshot.txt
packed 3.61KB templates/machine-guard.sh
packed 165B templates/notes/lessons.md
packed 307B templates/notes/subagents.md
packed 1.62KB templates/queue/TEMPLATE.md
packed 1.18KB templates/resource-alerts.sh
packed 1.67KB templates/tmp-snapshot.sh
packed 299B tests/cli.test.ts
packed 5.18KB tests/config.test.ts
packed 18.23KB tests/golden/ports-p4.test.ts
packed 19.38KB tests/golden/ports.test.ts
packed 19.28KB tests/guards-omp.test.ts
packed 19.24KB tests/guards.test.ts
packed 7.88KB tests/herdr-agent-state.test.ts
packed 3.54KB tests/init.test.ts
packed 345B tsconfig.json

/tmp/tmp.9HT0Zl2ahJ/neurastream-0.0.0.tgz

Total files: 115
Shasum: 4febafe8a7b20e97fe6926162b1b1e80980a9805
Integrity: sha512-1WvAHwTfFD41R[...]oMz7r+4Mvvebg==
Unpacked size: 0.59MB
Packed size: 133.31KB
tarball=/tmp/tmp.9HT0Zl2ahJ/neurastream-0.0.0.tgz

## install tarball under HOME=/tmp/neurastream-home-e2e
bun add v1.3.14 (0d9b296a)
Resolving dependencies
Resolved, downloaded and extracted [1]
Saved lockfile

installed neurastream@/tmp/tmp.9HT0Zl2ahJ/neurastream-0.0.0.tgz with binaries:
 - neurastream
 - agent-score
 - agent-ledger
 - brief-lint
 - oc-run
 - wip-check
 - wip-backup
 - wip-snapshot
 - pm-fail-facts
 - main-health
 - queue-check
 - queue-close
 - queue-cancel
 - main-start
 - machine-guard
 - glm-reset
 - priority-watch
 - resource-alerts
 - tmp-snapshot
 - heavy-run

1 package installed [6.00ms]
/tmp/neurastream-home-e2e/.bun/bin/neurastream
neurastream=/tmp/neurastream-home-e2e/.bun/bin/neurastream

## neurastream init
neurastream init: created
  /tmp/neurastream-home-e2e/.config/neurastream/config.yml
  /tmp/neurastream-home-e2e/.config/neurastream/INDEX.md
  /tmp/neurastream-home-e2e/.config/neurastream/notes/subagents.md
  /tmp/neurastream-home-e2e/.config/neurastream/notes/lessons.md
  /tmp/neurastream-home-e2e/.config/neurastream/notes/subagent-ranking.md
  /tmp/neurastream-home-e2e/.config/neurastream/queue/TEMPLATE.md
  /tmp/neurastream-home-e2e/.config/neurastream/blockers/deny-command
  /tmp/neurastream-home-e2e/.config/neurastream/blockers/deny-path
  /tmp/neurastream-home-e2e/.config/neurastream/blockers/deny-text
  /tmp/neurastream-home-e2e/.config/neurastream/blockers/no-push

## tree hash before second init
hash=4c7503d6dffb2ff177325e0901306bacc98927122535ec51f153bc103b48c055

## neurastream init (second run)
neurastream init: unchanged
hash=4c7503d6dffb2ff177325e0901306bacc98927122535ec51f153bc103b48c055
idempotent: tree hash unchanged

## neurastream adapter install omp
neurastream adapter install omp: linked /tmp/neurastream-home-e2e/.omp/agent/extensions/neurastream.ts
neurastream adapter install omp: plugin /tmp/neurastream-home-e2e/.omp/plugins/node_modules/neurastream
neurastream adapter install omp: pins copied 17, kept 0; overlay written
extension -> /tmp/neurastream-home-e2e/.bun/install/global/node_modules/neurastream/src/adapters/omp/index.ts
plugin -> /tmp/neurastream-home-e2e/.bun/install/global/node_modules/neurastream

## toy repo + plan
Initialized empty Git repository in /tmp/neurastream-home-e2e/origin.git/
Initialized empty Git repository in /tmp/neurastream-home-e2e/projects/toy/.git/
[main (root-commit) b88cd39] init
 2 files changed, 2 insertions(+)
 create mode 100644 .gitignore
 create mode 100644 README
To /tmp/neurastream-home-e2e/origin.git
 * [new branch]      main -> main
branch 'main' set up to track 'origin/main'.
Switched to a new branch 'feat/toy'
[feat/toy 8e66ee7] toy
 1 file changed, 1 insertion(+)
 create mode 100644 TOY
Switched to branch 'main'
Your branch is up to date with 'origin/main'.
Updating b88cd39..8e66ee7
Fast-forward
 TOY | 1 +
 1 file changed, 1 insertion(+)
 create mode 100644 TOY
To /tmp/neurastream-home-e2e/origin.git
   b88cd39..8e66ee7  main -> main
[main 2680d35] add toy plan
 1 file changed, 24 insertions(+)
 create mode 100644 docs/plans/toy.md
plan=/tmp/neurastream-home-e2e/projects/toy/docs/plans/toy.md
commit=8e66ee79d62ea6975ed7d3a725c87946a4ad5de1

## queue-check
Queue (/tmp/neurastream-home-e2e/.config/neurastream/INDEX.md): 1 repo(s)
- /tmp/neurastream-home-e2e/projects/toy
  - /tmp/neurastream-home-e2e/projects/toy/docs/plans/toy.md [open] land a toy file
queue-check exit 0

## agent-score accept
recorded: {"type": "accept", "agent": "grok", "plan": "/tmp/neurastream-home-e2e/projects/toy/docs/plans/toy.md", "phase": "P1", "weight": 3, "unit_weight": 3, "units": 1, "weight_src": "plan", "repo": "/tmp/neurastream-home-e2e/projects/toy", "branch": "feat/toy", "commits": ["8e66ee79d62ea6975ed7d3a725c87946a4ad5de1"], "rework": false, "note": "", "ts": 1792376682.776}

## agent-score board
# Subagent ranking board (GENERATED by `agent-score board --days 7`; do not hand-edit)
Updated 2026-10-19 04:24. Rank = net points per $ (worker list cost + Main steering cost), then points per run-hour.
Points = accepted work x plan difficulty (1 mechanical, 2 rules, 3 new spec, 4 root-cause, 5 product fix, 8 engine) minus penalties (false-claim 5, rule-break 2, escaped-defect 8). Survival = finished runs that ended with a final result. Steering is approximate (Main turns naming the agent).

| # | Worker model | Runs (live) | Survival | Accepted (diag) | First-pass | Net pts | $ worker | $ steering | pts/$ | pts/h |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | ? | 0 (0) | - | 1 (0) | 100% | 3 | 0.00 | 0.00 | - | - |


## blocker refusal
{"allow":false,"reason":"plan-guard: blocked by plan toy.md: no-push: subagents never push or merge; commit on the feature branch and report"}
guard pre-tool exit 2

## queue-close on merged feat/toy
queue-close: done check in /tmp/neurastream-home-e2e/projects/toy: test -f README
queue-close: branch feat/toy deleted
[main e3cbdb2] chore(plans): archive toy.md (done check passed)
 1 file changed, 1 insertion(+), 1 deletion(-)
 rename docs/plans/{ => archive/202610}/toy.md (94%)
queue-close: plan archived and committed in /tmp/neurastream-home-e2e/projects/toy (e3cbdb2); push it with the usual rules
queue-close: removed from /tmp/neurastream-home-e2e/projects/toy/INDEX.md (now empty: deleted)
queue-close: /tmp/neurastream-home-e2e/projects/toy removed from /tmp/neurastream-home-e2e/.config/neurastream/INDEX.md (0 repo(s) left)
queue-close: CLOSED
queue-close exit 0

SMOKE PASS
