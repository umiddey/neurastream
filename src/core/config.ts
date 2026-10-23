// Loads ~/.config/neurastream/config.yml over templates/config.yml.
// Values (paths, names, prices) live in the template, not in this file.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const TEMPLATE_PATH = join(HERE, "../../templates/config.yml");

export class ConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConfigError";
	}
}

export interface Config {
	paths: {
		home: string;
		work_roots: string[];
		config_dir: string;
		agent_dir: string;
		score_state: string;
		queue_state: string;
		queue_index: string;
		blockers: string;
		notes: string;
		ranking_board: string;
		subagents: string;
		cancelled: string;
		unlock: string;
		guard_log: string;
		plan_guard_log: string;
		heavy_lock: string;
		heavy_owner: string;
		heavy_log: string;
		heavy_idle_state: string;
		alert_state: string;
		snapshot_lock: string;
	};
	score: {
		default_repo: string;
		default_branch: string;
		penalties: Record<string, number>;
		diagnose_weight: number;
		gate_days: number;
		board_days: number;
		min_dollars: number;
		min_hours: number;
	};
	ledger: {
		default_hours: number;
		idle_show_min: number;
		idle_not_live_min: number;
		max_running_per_provider: number;
		max_slots: number;
		providers: string[];
	};
	brief: {
		method_marker: string;
		heavy_marker: string;
		max_keys: number;
		warn_chars: number;
		aim_chars: number;
		path_prefixes: string[];
		method_read: string;
		heavy_path: string;
		/** Repo-specific brief rules; the shipped default list is empty. A rule fires when `match`
		 *  (regex on the whole brief) hits and the body lacks `require`; optional `first`/`unless`
		 *  gate the rule on the plan's title line. */
		repo_rules: { match: string; require: string; message: string; first?: string; unless?: string }[];
	};
	oc: { model_prefix: string; tail_lines: number; tail_chars: number };
	wip: {
		limit: number;
		days: number;
		backup_url: string;
		backup_log: string;
		backup_hook_off: string[];
		backup_max_repo_mb: number;
		secret_gate: string;
		snapshot_max_mb: number;
		status_log: string;
		secret_file: string;
	};
	pm: { backend_log: string; fail_lines: number; backend_error: string };
	health: { warn_ctx: number; tail_calls: number; default_hours: number };
	queue: {
		archive_days: number;
		background_max_lines: number;
		progress_keep: number;
		priority_id: string;
		cancel_min_words: number;
		auto_close_min: number;
		repo_index: string;
		cancelled_rel: string;
	};
	guards: {
		sub_warn_calls: number;
		sub_max_calls: number;
		main_edit_limit: number;
		main_window_min: number;
		unlock_minutes: number;
		plan_read_max_hours: number;
		idle_stops: number;
		blocker_timeout_ms: number;
		skip_tools: string[];
		read_tools: string[];
		shell_tools: string[];
		write_tools: string[];
		free_ext: string;
		free_prefixes: string[];
		bypass_spawn: string[];
		protected: string[];
		ledger_command: string;
	};
	rollover: { enabled: boolean; max_session_mb: number };
	metrics: { report_days: number; correction_patterns: string[]; ci_pipelines_cmd: string };
	/** Incident detectors (src/core/incident-detectors.ts): when a sighting becomes an incident. */
	incidents: {
		/** Minutes after a finished task-result before a RUNNING/WAITING ledger row contradicts it. */
		contradiction_grace_min: number;
		/** Same guard BLOCK reason within one hour that means a block loop. */
		block_repeat: number;
		/** Seconds between scans of the expensive detectors (D1 ledger, D3 block loop). */
		scan_interval_sec: number;
		/** A daily metric must be worse than the 7-day mean by at least this percent. */
		daily_worse_pct: number;
		/** Per-metric daily floors (keys: m1, m2, m3, m4_corrections, m4_questions, m5): a regression below the floor is noise. */
		daily_floor: Record<string, number>;
	};
	machine: {
		load_over_cores: number;
		load_max: number;
		avail_min_mb: number;
		disk_min_gb: number;
		disk_path: string;
		tmp_max_mb: number;
		idle_max_min: number;
		idle_min_ticks: number;
		watch_sec: number;
		watch_streak: number;
	};
	glm: { reset_tz: string; label: string };
	priority: { sleep_sec: number };
	alerts: { temp_c: number; mem_psi: number; io_psi: number; cooldown_sec: number };
	snapshot: { tmp_dest: string; git_repo: string; git_backup: string; excludes: string[] };
	/** Optional overlay written by adapter install. Absent until an adapter is installed. */
	adapter?: { name: string; sessions: string; pins: string; extensions: string };
}

