// `neurastream workspace on|off` core: one command sets workspace.enabled / workspace.owner_login
// (and workspace.port) in the user's config.yml, installs the systemd user unit, starts it and
// prints the phone link; `off` stops the unit and sets workspace.enabled back to false. Pure over
// an injected command runner and the Tailscale seam (src/cli/workspace.ts wires the real ones), so
// tests record argv and never run systemctl or the tailscale binary.
// (The command and keys were `ui` before the workspace rename; an existing `ui:` block moves to
// `workspace:` in loadConfig's migrateLegacy, and `on` retires the old neurastream-ui unit.)

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigError, type Config, configFile, loadConfig } from "./config.ts";
import { realTailscale, type Tailscale } from "./tailscale.ts";
import { checkEdited, setConfigKeys } from "./config-edit.ts";
import { TEAM_NAME_HINT, TEAM_NAME_RE, repoListError } from "./team-labels.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
export const UI_UNIT_TEMPLATE = join(HERE, "../../templates/systemd/neurastream-workspace.service");

export interface RunnerResult {
	status: number | null;
	stderr: string;
}

export type Runner = (args: string[]) => RunnerResult;

// Production runner: one systemctl (or any) command, stderr captured for the error path.
export const systemRunner: Runner = args => {
	const r = spawnSync(args[0]!, args.slice(1), { encoding: "utf8", timeout: 30000 });
	return { status: r.status, stderr: r.stderr ?? "" };
};

export interface Terminal {
	/** Prints the question on the terminal and returns the answer line. */
	ask(question: string): string;
	/** Opens a URL in the default browser. */
	open(url: string): void;
}

// Production terminal. sh reads the answer from the inherited terminal, so uiOn stays synchronous.
export const systemTerminal: Terminal = {
	ask(question) {
		const r = spawnSync("sh", ["-c", 'printf "%s" "$1" >&2; read -r answer; printf "%s" "$answer"', "sh", question], { encoding: "utf8", stdio: ["inherit", "pipe", "inherit"] });
		return r.stdout ?? "";
	},
	open(url) {
		spawnSync(process.platform === "darwin" ? "open" : "xdg-open", [url], { stdio: "ignore" });
	},
};

const TAILSCALE_DOWNLOAD = "https://tailscale.com/download";
const TAILSCALE_MISSING = "The phone page needs Tailscale (free, private network for your devices). Install it: Linux `curl -fsSL https://tailscale.com/install.sh | sh` (asks for your password), macOS: the App Store app, others: https://tailscale.com/download. Then run `neurastream workspace on` again.";
const TAILSCALE_STOPPED = "Tailscale is installed but not connected. Run `sudo tailscale up` (Linux) or open the Tailscale app (macOS), then run this again.";
export { TAILSCALE_MISSING, TAILSCALE_STOPPED };

export interface UiSetupOptions {
	/** HOME the config file and the user unit resolve against. Default: the real home. */
	home?: string;
	/** Command runner. Default: systemRunner (spawnSync). */
	runner?: Runner;
	/** Tailscale seam. Default: realTailscale. */
	tailscale?: Tailscale;
	/** The personal owner page (default) or one team's page and queue server. */
	scope?: Scope;
	print?: (line: string) => void;
	error?: (line: string) => void;
}

/** Which page a command sets up: the personal owner page, or the named team's page and queue server. */
export type Scope = { kind: "personal" } | { kind: "team"; name: string };
export const PERSONAL: Scope = { kind: "personal" };

export interface UiOnOptions extends UiSetupOptions {
	/** Personal scope: the tailnet login that may open the page (required). */
	login?: string;
	/** Team scope: the tailnet login of the team's admin (required, checked against the tailnet). */
	admin?: string;
	/** Team scope: the repo globs the team's server serves (required, each checked by repoListError). */
	repos?: string[];
	/** The --port N of the command line; null leaves the config's workspace.port in place (personal) or the default (team). */
	port?: number | null;
	/** Terminal seam for the missing-tailscale question. Absent: no question, only the message. src/cli/workspace.ts passes the real one on a TTY. */
	terminal?: Terminal;
}

/** One team's persisted server settings: `team-<name>.json` beside config.yml, written 0600. */
export interface TeamServerFile {
	team: string;
	admin: string;
	leader: string;
	repos: string[];
	members: string[];
	port: number;
}

export function unitName(scope: Scope): string {
	return scope.kind === "personal" ? "neurastream-workspace" : `neurastream-team-${scope.name}`;
}

export function teamServerFile(home: string, name: string): string {
	return join(dirname(configFile(home)), `team-${name}.json`);
}

