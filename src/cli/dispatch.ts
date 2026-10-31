import { readFileSync } from "node:fs";
import { pagesDoctor } from "../core/pages-doctor.ts";
import { ConfigError, configFile, loadConfig, type Config } from "../core/config.ts";
import { postReply } from "../core/notify.ts";
import { loadKnownSecrets, redactSecrets, redactSummary } from "../core/secret-redact.ts";
import { applyQueueEnv } from "../core/queue/env.ts";
import { getAdapter } from "../adapters/index.ts";
import { GUARD_USAGE, runGuard } from "./guard.ts";
import { runInit } from "./init.ts";
import { PORTED, runMain, runPorted } from "./commands.ts";
import { runMetrics } from "./metrics.ts";
import { runIncident } from "./incident.ts";
import { runTraces } from "./traces.ts";
import { runUi } from "./ui.ts";
import { runDiagram } from "./diagram.ts";
import { runNotes } from "./notes.ts";
import { runPages } from "./pages.ts";
import { runUninstall } from "../core/uninstall.ts";
import { queueMigrate } from "../core/queue-migrate.ts";
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
	"main-health",
	"queue-check",
	"queue-trim",
	"queue-close",
	"queue-finished",
	"queue-cancel",
	"main-start",
	"machine-guard",
	"quota-reset",
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
		"  neurastream notify test       post a test message to the configured Discord/Slack webhooks",
		"  neurastream redact            filter stdin through the secret redactor: stdout gets the text,",
		"                                stderr the hit summary (types and counts only)",
		"  neurastream queue migrate     fold the old repo INDEX.md files into the one main index",
		"  neurastream claim next|list|release <plan> [--force]",
		"                                claim the highest free plan for this Main, list the holders,",
		"                                free this Main's claim; --force frees another Main's claim —",
		"                                the owner's move in a terminal (the guard refuses agents)",
		"  neurastream config [--json]   print the merged config (defaults + file + env)",
		"  neurastream guard <event> --json",
		`                                (${GUARD_USAGE.slice(GUARD_USAGE.indexOf("(") + 1, -1)})`,
		"  neurastream main [args]       run omp under the launcher (automatic session rollover)",
		"  neurastream metrics <cmd>     self-metrics: report, features, releases, ci, false-alarm, rule (see README)",
		"  neurastream incident <cmd>    incidents Main must act on: list, add, plan, dismiss (see README)",
		"  neurastream traces claims <runId|--since 24h> [--json]",
		"                                check a run's final-report claims (test counts, exit codes,",
		"                                SHAs, heavy-run labels, changed paths) against the run's own",
		"                                tool activity; unmatched ones print as claim-unbacked findings",
		"  neurastream traces actions <runId|--since 24h> [--json]",
		"                                list the suspicious tool actions a run's trace shows (secret-",
		"                                path reads, network commands to unknown hosts, writes outside",
		"                                the allowed roots or on deny paths, pipes into a shell); the",
		"                                high ones also open realtime suspicious-action incidents",
		"  neurastream traces efficiency <runId|--since 24h> [--json]",
		"                                count the run's wasted tool calls (same file re-read, failed",
		"                                command rerun, failed edit, repeated guard block, idle poll):",
		"                                calls, wasted, waste % and the count per waste rule",
		"  neurastream ui                serve the owner's phone page on the tailnet address (ui.enabled, ui.owner_login)",
		"  neurastream ui on --login <tailscale login> [--port N]",
		"                                one go: writes ui.enabled/owner_login (and port) into the config,",
		"                                installs and restarts the neurastream-ui user unit, prints the phone",
		"                                link; `neurastream ui off` stops and disables it, sets enabled: false",
		"  neurastream pages on|off|serve|publish|list  host static files over the tailnet",
		"                                publish --plan <plan.md> adds the Approve bar that records the plan's approval",
		"  neurastream notes check <page>               list the notes without an answer, exit 1 while any is open",
		"  neurastream diagram check <html> <plan.md>   every phase and path of the plan is in a box, 2+ kids per drilldown",
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
	if (cmd === "traces") return runTraces(args);
	if (cmd === "ui") return runUi(args);
	if (cmd === "pages") return runPages(args);
	if (cmd === "notes") return runNotes(args);
	if (cmd === "diagram") return runDiagram(args);
	if (cmd === "adapter") return getAdapter().install(args);
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
	if (cmd === "doctor") {
		for (const warning of pagesDoctor()) console.warn(`warning: ${warning}`);
		return getAdapter().doctor();
	}
	if (cmd === "notify") return runNotify(args);
	if (cmd === "redact") return runRedact(args);
	if (cmd === "uninstall") return runUninstall(args);
	if (cmd === "queue" && args[0] === "migrate") {
		try {
			return queueMigrate(args.slice(1), loadConfig());
		} catch (err) {
			console.error(err instanceof ConfigError ? err.message : String(err));
			return 1;
		}
	}
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

const NOTIFY_USAGE = "usage: neurastream notify test";

/** `neurastream notify test`: post one line to every configured provider; exit 1 when any fails. */
function runNotify(args: string[]): number | Promise<number> {
	if (args[0] !== "test" || args.length !== 1) {
		console.error(NOTIFY_USAGE);
		return 2;
	}
	let cfg: Config;
	try {
		cfg = loadConfig();
	} catch (err) {
		console.error(err instanceof ConfigError ? err.message : String(err));
		return 1;
	}
	return postReply("neurastream notify test", cfg).then(results => {
		let failed = 0;
		for (const r of results) {
			if (r.posted) console.log(`notify ${r.provider}: posted (${r.chunks} chunk${r.chunks === 1 ? "" : "s"})`);
			else {
				failed++;
				console.error(`notify ${r.provider}: ${r.error}`);
			}
		}
		if (results.length === 0) console.log("notify: no provider configured (notify.discord_webhook_file / notify.slack_webhook_file)");
		return failed > 0 ? 1 : 0;
	});
}

const REDACT_USAGE = "usage: neurastream redact < text   (stdin to stdout; the hit summary goes to stderr)";

/** `neurastream redact`: the core the adapter and notify use, as a filter, so another harness hook
 *  can pipe a tool result through the same rules. The text is passed through untouched except for
 *  the markers; stderr gets the type names and counts, never a value. */
function runRedact(args: string[]): number {
	if (args.length > 0) {
		console.error(REDACT_USAGE);
		return 2;
	}
	let cfg: Config;
	try {
		cfg = loadConfig();
	} catch (err) {
		console.error(err instanceof ConfigError ? err.message : String(err));
		return 1;
	}
	const text = readFileSync(0, "utf8");
	const result = redactSecrets(text, loadKnownSecrets(cfg), cfg.secrets.extra_patterns);
	process.stdout.write(result.text);
	console.error(result.hits.length > 0 ? redactSummary(result.hits) : "secret-redact: nothing to hide");
	return 0;
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
