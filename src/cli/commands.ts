import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { agentLedger } from "../core/agent-ledger.ts";
import { agentScore } from "../core/agent-score.ts";
import { briefLint } from "../core/brief-lint.ts";
import { quotaReset } from "../core/quota-reset.ts";
import { heavyRun } from "../core/heavy-run.ts";
import { mainHealth } from "../core/main-health.ts";
import { mainStart } from "../core/main-start.ts";
import { machineGuard } from "../core/machine-guard.ts";
import { ocRun } from "../core/oc-run.ts";
import { priorityWatch } from "../core/priority-watch.ts";
import { queueCancel } from "../core/queue-cancel.ts";
import { queueCheck } from "../core/queue-check.ts";
import { queueTrim } from "../core/queue-trim.ts";
import { queueClose } from "../core/queue-close.ts";
import { queueFinished } from "../core/queue-finished.ts";
import { resourceAlerts } from "../core/resource-alerts.ts";
import { syncHarnessOut } from "../core/provider-state.ts";
import { tmpSnapshot } from "../core/tmp-snapshot.ts";
import { wipBackup } from "../core/wip-backup.ts";
import { wipCheck } from "../core/wip-check.ts";
import { wipSnapshot } from "../core/wip-snapshot.ts";
import { withHeartbeat } from "../core/heartbeat.ts";
import { runtime } from "./runtime.ts";
import { claimCli } from "./claim.ts";
import { getAdapter } from "../adapters/index.ts";

export const PORTED = [
	"agent-score",
	"agent-ledger",
	"brief-lint",
	"oc-run",
	"wip-check",
	"wip-backup",
	"wip-snapshot",
	"main-health",
	"queue-check",
	"queue-trim",
	"queue-close",
	"queue-finished",
	"queue-cancel",
	"claim",
	"main-start",
	"machine-guard",
	"quota-reset",
	"priority-watch",
	"resource-alerts",
	"tmp-snapshot",
	"heavy-run",
] as const;

const CLI_MAIN = join(dirname(fileURLToPath(import.meta.url)), "main.ts");

/**
 * Runs the CLI `doctor` command asynchronously and returns its combined stdout and stderr.
 *
 * Returns:
 *     Promise<string>: Output produced by `neurastream doctor`, including any spawn error message
 */
function runCliDoctor(): Promise<string> {
	const { promise, resolve } = Promise.withResolvers<string>();
	const child = spawn(CLI_MAIN, ["doctor"], { stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "";
	let stderr = "";
	child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
		stdout += chunk;
	});
	child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
		stderr += chunk;
	});
	child.on("error", err => {
		const text = `${stdout}${stderr}`;
		const body = text.endsWith("\n") || text === "" ? text : `${text}\n`;
		resolve(`${body}${err.message}\n`);
	});
	child.on("close", () => resolve(`${stdout}${stderr}`));
	return promise;
}

export async function runMain(args: string[]): Promise<number> {
	const cfg = runtime().cfg;
	return getAdapter(cfg).launchMain(args, cfg);
}

export async function runPorted(cmd: string, args: string[]): Promise<number> {
	const rt = runtime();
	switch (cmd) {
		case "agent-score":
			return agentScore(args, rt.cfg, rt.source, getAdapter(rt.cfg).scoreTraces(rt.cfg));
		case "agent-ledger":
			if (args.includes("--cap")) syncHarnessOut(rt.cfg, getAdapter(rt.cfg).providers(rt.cfg));
			return agentLedger(args, rt.cfg, rt.source);
		case "brief-lint":
			return briefLint(args, rt.cfg);
		case "oc-run":
			return ocRun(args, rt.cfg);
		case "wip-check":
			return wipCheck(args, rt.cfg);
		case "wip-backup":
			return withHeartbeat(rt.cfg, "wip-backup", () => wipBackup(args, rt.cfg));
		case "wip-snapshot":
			return withHeartbeat(rt.cfg, "wip-snapshot", () => wipSnapshot(args, rt.cfg));
		case "main-health":
			return mainHealth(args, rt.cfg, rt.source);
		case "queue-check":
			return queueCheck(args, rt.cfg);
		case "queue-trim":
			return queueTrim(args, rt.cfg);
		case "queue-close":
			return queueClose(args, rt.cfg);
		case "queue-finished":
			return queueFinished(args, rt.cfg);
		case "queue-cancel":
			return queueCancel(args, rt.cfg);
		case "claim":
			return claimCli(args, rt.cfg);
		case "main-start": {
			const a = getAdapter(rt.cfg);
			return mainStart(args, rt.cfg, { source: a.runSource(rt.cfg), results: a.completedResults(rt.cfg), providers: a.providers(rt.cfg), episodesFor: cutoff => a.episodes(rt.cfg, cutoff), doctor: runCliDoctor });
		}
		case "machine-guard":
			return machineGuard(args, rt.cfg, { heavyMain: CLI_MAIN, heavyStatus: process.execPath });
		case "quota-reset":
			return quotaReset(args, rt.cfg);
		case "priority-watch":
			return priorityWatch(args, rt.cfg);
		case "resource-alerts":
			return resourceAlerts(args, rt.cfg);
		case "tmp-snapshot":
			return tmpSnapshot(args, rt.cfg);
		case "heavy-run":
			return heavyRun(args, rt.cfg);
		default:
			return 2;
	}
}