/** The team names that have a settings file on this machine, so the personal page can refuse to run beside them. */
export function teamServerNames(home: string): string[] {
	const dir = dirname(configFile(home));
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter(f => /^team-.+\.json$/.test(f))
		.map(f => f.slice("team-".length, -".json".length));
}

/** Reads one team's settings file; null when it does not exist. A file that does not parse or lacks a field throws. */
export function readTeamServerFile(home: string, name: string): TeamServerFile | null {
	const file = teamServerFile(home, name);
	if (!existsSync(file)) return null;
	const data = JSON.parse(readFileSync(file, "utf8")) as Partial<TeamServerFile>;
	const ok = typeof data.team === "string" && typeof data.admin === "string" && typeof data.leader === "string"
		&& Array.isArray(data.repos) && Array.isArray(data.members) && typeof data.port === "number";
	if (!ok) throw new Error(`team settings ${file} is missing a field; run \`neurastream workspace off --team ${name}\` and set it up again`);
	return data as TeamServerFile;
}

/** Writes one team's settings through a tmp file and a rename, so a crash never leaves half a file. */
export function writeTeamServerFile(home: string, name: string, data: TeamServerFile): void {
	const file = teamServerFile(home, name);
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
	renameSync(tmp, file);
}

/** The team's queue database: one SQLite file per team under the queue state dir, kept across off/on. */
export function teamDbPath(cfg: Config, name: string): string {
	return join(cfg.paths.queue_state, "team-server", `${name}.sqlite`);
}

/** The team unit is the personal page's template with `--team <name>` on ExecStart and the team named in its description. */
export function teamUnitText(template: string, team: string): string {
	const exec = /^ExecStart=%h\/\.bun\/bin\/neurastream workspace$/m;
	if (!exec.test(template)) throw new Error("the workspace unit template has no `ExecStart=… neurastream workspace` line");
	return template
		.replace(exec, `ExecStart=%h/.bun/bin/neurastream workspace --team ${team}`)
		.replace(/^Description=(.*)$/m, `Description=$1 — team ${team}`);
}

