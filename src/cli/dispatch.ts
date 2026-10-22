import { ConfigError, configFile, loadConfig } from "../core/config.ts";
import { applyQueueEnv } from "../core/queue/env.ts";
import { runAdapterInstall } from "../adapters/omp/install.ts";
import { runDoctor } from "../adapters/omp/doctor.ts";
import { GUARD_USAGE, runGuard } from "./guard.ts";
import { runInit } from "./init.ts";
import { PORTED, runMain, runPorted } from "./commands.ts";
import { runMetrics } from "./metrics.ts";
import { runIncident } from "./incident.ts";

const BINS = [
	"agent-score",
	"agent-ledger",
	"brief-lint",
	"oc-run",
	"wip-check",
	"wip-backup",
	"wip-snapshot",
	"pm-fail-facts",
	"main-health",
	"queue-check",
	"queue-close",
	"queue-cancel",
	"main-start",
	"machine-guard",
	"glm-reset",
	"priority-watch",
	"resource-alerts",
	"tmp-snapshot",
	"heavy-run",
] as const;

export function helpText(): string {
	return [
		"neurastream — queue, guards, blockers, scoring, ledger",
		"",
		"Usage:",
		"  neurastream --help",
		"  neurastream init [--agent-dir <dir>]",
		"                                create config, index, notes, blockers, queue template, state dirs",
		"                                (--agent-dir: keep an existing index/notes/blockers dir)",
		"  neurastream adapter install omp",
		"                                link the omp extension under this HOME",
		"  neurastream doctor            report hand-edited live files and a stale install",
		"  neurastream config [--json]   print the merged config (defaults + file + env)",
		"  neurastream guard <event> --json",
		`                                (${GUARD_USAGE.slice(GUARD_USAGE.indexOf("(") + 1, -1)})`,
		"  neurastream main [args]       run omp under the launcher (automatic session rollover)",
		"  neurastream metrics <cmd>     self-metrics: report, ci, false-alarm, rule (see README)",
		"  neurastream incident <cmd>    incidents Main must act on: list, add, plan, dismiss (see README)",
		"",
		"Compatibility bins (same names as today; ports land in later phases):",
		...BINS.map(b => `  ${b}`),
		"",
		`Config file: ${configFile()}`,
		"Defaults: templates/config.yml. See docs/config.md.",
	].join("\n");
}

export async function run(cmd: string, args: string[]): Promise<number> {
	if (cmd === "help" || cmd === "--help" || cmd === "-h") {
		console.log(helpText());
		return 0;
	}
	if (cmd === "main") return runMain(args);
	if (cmd === "init") return runInit(args);
	if (cmd === "metrics") return runMetrics(args);
	if (cmd === "incident") return runIncident(args);
	if (cmd === "adapter") return runAdapterInstall(args);
	if (cmd === "config") {
		try {
			const cfg = loadConfig();
			console.log(args.includes("--json") ? JSON.stringify(cfg, null, 2) : JSON.stringify(cfg));
			return 0;
		} catch (err) {
			console.error(err instanceof ConfigError ? err.message : String(err));
			return 1;
		}
	}
	if (cmd === "doctor") return runDoctor();
	if (cmd === "guard") {
		return runGuard(args[0] ?? "");
	}
	if ((PORTED as readonly string[]).includes(cmd)) {
		try {
			applyQueueEnv(loadConfig());
		} catch (err) {
			console.error(err instanceof ConfigError ? err.message : String(err));
			return 1;
		}
		return runPorted(cmd, args);
	}
	console.error(`unknown command ${cmd}\n${helpText()}`);
	return 2;
}
