// `neurastream ui on|off` core (plan 20261025_0300_ui_on_off): one command sets ui.enabled /
// ui.owner_login (and ui.port) in the user's config.yml, installs the systemd user unit,
// starts it and prints the phone link; `off` stops the unit and sets ui.enabled back to false.
// Pure over an injected command runner and the Tailscale seam (src/cli/ui.ts wires the real
// ones), so tests record argv and never run systemctl or the tailscale binary.

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigError, configFile, loadConfig } from "./config.ts";
import { realTailscale, type Tailscale } from "./tailscale.ts";
import { checkEdited, setConfigKeys } from "./config-edit.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
export const UI_UNIT_TEMPLATE = join(HERE, "../../templates/systemd/neurastream-ui.service");

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
const TAILSCALE_MISSING = "The phone page needs Tailscale (free, private network for your devices). Install it: Linux `curl -fsSL https://tailscale.com/install.sh | sh` (asks for your password), macOS: the App Store app, others: https://tailscale.com/download. Then run `neurastream ui on` again.";
const TAILSCALE_STOPPED = "Tailscale is installed but not connected. Run `sudo tailscale up` (Linux) or open the Tailscale app (macOS), then run this again.";
export { TAILSCALE_MISSING, TAILSCALE_STOPPED };

export interface UiSetupOptions {
	/** HOME the config file and the user unit resolve against. Default: the real home. */
	home?: string;
	/** Command runner. Default: systemRunner (spawnSync). */
	runner?: Runner;
	/** Tailscale seam. Default: realTailscale. */
	tailscale?: Tailscale;
	print?: (line: string) => void;
	error?: (line: string) => void;
}

export interface UiOnOptions extends UiSetupOptions {
	login: string;
	/** The --port N of the command line; null leaves the config's ui.port in place. */
	port?: number | null;
	/** Terminal seam for the missing-tailscale question. Absent: no question, only the message. src/cli/ui.ts passes the real one on a TTY. */
	terminal?: Terminal;
}

export function uiOn(opts: UiOnOptions): number {
	const home = opts.home ?? homedir();
	const runner = opts.runner ?? systemRunner;
	const tailscale = opts.tailscale ?? realTailscale;
	const print = opts.print ?? console.log;
	const error = opts.error ?? console.error;
	// Tailscale comes first (plan 20261028_2356 P2): nothing is read, written or run unless it is up.
	const state = tailscale.state();
	if (state === "missing") {
		error(`neurastream ui: ${TAILSCALE_MISSING}`);
		const terminal = opts.terminal;
		if (terminal && terminal.ask("Open the Tailscale download page now? [y/N] ").trim().toLowerCase() === "y") terminal.open(TAILSCALE_DOWNLOAD);
		return 1;
	}
	if (state === "stopped") {
		error(`neurastream ui: ${TAILSCALE_STOPPED}`);
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
	const logins = tailscale.logins();
	if (logins === null) {
		error("neurastream ui: cannot read the tailnet logins (`tailscale status --json` failed) — skipping the login check");
	} else if (!logins.includes(opts.login)) {
		error(`neurastream ui: ${opts.login} is not a login on this tailnet. Logins seen: ${logins.join(", ")}`);
		return 1;
	}
	const original = existsSync(file) ? readFileSync(file, "utf8") : null;
	const values: Record<string, string> = { "ui.enabled": "true", "ui.owner_login": opts.login };
	if (typeof opts.port === "number") values["ui.port"] = String(opts.port);
	let edited: string;
	try {
		edited = setConfigKeys(original, values);
	} catch (err) {
		error(err instanceof ConfigError ? err.message : String(err));
		return 1;
	}
	if (!checkEdited(edited, home, error)) return 1;
	const unitPath = join(home, ".config", "systemd", "user", "neurastream-ui.service");
	mkdirSync(dirname(unitPath), { recursive: true });
	copyFileSync(UI_UNIT_TEMPLATE, unitPath);
	for (const args of [
		["systemctl", "--user", "daemon-reload"],
		["systemctl", "--user", "enable", "neurastream-ui"],
		["systemctl", "--user", "restart", "neurastream-ui"],
	]) {
		const r = runner(args);
		if (r.status !== 0) {
			if (r.stderr.trim()) error(r.stderr.trimEnd());
			error("neurastream ui: systemctl failed — the config was not changed; fix the unit and run `neurastream ui` (or this command again).");
			return 1;
		}
	}
	// The config only turns on once the unit is up: a systemctl failure leaves the config
	// exactly as it was (a leftover unit file is fine).
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, edited);
	const name = tailscale.dnsName() ?? tailscale.ip4();
	const port = opts.port ?? cfg.ui.port;
	if (name) print(`http://${name}:${port}`);
	else error("neurastream ui: could not read this machine's MagicDNS name or tailnet address (is tailscale up?) — the page is running, open it at http://<MagicDNS name>:" + port);
	return 0;
}

export function uiOff(opts: UiSetupOptions): number {
	const home = opts.home ?? homedir();
	const runner = opts.runner ?? systemRunner;
	const error = opts.error ?? console.error;
	const r = runner(["systemctl", "--user", "disable", "--now", "neurastream-ui"]);
	if (r.status !== 0) {
		if (r.stderr.trim()) error(r.stderr.trimEnd());
		error("neurastream ui: systemctl failed — the config was not touched.");
		return 1;
	}
	const file = configFile(home);
	if (existsSync(file)) {
		const edited = setConfigKeys(readFileSync(file, "utf8"), { "ui.enabled": "false" });
		if (!checkEdited(edited, home, error)) return 1;
		writeFileSync(file, edited);
	}
	return 0;
}
