import { loadConfig, type Config } from "../core/config.ts";
import type { RunSource } from "../core/adapter.ts";
import { defaultRunSource } from "../adapters/omp/sessions.ts";

export interface Runtime {
	cfg: Config;
	source: RunSource;
}

export function runtime(): Runtime {
	const cfg = loadConfig();
	return { cfg, source: defaultRunSource(cfg) };
}
