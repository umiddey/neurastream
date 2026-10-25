// The inverse of init and adapter install. Pure core: it builds the exact removal list,
// prints it, and only removes with --yes. It never touches a file that is not provably
// this package's (a launcher symlink or copy into an installed copy, a template-identical
// pin, the managed AGENTS.md block, the adapter's plugin link), and it refuses every path that
// resolves outside the HOME it is given.

import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripBlock } from "./agents-md.ts";
import { configFile, loadConfig, type Config } from "./config.ts";
import { printText } from "./help.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "../..");

interface PackageJson {
	name?: string;
	bin?: Record<string, string>;
}

export interface UninstallTarget {
	path: string;
	what: string;
	/** AGENTS.md targets lose only the managed block; everything else is unlinked. */
	strip?: boolean;
	/** Directory trees (queue/, notes/, blockers/) come down recursively. */
	tree?: boolean;
}

export interface UninstallPlan {
	targets: UninstallTarget[];
	/** Present but left alone: pins the owner edited, files that are not ours. */
	kept: string[];
	refusals: string[];
}

function pkgName(): string {
	const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as PackageJson;
	if (!pkg.name) throw new Error("package.json has no name");
	return pkg.name;
}

/** The installed copy a path belongs to: the nearest dir whose package.json carries this package's name. */
function installedRootOf(file: string): string | null {
	// `file` itself may be the root (the plugin link's realpath is an installed root).
	let dir = file;
	for (let i = 0; i < 9; i++) {
		const manifest = join(dir, "package.json");
		if (existsSync(manifest)) {
			try {
				const pkg = JSON.parse(readFileSync(manifest, "utf8")) as PackageJson;
				if (pkg.name === pkgName()) return dir;
			} catch {
				return null;
			}
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

/** A launcher is a symlink into an installed copy of this package at the same relative path; a copy is byte-identical. */
function ours(live: string, rel: string): boolean {
	let st;
	try {
		st = lstatSync(live);
	} catch {
		return false;
	}
	if (st.isSymbolicLink()) {
		let target: string;
		try {
			target = realpathSync(live);
		} catch {
			return false;
		}
		const root = installedRootOf(target);
		return root !== null && target === resolve(root, rel);
	}
	if (!st.isFile()) return false;
	try {
		return readFileSync(live).equals(readFileSync(join(PACKAGE_ROOT, rel)));
	} catch {
		return false;
	}
}

function bins(cfg: Config, out: UninstallTarget[]): void {
	const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as PackageJson;
	const dirs = [join(cfg.paths.home, ".local/bin"), join(cfg.paths.home, ".bun/bin")];
	for (const name of Object.keys(manifest.bin ?? {})) {
		for (const dir of dirs) {
			const live = join(dir, name);
			if (existsSync(live) && ours(live, manifest.bin![name]!)) {
				out.push({ path: live, what: `bin ${name}` });
			}
		}
	}
}

/** A skill dir is ours only when every file in it matches the shipped copy; any file the owner added keeps it. */
function sameTree(live: string, shipped: string): boolean {
	if (!lstatSync(live).isDirectory()) return false;
	const names = readdirSync(live).sort();
	if (names.join("\0") !== readdirSync(shipped).sort().join("\0")) return false;
	return names.every((name) => {
		const a = join(live, name);
		const b = join(shipped, name);
		if (lstatSync(a).isDirectory()) return lstatSync(b).isDirectory() && sameTree(a, b);
		return lstatSync(a).isFile() && readFileSync(a).equals(readFileSync(b));
	});
}

function adapterSurface(cfg: Config, out: UninstallTarget[], kept: string[]): void {
	const adapter = cfg.adapter;
	if (!adapter) return;
	// The overlay is written by adapter install: sessions/pins/extensions all sit under the
	// agent dir, the plugin link one level above it under plugins/node_modules/<package>.
	const agentDir = dirname(dirname(adapter.extensions));
	const plugin = join(agentDir, "plugins/node_modules/neurastream");
	if (existsSync(plugin) && ours(plugin, ".")) out.push({ path: plugin, what: "plugin link" });

	const pinsDir = adapter.pins;
	if (existsSync(pinsDir)) {
		const shipped = join(PACKAGE_ROOT, "templates/agents");
		for (const name of readdirSync(pinsDir).sort()) {
			if (!name.endsWith(".md") || name.includes(".bak")) continue;
			const live = join(pinsDir, name);
			const template = join(shipped, name);
			if (existsSync(template) && ours(live, join("templates/agents", name))) {
				out.push({ path: live, what: `template-identical pin ${name}` });
			} else {
				kept.push(`${live} (pin differs from the shipped template; kept)`);
			}
		}
	}

	const skillsDir = join(cfg.paths.home, ".agents/skills");
	const shippedSkills = join(PACKAGE_ROOT, "templates/skills");
	if (existsSync(shippedSkills)) {
		for (const name of readdirSync(shippedSkills).sort()) {
			const live = join(skillsDir, name);
			if (!existsSync(live)) continue;
			if (sameTree(live, join(shippedSkills, name))) out.push({ path: live, what: `template-identical skill ${name}` });
			else kept.push(`${live} (skill differs from the shipped copy; kept)`);
		}
	}

	const agentsMd = join(dirname(adapter.sessions), "AGENTS.md");
	if (existsSync(agentsMd)) {
		const probe = stripBlock(readFileSync(agentsMd, "utf8"));
		if (probe.state === "stale") kept.push(`${agentsMd} (block markers malformed; left alone)`);
		else if (probe.state === "ok") out.push({ path: agentsMd, what: "managed AGENTS.md block (personal text kept)", strip: true });
	}
}

function purgeState(cfg: Config, out: UninstallTarget[]): void {
	const entries: [string, string, boolean][] = [
		[configFile(cfg.paths.home), "--purge: config file", false],
		[cfg.paths.queue_index, "--purge: index", false],
		[join(cfg.paths.agent_dir, "queue"), "--purge: queue dir", true],
		[cfg.paths.notes, "--purge: notes dir", true],
		[cfg.paths.blockers, "--purge: blockers dir", true],
		[cfg.paths.cancelled, "--purge: cancelled list", false],
		[cfg.paths.unlock, "--purge: guard unlock", false],
	];
	for (const [path, what, tree] of entries) {
		if (existsSync(path) || lstatSafe(path)) out.push({ path, what, tree });
	}
}

function lstatSafe(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
}

export function uninstallPlan(cfg: Config, purge: boolean): UninstallPlan {
	const targets: UninstallTarget[] = [];
	const kept: string[] = [];
	bins(cfg, targets);
	adapterSurface(cfg, targets, kept);
	if (purge) purgeState(cfg, targets);
	const home = resolve(cfg.paths.home);
	const refusals = targets.filter(t => {
		const rel = relative(home, resolve(t.path));
		return rel === "" || rel.startsWith("..") || isAbsolute(rel);
	}).map(t => `${t.path} (${t.what}) is outside ${home}`);
	return { targets, kept, refusals };
}

export function applyUninstall(cfg: Config, plan: UninstallPlan): void {
	for (const target of plan.targets) {
		if (target.strip) {
			// Re-read at apply time: strip only when the markers are still well-formed.
			const next = stripBlock(readFileSync(target.path, "utf8"));
			if (next.state === "ok") {
				if (next.text === "") rmSync(target.path, { force: true });
				else writeFileSync(target.path, next.text);
			}
			continue;
		}
		const st = lstatSync(target.path);
		if (st.isSymbolicLink()) unlinkSync(target.path);
		else if (st.isDirectory()) rmSync(target.path, { recursive: true });
		else unlinkSync(target.path);
	}
}

function usage(): string {
	return "usage: neurastream uninstall [--purge] [--yes]";
}

export function runUninstall(args: string[]): number {
	for (const arg of args) {
		if (arg !== "--purge" && arg !== "--yes") {
			printText(`unknown flag ${arg}\n${usage()}`);
			return 2;
		}
	}
	const purge = args.includes("--purge");
	const yes = args.includes("--yes");
	const cfg = loadConfig({ home: homedir() });
	const plan = uninstallPlan(cfg, purge);
	if (plan.refusals.length) {
		for (const line of plan.refusals) printText(`refused: ${line}`);
		printText("nothing removed");
		return 1;
	}
	if (plan.targets.length === 0) {
		printText("nothing to uninstall under this HOME");
		for (const line of plan.kept) printText(`kept: ${line}`);
		return 0;
	}
	printText(yes ? "removing:" : "would remove:");
	for (const target of plan.targets) printText(`  ${target.path}  (${target.what})`);
	for (const line of plan.kept) printText(`kept: ${line}`);
	if (!yes) {
		printText("dry run: re-run with --yes to remove these");
		return 1;
	}
	applyUninstall(cfg, plan);
	printText(`uninstalled ${plan.targets.length} target${plan.targets.length === 1 ? "" : "s"}${purge ? " (purged)" : ""}`);
	return 0;
}
