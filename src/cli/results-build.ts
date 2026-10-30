// The owner page's Results build, run as its own process by spawnResultsBuild (src/core/owner-ui.ts):
// it parses months of sessions (over a minute, GBs of memory), which froze the page when the server
// did it itself (I-20261030-121). Writes the numbers to resultsCachePath(); the page only reads them.

import { renameSync, writeFileSync } from "node:fs";
import { getAdapter } from "../adapters/index.ts";
import { nowSec } from "../core/clock.ts";
import { loadConfig } from "../core/config.ts";
import { computeResults, resultsCachePath } from "../core/owner-ui.ts";
import { applyQueueEnv } from "../core/queue/env.ts";

const cfg = loadConfig();
applyQueueEnv(cfg);
const at = nowSec();
const data = computeResults(cfg, getAdapter(cfg).runSource(cfg), at);
const path = resultsCachePath();
// Write then rename: the page never reads a half-written file.
writeFileSync(`${path}.tmp`, JSON.stringify({ at, data }));
renameSync(`${path}.tmp`, path);
