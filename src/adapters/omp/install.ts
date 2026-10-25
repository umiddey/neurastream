// Links this package's omp extension under the caller's HOME only.
// Does not read or write the real user's agent directory: every path is under `home`.

import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderBlock, upsertBlock } from "../../core/agents-md.ts";
import { configFile, loadConfig } from "../../core/config.ts";

import { adapterLiveFiles, liveAgentsMd } from "./doctor.ts";
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
	plugin: string;
	removedStaleLink: string | null;
	pinsCopied: string[];
	pinsKept: string[];
	skillsCopied: string[];
	skillsKept: string[];
	overlay: "written" | "unchanged";
	agentsMd: "written" | "unchanged";
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
		// agents/ and skills/ are copied, not linked; the plugin link is `omp plugin link`'s
		// own output (linkPlugin below), never ours to ensureLink.
		if (file.live.includes("/.omp/agent/agents/") || file.live.includes("/.omp/plugins/") || file.live.includes("/.agents/skills/")) continue;
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

// Shipped skills (templates/skills/<name>/) are copied, not linked: the owner
// edits them, so an existing skill dir is kept as it is.
function copySkills(home: string): { copied: string[]; kept: string[] } {
	const src = join(PACKAGE_ROOT, "templates/skills");
	const dest = join(home, ".agents/skills");
	const copied: string[] = [];
	const kept: string[] = [];
	if (!existsSync(src)) return { copied, kept };
	mkdirSync(dest, { recursive: true });
	for (const name of readdirSync(src, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()) {
		const to = join(dest, name);
		if (existsSync(to)) {
			kept.push(to);
			continue;
		}
		cpSync(join(src, name), to, { recursive: true });
		copied.push(to);
	}
	return { copied, kept };
}

export function writeOverlay(file: string): "written" | "unchanged" {
	let text = readFileSync(file, "utf8");
	let changed = false;
	if (!/^adapter:/m.test(text)) {
		if (!text.endsWith("\n")) text += "\n";
		text += `\n${OVERLAY}`;
		changed = true;
	}
	const missing = PROTECTED.filter(p => !text.includes(p));
	if (missing.length) {
		const lines = missing.map(p => `    - "${p}"\n`).join("");
		// The items always go under their own `protected:` key: the empty list becomes a block
		// list, an existing block list gains them under its header, a missing key is added at
		// the top of `guards:`. Any other form (a flow list with items) is the owner's to fix.
		if (/^ {2}protected: \[\][ \t]*$/m.test(text)) {
			text = text.replace(/^ {2}protected: \[\][ \t]*\n?/m, `  protected:\n${lines}`);
		} else if (/^ {2}protected:[ \t]*\n/m.test(text)) {
			text = text.replace(/^ {2}protected:[ \t]*\n/m, `  protected:\n${lines}`);
		} else if (/^ {2}protected:/m.test(text)) {
			throw new Error(`${file}: guards.protected is not a block list; list it as "  protected:" with "    - " items, then rerun`);
		} else if (/^guards:[ \t]*\n/m.test(text)) {
			text = text.replace(/^guards:[ \t]*\n/m, `guards:\n  protected:\n${lines}`);
		} else {
			throw new Error(`${file} has no guards: section to extend`);
		}
		changed = true;
	}
	if (!changed) return "unchanged";
	writeFileSync(file, text);
	return "written";
}

// Writes the managed block into the owner's AGENTS.md: the rest of the file is never touched.
function writeAgentsMd(home: string): "written" | "unchanged" {
	const file = liveAgentsMd(home);
	const current = existsSync(file) ? readFileSync(file, "utf8") : "";
	const next = upsertBlock(current, renderBlock(loadConfig({ home })));
	if (next === current) return "unchanged";
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, next);
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

/** Link the plugin, copy missing pins, write the overlay. HOME is the sandbox or the caller's home. */
export function installOmp(home: string): InstallResult {
	const file = configFile(home);
	if (!existsSync(file)) throw new Error(`no config at ${file}; run neurastream init first`);
	// P9: ONE load route. omp loads extensions-dir files AND a plugin package's
	// package.json#omp.extensions, so an extensions/neurastream.ts link beside
	// `omp plugin link` runs every hook twice. Only the plugin route remains —
	// the one guard parity locks (~/.omp/plugins/ + the package root). A stale
	// link an older install made is removed, but only when it is a symlink: a
	// real file there is never ours to delete.
	const extension = join(home, ".omp/agent/extensions/neurastream.ts");
	let removedStaleLink: string | null = null;
	try {
		if (lstatSync(extension).isSymbolicLink()) {
			unlinkSync(extension);
			removedStaleLink = extension;
		}
	} catch {
		// absent: nothing stale to remove
	}
	mkdirSync(join(home, ".omp/agent/sessions"), { recursive: true });
	const pins = copyPins(join(home, ".omp/agent/agents"));
	linkInstalled(home);
	const plugin = linkPlugin(home);
	const overlay = writeOverlay(file);
	const agentsMd = writeAgentsMd(home);
	const skills = copySkills(home);
	return { plugin, removedStaleLink, pinsCopied: pins.copied, pinsKept: pins.kept, skillsCopied: skills.copied, skillsKept: skills.kept, overlay, agentsMd };
}

export function printInstall(result: InstallResult): void {
	console.log(`neurastream adapter install omp: plugin ${result.plugin}`);
	if (result.removedStaleLink) console.log(`neurastream adapter install omp: removed stale extension link ${result.removedStaleLink}`);
	console.log(
		`neurastream adapter install omp: pins copied ${result.pinsCopied.length}, kept ${result.pinsKept.length}; overlay ${result.overlay}`,
	);
	console.log(`neurastream adapter install omp: skills copied ${result.skillsCopied.length}, kept ${result.skillsKept.length}`);
	console.log(`neurastream adapter install omp: AGENTS.md block ${result.agentsMd}`);
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
