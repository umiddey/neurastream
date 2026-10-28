// Links this package's omp extension under the caller's HOME only.
// Does not read or write the real user's agent directory: every path is under `home`.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripBlock } from "../../core/agents-md.ts";
import { configFile } from "../../core/config.ts";

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
	/** Replaced after the owner answered yes to the P7 update question. */
	skillsPlaced: string[];
	/** Left alone: not interactive, or answered no. */
	skillsSkipped: string[];
	overlay: "written" | "unchanged";
	agentsMd: "removed" | "unchanged";
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
// edits them, so an existing skill dir is never overwritten silently (P7).
const SKILL_STATE = ".neurastream-install.json";

function fileHash(file: string): string {
	return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** skill name -> (path inside the skill dir -> sha256 of the shipped file). */
function shippedSkills(): Map<string, Map<string, string>> {
	const out = new Map<string, Map<string, string>>();
	const src = join(PACKAGE_ROOT, "templates/skills");
	if (!existsSync(src)) return out;
	const walk = (dir: string, rel: string, files: Map<string, string>): void => {
		for (const name of readdirSync(dir).sort()) {
			const p = join(dir, name);
			const r = rel === "" ? name : `${rel}/${name}`;
			if (lstatSync(p).isDirectory()) walk(p, r, files);
			else if (lstatSync(p).isFile()) files.set(r, fileHash(p));
		}
	};
	for (const ent of readdirSync(src, { withFileTypes: true })) {
		if (!ent.isDirectory()) continue;
		const files = new Map<string, string>();
		walk(join(src, ent.name), "", files);
		out.set(ent.name, files);
	}
	return out;
}

function readSkillState(file: string): Record<string, string> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return {};
	}
	if (parsed === null || typeof parsed !== "object" || !("files" in parsed)) return {};
	const files = parsed.files;
	if (files === null || typeof files !== "object") return {};
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(files)) if (typeof value === "string") out[key] = value;
	return out;
}

/** The CHANGELOG bullets that name this skill, with the section they sit under. */
function skillNotes(name: string, changelog: string): string[] {
	const out: string[] = [];
	let section = "";
	for (const line of changelog.split("\n")) {
		if (line.startsWith("## ")) section = line.slice(3).trim();
		else if (line.startsWith("- ") && line.toLowerCase().includes(name.toLowerCase()))
			out.push(`  ${section}: ${line.slice(2).trim().slice(0, 160)}`);
	}
	return out.slice(0, 6);
}

/** The first lines that differ, minus and plus side by side. */
function shortDiff(live: string, shipped: string, max = 8): string[] {
	const a = live.split("\n");
	const b = shipped.split("\n");
	const out: string[] = [];
	for (let i = 0; i < Math.max(a.length, b.length) && out.length < max; i++) {
		if ((a[i] ?? "") === (b[i] ?? "")) continue;
		if (a[i] !== undefined) out.push(`    - ${a[i]}`);
		if (b[i] !== undefined) out.push(`    + ${b[i]}`);
	}
	return out;
}

interface SkillSync {
	copied: string[];
	kept: string[];
	/** Replaced after the owner answered yes. */
	placed: string[];
	/** Left alone: not interactive, or the owner answered no. */
	skipped: string[];
}

/**
 * P7: one sha256 per shipped skill file is recorded at install. On update each skill whose shipped
 * content changed prints its CHANGELOG lines and a short diff and asks "update this skill? [y/N]".
 * Yes replaces; No leaves the file byte-identical and the question comes back with the next release
 * that changes it. A file the owner edited says so before the question. Non-interactive runs never
 * overwrite and print what they skipped.
 */