export function uiOn(opts: UiOnOptions): number {
	const home = opts.home ?? homedir();
	const runner = opts.runner ?? systemRunner;
	const tailscale = opts.tailscale ?? realTailscale;
	const print = opts.print ?? console.log;
	const error = opts.error ?? console.error;
	const scope = opts.scope ?? PERSONAL;
	// Argument checks come first: a refused call reads, writes and runs nothing.
	if (scope.kind === "team") {
		if (!TEAM_NAME_RE.test(scope.name)) {
			error(`neurastream workspace: ${TEAM_NAME_HINT}`);
			return 2;
		}
	}
	const who = scope.kind === "team" ? opts.admin : opts.login;
	if (!who) {
		error(scope.kind === "team"
			? "neurastream workspace on --team: --admin <tailscale login> is required — e.g. neurastream workspace on --team <name> --admin me@example.com --repo github.com/acme/*"
			: "neurastream workspace on: --login <tailscale login> is required — e.g. neurastream workspace on --login me@example.com");
		return 1;
	}
	const repos = opts.repos ?? [];
	if (scope.kind === "team") {
		const repoErr = repoListError(repos);
		if (repoErr) {
			error(`neurastream workspace on --team: ${repoErr}`);
			return 1;
		}
	}
	// Tailscale comes first (plan 20261028_2356 P2): nothing is read, written or run unless it is up.
	const state = tailscale.state();
	if (state === "missing") {
		error(`neurastream workspace: ${TAILSCALE_MISSING}`);
		const terminal = opts.terminal;
		if (terminal && terminal.ask("Open the Tailscale download page now? [y/N] ").trim().toLowerCase() === "y") terminal.open(TAILSCALE_DOWNLOAD);
		return 1;
	}
	if (state === "stopped") {
		error(`neurastream workspace: ${TAILSCALE_STOPPED}`);
		return 1;
	}
	const file = configFile(home);
	let cfg;
	try {
		cfg = loadConfig({ home });
	} catch (err) {
		error(err instanceof ConfigError ? err.message : String(err));
		return 1;
	}
	// A team server and the personal page never run together on one machine: each side refuses the other.
	if (scope.kind === "personal") {
		const teams = teamServerNames(home);
		if (teams.length > 0) {
			error(`neurastream workspace: team server "${teams[0]}" is set up on this machine; the personal page and a team server cannot run together. Run \`neurastream workspace off --team ${teams[0]}\` first.`);
			return 1;
		}
	} else if (cfg.workspace.enabled) {
		error("neurastream workspace: the personal page is on; run `neurastream workspace off` before setting up a team server.");
		return 1;
	}
	const logins = tailscale.logins();
	if (logins === null) {
		// A team admin is a security boundary, so the team path fails closed; the personal page keeps its skip-with-warning.
		if (scope.kind === "team") {
			error("neurastream workspace: cannot read the tailnet logins (`tailscale status --json` failed); a team admin must be verified, so nothing was changed.");
			return 1;
		}
		error("neurastream workspace: cannot read the tailnet logins (`tailscale status --json` failed) — skipping the login check");
	} else if (!logins.includes(who)) {
		error(`neurastream workspace: ${who} is not a login on this tailnet. Logins seen: ${logins.join(", ")}`);
		return 1;
	}
	const port = typeof opts.port === "number" ? opts.port : cfg.workspace.port;
	let edited = "";
	if (scope.kind === "personal") {
		const original = existsSync(file) ? readFileSync(file, "utf8") : null;
		const values: Record<string, string> = { "workspace.enabled": "true", "workspace.owner_login": who };
		if (typeof opts.port === "number") values["workspace.port"] = String(opts.port);
		try {
			edited = setConfigKeys(original, values);
		} catch (err) {
			error(err instanceof ConfigError ? err.message : String(err));
			return 1;
		}
		if (!checkEdited(edited, home, error)) return 1;
		// The page's unit was neurastream-ui before the workspace rename: retire it first (best effort —
		// a machine that never had it still succeeds) and remove its file when one is installed.
		runner(["systemctl", "--user", "disable", "--now", "neurastream-ui"]);
		const oldUnit = join(home, ".config", "systemd", "user", "neurastream-ui.service");
		if (existsSync(oldUnit)) unlinkSync(oldUnit);
	}
	const unit = unitName(scope);
	const unitPath = join(home, ".config", "systemd", "user", `${unit}.service`);
	mkdirSync(dirname(unitPath), { recursive: true });
	if (scope.kind === "personal") copyFileSync(UI_UNIT_TEMPLATE, unitPath);
	else writeFileSync(unitPath, teamUnitText(readFileSync(UI_UNIT_TEMPLATE, "utf8"), scope.name));
	for (const args of [
		["systemctl", "--user", "daemon-reload"],
		["systemctl", "--user", "enable", unit],
		["systemctl", "--user", "restart", unit],
	]) {
		const r = runner(args);
		if (r.status !== 0) {
			if (r.stderr.trim()) error(r.stderr.trimEnd());
			error("neurastream workspace: systemctl failed — the config was not changed; fix the unit and run `neurastream workspace` (or this command again).");
			return 1;
		}
	}
	// The config (personal) or the team's settings file only changes once the unit is up: a systemctl
	// failure leaves it exactly as it was (a leftover unit file is fine).
	if (scope.kind === "personal") {
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, edited);
	} else {
		// The leader starts as the admin; members start empty and are added with `workspace members add`.
		writeTeamServerFile(home, scope.name, { team: scope.name, admin: who, leader: who, repos, members: [], port });
	}
	const name = tailscale.dnsName() ?? tailscale.ip4();
	if (name) print(`http://${name}:${port}`);
	else error("neurastream workspace: could not read this machine's MagicDNS name or tailnet address (is tailscale up?) — the page is running, open it at http://<MagicDNS name>:" + port);
	if (scope.kind === "team") print(`team ${scope.name}: admin ${who}. Add members: neurastream workspace members add <login> --team ${scope.name}`);
	return 0;
}

export function uiOff(opts: UiSetupOptions): number {
	const home = opts.home ?? homedir();
	const runner = opts.runner ?? systemRunner;
	const error = opts.error ?? console.error;
	const scope = opts.scope ?? PERSONAL;
	if (scope.kind === "team" && !TEAM_NAME_RE.test(scope.name)) {
		error(`neurastream workspace: ${TEAM_NAME_HINT}`);
		return 2;
	}
	const r = runner(["systemctl", "--user", "disable", "--now", unitName(scope)]);
	if (r.status !== 0) {
		if (r.stderr.trim()) error(r.stderr.trimEnd());
		error("neurastream workspace: systemctl failed — the config was not touched.");
		return 1;
	}
	if (scope.kind === "team") {
		// The team's database stays, so `on --team` again brings the same queue back; only its settings file goes.
		const file = teamServerFile(home, scope.name);
		if (existsSync(file)) unlinkSync(file);
		return 0;
	}
	const file = configFile(home);
	if (existsSync(file)) {
		const edited = setConfigKeys(readFileSync(file, "utf8"), { "workspace.enabled": "false" });
		if (!checkEdited(edited, home, error)) return 1;
		writeFileSync(file, edited);
	}
	return 0;
}
