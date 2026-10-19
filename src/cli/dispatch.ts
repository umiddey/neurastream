import { ConfigError, configFile, loadConfig } from "../core/config.ts";
import { applyQueueEnv } from "../core/queue/env.ts";
import { GUARD_USAGE, runGuard } from "./guard.ts";
import { PORTED, runPorted } from "./commands.ts";

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
		"  neurastream config [--json]   print the merged config (defaults + file + env)",
		"  neurastream guard <event> --json",
		"                                one guard decision: event JSON on stdin, Decision JSON on",
		"                                stdout, exit 0 allow / 2 refuse",
		`                                (${GUARD_USAGE.slice(GUARD_USAGE.indexOf("(") + 1, -1)})`,
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
