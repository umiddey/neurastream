import { ConfigError, configFile, loadConfig } from "../core/config.ts";

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
		"",
		"Compatibility bins (same names as today; ports land in later phases):",
		...BINS.map(b => `  ${b}`),
		"",
		`Config file: ${configFile()}`,
		"Defaults: templates/config.yml. See docs/config.md.",
	].join("\n");
}

export async function run(cmd: string, args: string[]): Promise<number> {
	if (cmd === "help" || cmd === "--help" || cmd === "-h" || args.includes("--help") || args.includes("-h")) {
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
	if ((BINS as readonly string[]).includes(cmd)) {
		console.error(`${cmd}: not ported yet`);
		return 2;
	}
	console.error(`unknown command ${cmd}\n${helpText()}`);
	return 2;
}
