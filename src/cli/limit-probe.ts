// One tick of the main-agent limit probe (plan 20261027_1500, P3). The adapter spawns this detached
// every probe_interval_s while an episode is open; it runs at most one probe and exits.

import { loadConfig } from "../core/config.ts";
import { probeStep } from "../core/limit-probe.ts";

const cfg = loadConfig();
probeStep(cfg, Date.now());
