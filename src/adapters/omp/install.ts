// Links this package's omp extension under the caller's HOME only.
// Does not read or write the real user's agent directory: every path is under `home`.

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { configFile } from "../../core/config.ts";

import { adapterLiveFiles } from "./doctor.ts";
// Registers the plugin-command matcher into core's writeTargets (side effect).
import "./package-ops.ts";
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const OVERLAY = `adapter:
  name: omp
  sessions: "~/.omp/agent/sessions"
  pins: "~/.omp/agent/agents"
  extensions: "~/.omp/agent/extensions"
`;

// P8: the plugin dir is adapter surface and lands in the config's
// guards.protected, so core's protected check covers it without naming a
// harness path. installOmp writes it via the same overlay pass.
const PROTECTED = ["~/.omp/agent/agents/", "~/.omp/agent/extensions/", "~/.omp/plugins/"];

export interface InstallResult {
	extension: string;
	plugin: string;
	pinsCopied: string[];
	pinsKept: string[];
	overlay: "written" | "unchanged";
}

function ensureLink(link: string, target: string): void {
	mkdirSync(dirname(link), { recursive: true });
	let linked = false;
	try {
		linked = lstatSync(link).isSymbolicLink();
	} catch {
		linked = false;
	}
	if (linked) {
		if (readlinkSync(link) === target) return;
		throw new Error(`${link} exists and is not a link to ${target}; left it alone`);
	}
	if (existsSync(link)) throw new Error(`${link} exists and is not a link to ${target}; left it alone`);
	symlinkSync(target, link);
}

function linkInstalled(home: string): void {
	for (const file of adapterLiveFiles(home)) {
		if (file.live.includes("/.omp/agent/agents/")) continue;
		ensureLink(file.live, file.source);
	}
}

function copyPins(dest: string): { copied: string[]; kept: string[] } {
	const src = join(PACKAGE_ROOT, "templates/agents");
	mkdirSync(dest, { recursive: true });
	const copied: string[] = [];
	const kept: string[] = [];
	for (const name of readdirSync(src).sort()) {
		if (!name.endsWith(".md") || name.includes(".bak")) continue;
		const to = join(dest, name);
		if (existsSync(to)) {
			kept.push(to);
			continue;
		}
		copyFileSync(join(src, name), to);
		copied.push(to);
	}
	return { copied, kept };
}

function writeOverlay(file: string): "written" | "unchanged" {
	let text = readFileSync(file, "utf8");
	let changed = false;
	if (!/^adapter:/m.test(text)) {
		if (!text.endsWith("\n")) text += "\n";
		text += `\n${OVERLAY}`;
		changed = true;
	}
	const missing = PROTECTED.filter(p => !text.includes(p));
	if (missing.length) {
		const lines = missing.map(p => `    - "${p}"`).join("\n");
		if (text.includes("  protected: []")) {
			text = text.replace("  protected: []", `  protected:\n${lines}`);
		} else if (text.includes("\n  ledger_command:")) {
			text = text.replace("\n  ledger_command:", `\n${lines}\n  ledger_command:`);
		} else {
			throw new Error(`${file} has no guards.protected list to extend`);
		}
		changed = true;
	}
	if (!changed) return "unchanged";
	writeFileSync(file, text);
	return "written";
}

function linkPlugin(home: string): string {
	const r = spawnSync("omp", ["plugin", "link", PACKAGE_ROOT], {
		env: { ...process.env, HOME: home },
		encoding: "utf8",
	});
	if (r.error) {
		throw new Error("omp not found on PATH: install oh-my-pi (npm i -g @oh-my-pi/pi-coding-agent) and retry", { cause: r.error });
	}
	if (r.status !== 0) {
		const out = [r.stderr, r.stdout].find(s => typeof s === "string" && s.length > 0) ?? "";
		throw new Error(`omp plugin link failed (exit ${r.status ?? "signal"}): ${out.trim()}`);
	}
	return join(home, ".omp/plugins/node_modules/neurastream");
}

/** Link the extension, copy missing pins, write the overlay. HOME is the sandbox or the caller's home. */
export function installOmp(home: string): InstallResult {
	const file = configFile(home);
	if (!existsSync(file)) throw new Error(`no config at ${file}; run neurastream init first`);
	const extension = join(home, ".omp/agent/extensions/neurastream.ts");
	const target = join(PACKAGE_ROOT, "src/adapters/omp/index.ts");
	ensureLink(extension, target);
	mkdirSync(join(home, ".omp/agent/sessions"), { recursive: true });
	const pins = copyPins(join(home, ".omp/agent/agents"));
	linkInstalled(home);
	const plugin = linkPlugin(home);
	const overlay = writeOverlay(file);
	return { extension, plugin, pinsCopied: pins.copied, pinsKept: pins.kept, overlay };
}

export function printInstall(result: InstallResult): void {
	console.log(`neurastream adapter install omp: linked ${result.extension}`);
	console.log(`neurastream adapter install omp: plugin ${result.plugin}`);
	console.log(
		`neurastream adapter install omp: pins copied ${result.pinsCopied.length}, kept ${result.pinsKept.length}; overlay ${result.overlay}`,
	);
}

export function runAdapterInstall(args: string[]): number {
	if (args[0] !== "install" || args.length !== 2) {
		console.error("usage: neurastream adapter install omp");
		return 2;
	}
	if (args[1] !== "omp") {
		console.error(`unknown adapter ${args[1]}`);
		return 2;
	}
	try {
		printInstall(installOmp(homedir()));
		return 0;
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		return 1;
	}
}
