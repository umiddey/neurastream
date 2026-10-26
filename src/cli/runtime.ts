import { loadConfig, type Config } from "../core/config.ts";
import type { RunSource } from "../core/adapter.ts";
import { getAdapter } from "../adapters/index.ts";

export interface Runtime {
	cfg: Config;
	source: RunSource;
}

export function runtime(): Runtime {
	const cfg = loadConfig();
	return { cfg, source: getAdapter(cfg).runSource(cfg) };
}