type EnvKind = "string" | "number" | "csv";
const ENV_MAP: Record<string, { path: string[]; kind: EnvKind }> = {
	QUEUE_AGENT: { path: ["paths", "agent_dir"], kind: "string" },
	QUEUE_INDEX: { path: ["paths", "queue_index"], kind: "string" },
	QUEUE_BLOCKERS: { path: ["paths", "blockers"], kind: "string" },
	QUEUE_STATE: { path: ["paths", "queue_state"], kind: "string" },
	QUEUE_SUBAGENTS: { path: ["paths", "subagents"], kind: "string" },
	QUEUE_CANCELLED: { path: ["paths", "cancelled"], kind: "string" },
	QUEUE_UNLOCK: { path: ["paths", "unlock"], kind: "string" },
	MAIN_GUARD_LIMIT: { path: ["guards", "main_edit_limit"], kind: "number" },
	MAIN_GUARD_WINDOW_MIN: { path: ["guards", "main_window_min"], kind: "number" },
	MAIN_GUARD_ROOTS: { path: ["paths", "work_roots"], kind: "csv" },
	MAIN_GUARD_LEDGER: { path: ["guards", "ledger_command"], kind: "string" },
	MAIN_GUARD_LOG: { path: ["paths", "guard_log"], kind: "string" },
	PLAN_GUARD_LOG: { path: ["paths", "plan_guard_log"], kind: "string" },
	WIP_LIMIT: { path: ["wip", "limit"], kind: "number" },
	WIP_DAYS: { path: ["wip", "days"], kind: "number" },
	WIP_BACKUP_MAX_REPO_MB: { path: ["wip", "backup_max_repo_mb"], kind: "number" },
	WIP_SNAPSHOT_MAX_MB: { path: ["wip", "snapshot_max_mb"], kind: "number" },
	LOAD_MAX: { path: ["machine", "load_max"], kind: "number" },
	AVAIL_MIN_MB: { path: ["machine", "avail_min_mb"], kind: "number" },
	DISK_MIN_GB: { path: ["machine", "disk_min_gb"], kind: "number" },
	TMP_MAX_MB: { path: ["machine", "tmp_max_mb"], kind: "number" },
	IDLE_MAX_MIN: { path: ["machine", "idle_max_min"], kind: "number" },
};

export function configFile(home = homedir()): string {
	return join(home, ".config", "neurastream", "config.yml");
}

function isObj(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseYaml(text: string, where: string): Record<string, unknown> {
	let value: unknown;
	try {
		value = Bun.YAML.parse(text);
	} catch (err) {
		throw new ConfigError(`${where}: YAML did not parse (${err instanceof Error ? err.message : err})`);
	}
	if (!isObj(value)) throw new ConfigError(`${where}: config must be a YAML object`);
	return value;
}

function merge(base: unknown, over: unknown, path: string): unknown {
	if (Array.isArray(base)) {
		if (!Array.isArray(over)) throw new ConfigError(`${path} must be an array`);
		return over.slice();
	}
	if (isObj(base)) {
		if (!isObj(over)) throw new ConfigError(`${path} must be an object`);
		const out: Record<string, unknown> = { ...base };
		for (const key of Object.keys(over)) {
			const next = path ? `${path}.${key}` : key;
			if (!(key in base)) {
				if (path === "" && key === "adapter") {
					out[key] = adapterOverlay(over[key], next);
					continue;
				}
				throw new ConfigError(`unknown key ${next}`);
			}
			out[key] = merge(base[key], over[key], next);
		}
		return out;
	}
	if (typeof over !== typeof base) throw new ConfigError(`${path} must be a ${typeof base}`);
	if (typeof base === "number" && !Number.isFinite(over as number)) throw new ConfigError(`${path} must be a number`);
	return over;
}
const ADAPTER_KEYS = ["name", "sessions", "pins", "extensions"] as const;

function adapterOverlay(value: unknown, path: string): Record<string, string> {
	if (!isObj(value)) throw new ConfigError(`${path} must be an object`);
	for (const key of Object.keys(value)) {
		if (!ADAPTER_KEYS.includes(key as (typeof ADAPTER_KEYS)[number])) throw new ConfigError(`unknown key ${path}.${key}`);
	}
	const out: Record<string, string> = {};
	for (const key of ADAPTER_KEYS) {
		const v = value[key];
		if (typeof v !== "string" || v === "") throw new ConfigError(`${path}.${key} must be a string`);
		out[key] = v;
	}
	return out;
}

function expand(value: unknown, home: string): unknown {
	if (typeof value === "string") {
		return value.replaceAll("$HOME", home).replace(/^~(?=\/|$)/, home);
	}
	if (Array.isArray(value)) return value.map(v => expand(v, home));
	if (isObj(value)) {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) out[k] = expand(v, home);
		return out;
	}
	return value;
}

