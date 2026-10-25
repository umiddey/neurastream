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
		waste_weight: number;
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
		/** Highest per-spawn `Call budget: <N>` a task brief may set. */
		sub_max_calls_cap: number;
		main_edit_limit: number;
		main_window_min: number;
		unlock_minutes: number;
		/** The owner's whole chat message ("unlock", "unlock N", "lock") moves the guard unlock file. */
		chat_unlock: boolean;
		plan_read_max_hours: number;
		idle_stops: number;
		/** Provider rate limits (src/core/rate-limit.ts): a turn that ends on one waits it out instead of
		 *  asking again straight into the limit. The words and the waits come from here. */
		rate_limit: {
			/** Case-insensitive substrings in the error text that mark a rate limit. */
			patterns: string[];
			/** Wait when the error text names no retry-after. */
			default_wait_s: number;
			/** Cap for the parsed (or doubled) wait, before slack. */
			max_wait_s: number;
			/** Added on top of every wait. */
			slack_s: number;
		};
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
	/** Autonomy tiers (I-20261025-177): how much Main may do without asking. The owner moves the
	 *  tier (chat `tier <name>`, or the phone page); the guards follow it. */
	autonomy: {
		/** Tier in force when `<state dir>/autonomy-tier` does not name one (src/core/autonomy.ts). */
		tier: "strict" | "opinionated" | "full";
		/** Main's project-file changes per guards.main_window_min window in tier strict. */
		strict_edit_limit: number;
		/** Minutes one owner `go` approves exactly one push/merge in tier strict. */
		go_minutes: number;
	};
	/** The owner's phone page (`neurastream ui`): binds the tailnet address only. */
	ui: { enabled: boolean; port: number; owner_login: string };
	/** Static pages hosted over the tailnet. */
	pages: { enabled: boolean; port: number; dir: string; keep_days: number };
	rollover: { enabled: boolean; max_session_mb: number; exit_grace_s: number };
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
	quota: { reset_tz: string; reset_pattern: string; label: string };
	/** Chat notify (src/core/notify.ts): Main's final reply goes to these webhooks at session_stop.
	 *  The values are paths to secret files holding the webhook URLs — never the URLs themselves. */
	notify: { discord_webhook_file: string; slack_webhook_file: string; prefix: string };
	priority: { sleep_sec: number };
	alerts: { temp_c: number; mem_psi: number; io_psi: number; cooldown_sec: number };
	snapshot: { tmp_dest: string; git_repo: string; git_backup: string; excludes: string[] };
	/** Trace rules: provider honesty (src/core/trace-provider.ts) and what a scanned run may read, dial and write (src/core/trace-actions.ts). */
	traces: {
		/** What an honest provider answer looks like. */
		provider: {
			/** Provider -> regex every assistant responseId must match; a provider without an entry is not checked. */
			id_patterns: Record<string, string>;
			/** Tools a run may call even when no result in the run proves the tool was offered. */
			allow_tools: string[];
			/** Model -> $ per million tokens; a model without an entry is not priced, so its cost is not checked. Both maps are open: an empty object in the template means the user may add keys. */
			prices: Record<string, { input: number; output: number; cache_read: number; cache_write: number }>;
		};
		allowed_hosts: string[];
		/** Product names (docs/config.md) whose files another product's run may not read quietly. */
		owned_repos: string[];
		/** Prompt-size rules (src/core/trace-bloat.ts): when a run flags prompt-bloat. */
		bloat: {
			/** The largest first-call prompt a healthy run may open with. */
			first_call_max: number;
			/** A call flags when its prompt passes ratio_of_limit × its model's context_limits entry. */
			ratio_of_limit: number;
			/** Model -> context tokens; a model without an entry is not limit-checked. Open map. */
			context_limits: Record<string, number>;
			/** APIs whose usage aggregates multiple internal calls and is not per-call size. */
			aggregate_apis: string[];
			/** First capture of this regex on a tool name names its bloat group (no match: "builtin"). */
			tool_group: string;
		};
		actions: {
			secret_globs: string[];
			net_tools: string[];
			shell_patterns: string[];
			write_roots: string[];
			deny_globs: string[];
		};
		/** Waste counters (src/core/trace-efficiency.ts): what makes a tool call wasted. */
		efficiency: {
			/** The Nth identical read (same args JSON, no write between) counts; >= 2. */
			repeat_read_min: number;
			/** A toolResult text starting with one of these is a guard block. */
			guard_prefixes: string[];
			/** Shell commands matching this poll while nothing else runs. */
			poll_pattern: string;
		};
		/** Brief-quality rules (src/core/trace-briefs.ts): what a spawn brief names, and how the report buckets briefs by length. */
		briefs: {
			/** A brief whose text matches this names a verify command. */
			verify_pattern: string;
			/** A brief whose text matches this names a phase. */
			phase_pattern: string;
			/** A brief whose text matches this names a plan file. */
			plan_pattern: string;
			/** Ascending char edges that split briefs into length buckets in the report. */
			char_buckets: number[];
			/** The report shows a mean only when at least this many rows sit on that side; >= 1. */
			min_n: number;
		};
	};
	/** Optional overlay written by adapter install. Absent until an adapter is installed. */
	adapter?: { name: string; sessions: string; pins: string; extensions: string };
	/** Notices about legacy keys in the user's config file; empty when there are none. */
	notices: string[];
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
				// An empty object in the template is an open map: the user may add any keys
				// (traces.provider.id_patterns, traces.provider.prices).
				if (Object.keys(base).length === 0) {
					out[key] = over[key];
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
	try {
		const pattern = cfg.quota.reset_pattern;
		new RegExp(pattern);
		let groups = 0;
		let escaped = false;
		let inClass = false;
		for (let i = 0; i < pattern.length; i++) {
			const char = pattern[i];
			if (escaped) {
				escaped = false;
				continue;
			}
			if (char === "\\") {
				escaped = true;
				continue;
			}
			if (char === "[" && !inClass) inClass = true;
			else if (char === "]" && inClass) inClass = false;
			else if (char === "(" && !inClass && pattern[i + 1] !== "?") groups++;
		}
		if (groups < 1) throw new Error("missing capture group 1");
	} catch {
		throw new ConfigError("quota.reset_pattern must be a valid regex with capture group 1");
	}
	if (!(Number.isFinite(cfg.score.waste_weight) && cfg.score.waste_weight >= 0 && cfg.score.waste_weight <= 1)) {
		throw new ConfigError("score.waste_weight must be between 0 and 1");
	}
	if (cfg.ledger.max_slots < 1) throw new ConfigError("ledger.max_slots must be >= 1");
	if (cfg.guards.sub_warn_calls > cfg.guards.sub_max_calls) {
		throw new ConfigError("guards.sub_warn_calls must be <= guards.sub_max_calls");
	}
	if (cfg.guards.sub_max_calls_cap < cfg.guards.sub_max_calls) {
		throw new ConfigError("guards.sub_max_calls_cap must be >= guards.sub_max_calls");
	}
	if (!(cfg.rollover.max_session_mb > 0)) throw new ConfigError("rollover.max_session_mb must be > 0");
	if (cfg.autonomy.tier !== "strict" && cfg.autonomy.tier !== "opinionated" && cfg.autonomy.tier !== "full")
		throw new ConfigError('autonomy.tier must be "strict", "opinionated" or "full"');
	if (!Number.isInteger(cfg.autonomy.strict_edit_limit) || cfg.autonomy.strict_edit_limit < 1)
		throw new ConfigError("autonomy.strict_edit_limit must be an integer >= 1");
	if (!Number.isInteger(cfg.autonomy.go_minutes) || cfg.autonomy.go_minutes < 1)
		throw new ConfigError("autonomy.go_minutes must be an integer >= 1");
	if (!Array.isArray(cfg.guards.rate_limit.patterns) || cfg.guards.rate_limit.patterns.some(p => typeof p !== "string" || p === "")) {
		throw new ConfigError("guards.rate_limit.patterns must be a list of non-empty strings");
	}
	if (!(cfg.guards.rate_limit.default_wait_s >= 1)) throw new ConfigError("guards.rate_limit.default_wait_s must be >= 1");
	if (!(cfg.guards.rate_limit.max_wait_s >= 1)) throw new ConfigError("guards.rate_limit.max_wait_s must be >= 1");
	if (!(cfg.guards.rate_limit.slack_s >= 0)) throw new ConfigError("guards.rate_limit.slack_s must be >= 0");
	if (!(cfg.rollover.exit_grace_s > 0)) throw new ConfigError("rollover.exit_grace_s must be > 0");
	if (!(cfg.metrics.report_days >= 1)) throw new ConfigError("metrics.report_days must be >= 1");
	if (!(cfg.ui.port >= 1 && cfg.ui.port <= 65535)) throw new ConfigError("ui.port must be between 1 and 65535");
	if (!Number.isInteger(cfg.pages.port) || cfg.pages.port < 1 || cfg.pages.port > 65535) throw new ConfigError("pages.port must be an integer between 1 and 65535");
	if (typeof cfg.pages.dir !== "string" || cfg.pages.dir.length === 0) throw new ConfigError("pages.dir must be a non-empty path");
	if (!Number.isInteger(cfg.pages.keep_days) || cfg.pages.keep_days < 1) throw new ConfigError("pages.keep_days must be an integer >= 1");
	for (const p of cfg.metrics.correction_patterns) {
		try {
			new RegExp(p, "i");
		} catch {
			throw new ConfigError(`metrics.correction_patterns: not a valid regex: ${p}`);
		}
	}
	for (const [provider, pattern] of Object.entries(cfg.traces.provider.id_patterns)) {
		if (typeof pattern !== "string") throw new ConfigError(`traces.provider.id_patterns.${provider} must be a string`);
		try {
			new RegExp(pattern);
		} catch {
			throw new ConfigError(`traces.provider.id_patterns.${provider}: not a valid regex: ${pattern}`);
		}
	}
	for (const [model, row] of Object.entries(cfg.traces.provider.prices)) {
		for (const key of ["input", "output", "cache_read", "cache_write"] as const) {
			if (typeof row[key] !== "number" || !Number.isFinite(row[key])) {
				throw new ConfigError(`traces.provider.prices.${model}.${key} must be a number`);
			}
		}
	}
	if (typeof cfg.traces.bloat.first_call_max !== "number" || !Number.isFinite(cfg.traces.bloat.first_call_max) || !(cfg.traces.bloat.first_call_max > 0)) {
		throw new ConfigError("traces.bloat.first_call_max must be a number > 0");
	}
	if (typeof cfg.traces.bloat.ratio_of_limit !== "number" || !Number.isFinite(cfg.traces.bloat.ratio_of_limit) || !(cfg.traces.bloat.ratio_of_limit > 0) || cfg.traces.bloat.ratio_of_limit > 1) {
		throw new ConfigError("traces.bloat.ratio_of_limit must be a number in (0, 1]");
	}
	if (!Array.isArray(cfg.traces.bloat.aggregate_apis) || cfg.traces.bloat.aggregate_apis.some((api) => typeof api !== "string" || api === "")) {
		throw new ConfigError("traces.bloat.aggregate_apis must be a list of non-empty strings");
	}
	for (const [model, limit] of Object.entries(cfg.traces.bloat.context_limits)) {
		if (typeof limit !== "number" || !Number.isFinite(limit) || !(limit > 0)) {
			throw new ConfigError(`traces.bloat.context_limits.${model} must be a number > 0`);
		}
	}
	if (typeof cfg.traces.bloat.tool_group !== "string" || cfg.traces.bloat.tool_group === "") {
		throw new ConfigError("traces.bloat.tool_group must be a non-empty string");
	}
	try {
		new RegExp(cfg.traces.bloat.tool_group);
	} catch {
		throw new ConfigError(`traces.bloat.tool_group: not a valid regex: ${cfg.traces.bloat.tool_group}`);
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
	for (const list of [cfg.traces.allowed_hosts, cfg.traces.owned_repos, cfg.traces.actions.secret_globs, cfg.traces.actions.net_tools, cfg.traces.actions.shell_patterns, cfg.traces.actions.write_roots, cfg.traces.actions.deny_globs]) {
		if (list.some((v) => typeof v !== "string" || v === "")) {
			throw new ConfigError("traces lists must be non-empty strings");
		}
	}
	if (!(cfg.traces.efficiency.repeat_read_min >= 2)) {
		throw new ConfigError("traces.efficiency.repeat_read_min must be >= 2");
	}
	if (cfg.traces.efficiency.guard_prefixes.some((p) => typeof p !== "string" || p === "")) {
		throw new ConfigError("traces.efficiency.guard_prefixes must be non-empty strings");
	}
	try {
		new RegExp(cfg.traces.efficiency.poll_pattern);
	} catch {
		throw new ConfigError(`traces.efficiency.poll_pattern: not a valid regex: ${cfg.traces.efficiency.poll_pattern}`);
	}
	const briefs = cfg.traces.briefs;
	for (const key of ["verify_pattern", "phase_pattern", "plan_pattern"] as const) {
		if (typeof briefs[key] !== "string") throw new ConfigError(`traces.briefs.${key} must be a string`);
		try {
			new RegExp(briefs[key]);
		} catch {
			throw new ConfigError(`traces.briefs.${key}: not a valid regex: ${briefs[key]}`);
		}
	}
	if (!Number.isInteger(briefs.min_n) || briefs.min_n < 1) throw new ConfigError("traces.briefs.min_n must be an integer >= 1");
	const edges = briefs.char_buckets;
	if (!Array.isArray(edges) || edges.some((v, i) => !Number.isInteger(v) || v < 1 || (i > 0 && v <= edges[i - 1]!))) {
		throw new ConfigError("traces.briefs.char_buckets must be ascending positive integers");
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

// Old keys that still load, each with a notice to rename or delete it. "glm:" moves to "quota:" only
// when "quota:" is absent; with both present, "glm:" stays and fails as an unknown key.
function migrateLegacy(user: Record<string, unknown>, file: string, notices: string[]): Record<string, unknown> {
	const out = { ...user };
	if ("glm" in out && !("quota" in out)) {
		out.quota = out.glm;
		delete out.glm;
		notices.push(`config "glm:" is now "quota:"; rename it in ${file}`);
	}
	if ("pm" in out) {
		delete out.pm;
		notices.push(`config "pm:" was removed; delete it from ${file}`);
	}
	return out;
}

export function loadConfig(opts: LoadOptions = {}): Config {
	const home = opts.home ?? homedir();
	const template = parseYaml(readFileSync(opts.template ?? TEMPLATE_PATH, "utf8"), "defaults");
	const file = opts.file ?? configFile(home);
	const notices: string[] = [];
	let merged: unknown = template;
	if (existsSync(file)) {
		let user = parseYaml(readFileSync(file, "utf8"), file);
		if (isObj(user)) user = migrateLegacy(user, file, notices);
		merged = merge(template, user, "");
	}
	if (!isObj(merged)) throw new ConfigError("config must be an object");
	applyEnv(merged, opts.env ?? process.env);
	const expanded = expand(merged, home) as Config;
	expanded.notices = notices;
	check(expanded);
	return expanded;
}
