// One tick of the main-agent limit probe (plan 20261027_1500, P3). The adapter spawns this detached
// every probe_interval_s while an episode is open; it runs at most one probe and exits. A give-up
// posts the ⚠ to the owner chat (P4), so the serial notify queue is drained before exit.

import { loadConfig } from "../core/config.ts";
import { probeStep } from "../core/limit-probe.ts";
import { notifyIdle } from "../core/notify.ts";

const cfg = loadConfig();
probeStep(cfg, Date.now());
await notifyIdle();