function syncSkills(home: string, ask: ((question: string) => string) | null): SkillSync {
	const dest = join(home, ".agents/skills");
	const stateFile = join(dest, SKILL_STATE);
	const shipped = shippedSkills();
	const recorded = readSkillState(stateFile);
	const next: Record<string, string> = { ...recorded };
	const out: SkillSync = { copied: [], kept: [], placed: [], skipped: [] };
	if (shipped.size === 0) return out;
	mkdirSync(dest, { recursive: true });
	let changelog = "";
	try {
		changelog = readFileSync(join(PACKAGE_ROOT, "CHANGELOG.md"), "utf8");
	} catch {}
	for (const [name, files] of shipped) {
		const to = join(dest, name);
		const record = () => {
			for (const [rel, hash] of files) next[`${name}/${rel}`] = hash;
		};
		if (!existsSync(to)) {
			cpSync(join(PACKAGE_ROOT, "templates/skills", name), to, { recursive: true });
			record();
			out.copied.push(to);
			continue;
		}
		const pending = [...files].filter(([rel, hash]) => {
			const live = join(to, rel);
			return recorded[`${name}/${rel}`] !== hash && (existsSync(live) ? fileHash(live) : "") !== hash;
		});
		if (pending.length === 0) {
			record();
			out.kept.push(to);
			continue;
		}
		const edited = pending
			.filter(([rel]) => {
				const live = join(to, rel);
				return existsSync(live) && recorded[`${name}/${rel}`] !== undefined && recorded[`${name}/${rel}`] !== fileHash(live);
			})
			.map(([rel]) => rel);
		const notes = skillNotes(name, changelog);
		if (edited.length) notes.push(`  you edited ${edited.join(", ")} — replacing overwrites your version`);
		for (const [rel] of pending) {
			const live = join(to, rel);
			const shippedText = readFileSync(join(PACKAGE_ROOT, "templates/skills", name, rel), "utf8");
			notes.push(`  ${rel}:`, ...shortDiff(existsSync(live) ? readFileSync(live, "utf8") : "", shippedText));
		}
		if (ask === null) {
			console.log(`neurastream adapter install omp: skill ${name} changed in this release; kept yours (not interactive)`);
			console.log(notes.join("\n"));
			out.skipped.push(to);
			continue;
		}
		const answer = ask(`${notes.join("\n")}\n  update this skill? [y/N] `).trim().toLowerCase();
		if (answer !== "y" && answer !== "yes") {
			out.skipped.push(to);
			continue;
		}
		for (const rel of files.keys()) {
			const live = join(to, rel);
			mkdirSync(dirname(live), { recursive: true });
			copyFileSync(join(PACKAGE_ROOT, "templates/skills", name, rel), live);
		}
		// A file an earlier install put there and this release no longer ships goes; the owner's own
		// extra files stay.
		for (const key of Object.keys(recorded)) {
			if (!key.startsWith(`${name}/`) || files.has(key.slice(name.length + 1))) continue;
			try {
				unlinkSync(join(to, key.slice(name.length + 1)));
			} catch {}
		}
		record();
		out.placed.push(to);
	}
	writeFileSync(stateFile, `${JSON.stringify({ files: next }, null, 2)}\n`);
	return out;
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

// Strips the managed block an older install wrote into the owner's AGENTS.md: Main gets the rules
// in its system prompt now. Bytes outside the markers stay; a file the strip leaves empty is removed.
// A malformed block is left alone; doctor reports it.
function removeAgentsMd(home: string): "removed" | "unchanged" {
	const file = liveAgentsMd(home);
	if (!existsSync(file)) return "unchanged";
	const { text, state } = stripBlock(readFileSync(file, "utf8"));
	if (state !== "ok") return "unchanged";
	if (text === "") unlinkSync(file);
	else writeFileSync(file, text);
	return "removed";
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
export function installOmp(home: string, ask: ((question: string) => string) | null = null): InstallResult {
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
	const agentsMd = removeAgentsMd(home);
	const skills = syncSkills(home, ask);
	return {
		plugin,
		removedStaleLink,
		pinsCopied: pins.copied,
		pinsKept: pins.kept,
		skillsCopied: skills.copied,
		skillsKept: skills.kept,
		skillsPlaced: skills.placed,
		skillsSkipped: skills.skipped,
		overlay,
		agentsMd,
	};
}

export function printInstall(result: InstallResult): void {
	console.log(`neurastream adapter install omp: plugin ${result.plugin}`);
	if (result.removedStaleLink) console.log(`neurastream adapter install omp: removed stale extension link ${result.removedStaleLink}`);
	console.log(
		`neurastream adapter install omp: pins copied ${result.pinsCopied.length}, kept ${result.pinsKept.length}; overlay ${result.overlay}`,
	);
	console.log(
		`neurastream adapter install omp: skills copied ${result.skillsCopied.length}, kept ${result.skillsKept.length}` +
			`${result.skillsPlaced.length ? `, updated ${result.skillsPlaced.length}` : ""}${result.skillsSkipped.length ? `, left as yours ${result.skillsSkipped.length}` : ""}`,
	);
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
		// P7: the update question needs a terminal; without one the install never overwrites a skill.
		const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
		const ask = interactive
			? (question: string): string => {
					process.stdout.write(question);
					const buf = Buffer.alloc(4096);
					const n = readSync(0, buf, 0, buf.length, null);
					return buf.toString("utf8", 0, n);
				}
			: null;
		printInstall(installOmp(homedir(), ask));
		return 0;
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		return 1;
	}
}
