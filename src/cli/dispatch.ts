import { ConfigError, configFile, loadConfig } from "../core/config.ts";
import { applyQueueEnv } from "../core/queue/env.ts";
import { runAdapterInstall } from "../adapters/omp/install.ts";
import { runDoctor } from "../adapters/omp/doctor.ts";
import { GUARD_USAGE, runGuard } from "./guard.ts";
import { runInit } from "./init.ts";
import { PORTED, runMain, runPorted } from "./commands.ts";
import { runMetrics } from "./metrics.ts";
import { runIncident } from "./incident.ts";
import { runUninstall } from "../core/uninstall.ts";
import { allowedAgents, subagentsPath } from "../core/queue/lib.ts";
import { allowAgents, denyAgents, invalidSlugs } from "../core/subagents.ts";

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
	"queue-trim",
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
		"  neurastream init [--agent-dir <dir>] [--allow a,b]",
		"                                create config, index, notes, blockers, queue template, state dirs",
		"                                (--agent-dir: keep an existing index/notes/blockers dir)",
		"                                (--allow a,b: subagents allowed to spawn; on a terminal init asks instead)",
		"  neurastream adapter install omp",
		"                                link the omp extension under this HOME",
		"  neurastream uninstall [--purge] [--yes]",
		"                                inverse of init/install: removes our bins, the plugin link,",
		"                                template-identical pins and the AGENTS.md block (--purge adds",
		"                                config + agent-dir state); prints the list, refuses outside HOME",
		"  neurastream doctor            report hand-edited live files and a stale install",
		"  neurastream config [--json]   print the merged config (defaults + file + env)",
		"  neurastream guard <event> --json",
		`                                (${GUARD_USAGE.slice(GUARD_USAGE.indexOf("(") + 1, -1)})`,
		"  neurastream main [args]       run omp under the launcher (automatic session rollover)",
		"  neurastream metrics <cmd>     self-metrics: report, ci, false-alarm, rule (see README)",
		"  neurastream incident <cmd>    incidents Main must act on: list, add, plan, dismiss (see README)",
		"  neurastream agents list | allow <slug>... | deny <slug>...",
		"                                the subagent allow-list (## Allowed in notes/subagents.md)",
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
	if (cmd === "uninstall") return runUninstall(args);
	if (cmd === "guard") {
		return runGuard(args[0] ?? "");
	}
	if (cmd === "agents") return runAgents(args);
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

const AGENTS_USAGE = "usage: neurastream agents list | allow <slug>... | deny <slug>...";

function runAgents(args: string[]): number {
	const [action, ...slugs] = args;
	if (action !== "list" && action !== "allow" && action !== "deny") {
		console.error(AGENTS_USAGE);
		return 2;
	}
	if (action !== "list" && slugs.length === 0) {
		console.error(AGENTS_USAGE);
		return 2;
	}
	const bad = invalidSlugs(slugs);
	if (bad.length) {
		console.error(`invalid slug: ${bad.join(", ")} (allowed: a-z, 0-9, -)`);
		return 2;
	}
	try {
		applyQueueEnv(loadConfig());
	} catch (err) {
		console.error(err instanceof ConfigError ? err.message : String(err));
		return 1;
	}
	const file = subagentsPath();
	if (action === "list") {
		for (const slug of allowedAgents(file)) console.log(slug);
		console.log(`file: ${file}`);
		return 0;
	}
	if (action === "allow") {
		const { added, kept } = allowAgents(file, slugs);
		for (const slug of added) console.log(`allowed: ${slug}`);
		for (const slug of kept) console.log(`already allowed: ${slug}`);
	} else {
		const { removed, absent } = denyAgents(file, slugs);
		for (const slug of removed) console.log(`removed: ${slug}`);
		for (const slug of absent) console.log(`not listed: ${slug}`);
	}
	console.log(`file: ${file}`);
	return 0;
}
