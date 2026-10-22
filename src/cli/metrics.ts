// `neurastream metrics …`: records facts the owner and the CI command decide into
// metrics.jsonl (see src/core/metrics.ts). Each record* function takes the config and the
// clock as arguments so tests run against a temp home.

import { existsSync } from "node:fs";
import { ConfigError, loadConfig, type Config } from "../core/config.ts";
import { appendMetric } from "../core/metrics.ts";
import { nowSec } from "../core/clock.ts";

export const METRICS_USAGE = [
	"usage: neurastream metrics ci <repo-dir> <mr-id>",
	'       neurastream metrics false-alarm <log-ts> --why "<text>"',
	'       neurastream metrics rule "<text>" --approved|--rejected',
	"       neurastream metrics report [--days N]",
].join("\n");

function flagValue(args: string[], name: string): string | undefined {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
}

/** Single-quotes a value for `sh -c`, so an MR id cannot inject shell syntax. */
function shellQuote(v: string): string {
	return `'${v.replaceAll("'", "'\\''")}'`;
}

/** Runs the configured CI command in the repo and records how many pipelines the MR needed. */
export function recordCi(cfg: Config, repoDir: string, mr: string, now: number): number {
	if (!repoDir || !mr) {
		console.error(METRICS_USAGE);
		return 2;
	}
	const template = cfg.metrics.ci_pipelines_cmd;
	if (!template) {
		console.error("metrics.ci_pipelines_cmd not set");
		return 2;
	}
	if (!existsSync(repoDir)) {
		console.error(`repo-dir not found: ${repoDir}`);
		return 2;
	}
	const proc = Bun.spawnSync(["sh", "-c", template.replaceAll("{mr}", shellQuote(mr))], {
		cwd: repoDir,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (proc.exitCode !== 0) {
		console.error(`ci command exited ${proc.exitCode}: ${proc.stderr.toString().trim()}`);
		return 1;
	}
	let pipelines: unknown;
	try {
		pipelines = JSON.parse(proc.stdout.toString());
	} catch {
		pipelines = undefined;
	}
	if (!Array.isArray(pipelines)) {
		console.error("ci command must print a JSON array on stdout");
		return 1;
	}
	appendMetric(cfg, { type: "ci", mr, repo: repoDir, tries: pipelines.length, ts: now });
	console.log(`ci: ${mr} needed ${pipelines.length} pipeline(s)`);
	return 0;
}

/** Marks one guard BLOCK line (by its ISO timestamp) as a false alarm. */
export function recordFalseAlarm(cfg: Config, logTs: string, why: string, now: number): number {
	if (!logTs || !why) {
		console.error(METRICS_USAGE);
		return 2;
	}
	appendMetric(cfg, { type: "false-alarm", log_ts: logTs, why, ts: now });
	console.log(`false-alarm recorded for ${logTs}`);
	return 0;
}

/** Records the owner's decision on one proposed rule change. */
export function recordRule(cfg: Config, text: string, decision: "approved" | "rejected", now: number): number {
	if (!text) {
		console.error(METRICS_USAGE);
		return 2;
	}
	appendMetric(cfg, { type: "rule", text, decision, ts: now });
	console.log(`rule ${decision}: ${text}`);
	return 0;
}

export async function runMetrics(args: string[]): Promise<number> {
	let cfg: Config;
	try {
		cfg = loadConfig();
	} catch (err) {
		console.error(err instanceof ConfigError ? err.message : String(err));
		return 1;
	}
	const [sub = "", ...rest] = args;
	const now = nowSec();
	if (sub === "ci") return recordCi(cfg, rest[0] ?? "", rest[1] ?? "", now);
	if (sub === "false-alarm") return recordFalseAlarm(cfg, rest[0] ?? "", flagValue(rest, "--why") ?? "", now);
	if (sub === "rule") {
		const approved = rest.includes("--approved");
		const rejected = rest.includes("--rejected");
		if (approved === rejected) {
			console.error(METRICS_USAGE);
			return 2;
		}
		return recordRule(cfg, rest[0] ?? "", approved ? "approved" : "rejected", now);
	}
	console.error(METRICS_USAGE);
	return 2;
}