function applyEnv(cfg: Record<string, unknown>, env: NodeJS.ProcessEnv): void {
	for (const [name, spec] of Object.entries(ENV_MAP)) {
		const raw = env[name];
		if (raw === undefined || raw === "") continue;
		let cur: Record<string, unknown> = cfg;
		for (const key of spec.path.slice(0, -1)) {
			const next = cur[key];
			if (!isObj(next)) throw new ConfigError(`env ${name} targets missing ${spec.path.join(".")}`);
			cur = next;
		}
		const leaf = spec.path[spec.path.length - 1]!;
		if (spec.kind === "number") {
			const n = Number(raw);
			if (!Number.isFinite(n)) throw new ConfigError(`env ${name} must be a number`);
			cur[leaf] = n;
		} else if (spec.kind === "csv") {
			cur[leaf] = raw.split(",").map(s => s.trim()).filter(Boolean);
		} else {
			cur[leaf] = raw;
		}
	}
}

function check(cfg: Config): void {
	if (cfg.ledger.max_slots < 1) throw new ConfigError("ledger.max_slots must be >= 1");
	if (cfg.guards.sub_warn_calls > cfg.guards.sub_max_calls) {
		throw new ConfigError("guards.sub_warn_calls must be <= guards.sub_max_calls");
	}
	if (!(cfg.rollover.max_session_mb > 0)) throw new ConfigError("rollover.max_session_mb must be > 0");
	if (!(cfg.metrics.report_days >= 1)) throw new ConfigError("metrics.report_days must be >= 1");
	for (const p of cfg.metrics.correction_patterns) {
		try {
			new RegExp(p, "i");
		} catch {
			throw new ConfigError(`metrics.correction_patterns: not a valid regex: ${p}`);
		}
	}
	for (const rule of cfg.brief.repo_rules) {
		for (const key of ["match", "require", "first", "unless"] as const) {
			const pattern = rule[key];
			if (pattern === undefined) continue;
			try {
				new RegExp(pattern, "i");
			} catch {
				throw new ConfigError(`brief.repo_rules.${key}: not a valid regex: ${pattern}`);
			}
		}
		if (!rule.message) throw new ConfigError("brief.repo_rules.message must be a non-empty string");
	}
	for (const [key, value] of Object.entries(cfg.paths)) {
		if (key === "work_roots") {
			if (!Array.isArray(value) || value.some(v => typeof v !== "string")) {
				throw new ConfigError("paths.work_roots must be a list of strings");
			}
			continue;
		}
		if (typeof value !== "string") throw new ConfigError(`paths.${key} must be a string`);
	}
}

export interface LoadOptions {
	file?: string;
	home?: string;
	env?: NodeJS.ProcessEnv;
	template?: string;
}

export function loadConfig(opts: LoadOptions = {}): Config {
	const home = opts.home ?? homedir();
	const template = parseYaml(readFileSync(opts.template ?? TEMPLATE_PATH, "utf8"), "defaults");
	const file = opts.file ?? configFile(home);
	let merged: unknown = template;
	if (existsSync(file)) {
		merged = merge(template, parseYaml(readFileSync(file, "utf8"), file), "");
	}
	if (!isObj(merged)) throw new ConfigError("config must be an object");
	applyEnv(merged, opts.env ?? process.env);
	const expanded = expand(merged, home) as Config;
	check(expanded);
	return expanded;
}
