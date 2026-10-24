// `neurastream ui on|off` core (plan 20261025_0300_ui_on_off): one command sets ui.enabled /
// ui.owner_login (and ui.port) in the user's config.yml, installs the systemd user unit,
// starts it and prints the phone link; `off` stops the unit and sets ui.enabled back to false.
// Pure over an injected command runner and the Tailscale seam (src/cli/ui.ts wires the real
// ones), so tests record argv and never run systemctl or the tailscale binary.

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigError, configFile, loadConfig } from "./config.ts";
import { realTailscale, type Tailscale } from "./tailscale.ts";

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
}

// Line-based edit of the top-level `ui:` block: replaces only the enabled/owner_login/port
// lines inside it, keeps every other line of the file byte-for-byte (comments, order, other
// sections), and appends a fresh block when the config has none. Never re-serialises YAML.
function editUiBlock(text: string | null, values: { enabled: boolean; owner_login: string | null; port: number | null }): string {
	const fresh = ["ui:", `  enabled: ${values.enabled}`];
	if (values.owner_login !== null) fresh.push(`  owner_login: ${values.owner_login}`);
	if (values.port !== null) fresh.push(`  port: ${values.port}`);
	if (text === null) return `${fresh.join("\n")}\n`;
	const lines = text.split("\n");
	let start = -1;
	for (let i = 0; i < lines.length; i++) {
		if (/^ui\s*:(\s*(?:#.*)?)?$/.test(lines[i] ?? "")) {
			start = i;
			break;
		}
	}
	if (start === -1) {
		const base = text === "" || text.endsWith("\n") ? text : `${text}\n`;
		return `${base}${fresh.join("\n")}\n`;
	}
	let end = start + 1;
	while (end < lines.length && (lines[end] === "" || /^[ \t]/.test(lines[end]!))) end++;
	const setKey = (key: string, value: string): void => {
		const re = new RegExp(`^([ \\t]+)${key}\\s*:.*$`);
		for (let i = start + 1; i < end; i++) {
			const line = lines[i]!;
			if (re.test(line)) {
				lines[i] = line.replace(re, `$1${key}: ${value}`);
				return;
			}
		}
		// The block has no such key: insert after its last non-blank line, at two-space indent.
		let at = start + 1;
		for (let i = start + 1; i < end; i++) if (lines[i]!.trim() !== "") at = i + 1;
		lines.splice(at, 0, `  ${key}: ${value}`);
	};
	setKey("enabled", String(values.enabled));
	if (values.owner_login !== null) setKey("owner_login", values.owner_login);
	if (values.port !== null) setKey("port", String(values.port));
	return lines.join("\n");
}

// Validates the edited text through loadConfig before anything is written: if it would not
// load, nothing is written and the caller reports the error (the real file stays untouched).
function checkEdited(edited: string, home: string, what: string, error: (line: string) => void): boolean {
	const check = join(tmpdir(), `neurastream-ui-${what}-check-${process.pid}.yml`);
	try {
		writeFileSync(check, edited);
		loadConfig({ file: check, home });
		return true;
	} catch (err) {
		error(err instanceof ConfigError ? err.message : String(err));
		return false;
	} finally {
		rmSync(check, { force: true });
	}
}

export function uiOn(opts: UiOnOptions): number {
	const home = opts.home ?? homedir();
	const runner = opts.runner ?? systemRunner;
	const tailscale = opts.tailscale ?? realTailscale;
	const print = opts.print ?? console.log;
	const error = opts.error ?? console.error;
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
	const edited = editUiBlock(original, { enabled: true, owner_login: opts.login, port: opts.port ?? null });
	if (!checkEdited(edited, home, "on", error)) return 1;
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, edited);
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
			error("neurastream ui: systemctl failed — the config was already written; fix the unit and run `neurastream ui` (or this command again).");
			return 1;
		}
	}
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
		const edited = editUiBlock(readFileSync(file, "utf8"), { enabled: false, owner_login: null, port: null });
		if (!checkEdited(edited, home, "off", error)) return 1;
		writeFileSync(file, edited);
	}
	return 0;
}
