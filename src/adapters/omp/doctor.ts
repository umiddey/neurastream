// Reports hand-edited or foreign live files the omp adapter installs, and a stale
// registry version. Offline `npm view` is a warning, not a failure.
// Notes, INDEX, queue state and config are user state: not checked.

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export interface LiveFile {
	live: string;
	source: string;
}

interface PackageJson {
	name?: string;
	version?: string;
	bin?: Record<string, string>;
}

function readPackage(root: string): PackageJson {
	return JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as PackageJson;
}

export function packageBins(root: string): { name: string; source: string }[] {
	const pkg = readPackage(root);
	return Object.entries(pkg.bin ?? {}).map(([name, rel]) => ({ name, source: join(root, rel) }));
}

/** Files adapter install places under this home. Bun's global bin dir is extra, checked only when a name is present. */
export function adapterLiveFiles(home: string, root: string = PACKAGE_ROOT): LiveFile[] {
	const files: LiveFile[] = [];
	for (const bin of packageBins(root)) {
		files.push({ live: join(home, ".local/bin", bin.name), source: bin.source });
	}
	files.push({
		live: join(home, ".omp/agent/extensions/neurastream.ts"),
		source: join(root, "src/adapters/omp/index.ts"),
	});
	files.push({
		live: join(home, ".omp/agent/queue/lib.ts"),
		source: join(root, "src/core/queue/lib.ts"),
	});
	files.push({
		live: join(home, ".omp/agent/queue/TEMPLATE.md"),
		source: join(root, "templates/queue/TEMPLATE.md"),
	});
	const agents = join(root, "templates/agents");
	for (const name of readdirSync(agents).sort()) {
		if (!name.endsWith(".md") || name.includes(".bak")) continue;
		files.push({ live: join(home, ".omp/agent/agents", name), source: join(agents, name) });
	}
	return files;
}

function bunLiveFiles(home: string, root: string): LiveFile[] {
	const dir = join(home, ".bun/bin");
	if (!existsSync(dir)) return [];
	const files: LiveFile[] = [];
	for (const bin of packageBins(root)) {
		const live = join(dir, bin.name);
		if (existsSync(live)) files.push({ live, source: bin.source });
	}
	return files;
}

function packageRootOf(file: string): string | null {
	let dir = dirname(file);
	for (let i = 0; i < 8; i++) {
		const manifest = join(dir, "package.json");
		if (existsSync(manifest)) {
			try {
				const pkg = JSON.parse(readFileSync(manifest, "utf8")) as PackageJson;
				if (pkg.name === readPackage(PACKAGE_ROOT).name) return dir;
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

function sameBytes(a: string, b: string): boolean {
	try {
		return readFileSync(a).equals(readFileSync(b));
	} catch {
		return false;
	}
}

/** A launcher is a symlink into an installed copy of this package, at the same relative path. A copy is byte-identical. */
export function isPackageFile(live: string, source: string): boolean {
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
		const root = packageRootOf(target);
		if (!root) return false;
		const rel = relative(PACKAGE_ROOT, source);
		return target === resolve(root, rel);
	}
	if (!st.isFile()) return false;
	return sameBytes(live, source);
}

export interface DoctorReport {
	ok: string[];
	problems: string[];
	warnings: string[];
	installed: string;
	registry: string | null;
}

function npmViewVersion(name: string, env: NodeJS.ProcessEnv): { version: string } | { warning: string } {
	const r = spawnSync("npm", ["view", name, "version"], { encoding: "utf8", env, timeout: 8000 });
	if (r.error || r.status !== 0) {
		const why = r.error ? r.error.message : `exit ${r.status ?? "signal"}`;
		return { warning: `offline: npm view ${name} version failed (${why})` };
	}
	const version = (r.stdout ?? "").trim().split("\n").filter(Boolean).at(-1) ?? "";
	if (!version) return { warning: `offline: npm view ${name} version returned nothing` };
	return { version };
}

export function doctorReport(home: string, env: NodeJS.ProcessEnv = process.env): DoctorReport {
	const pkg = readPackage(PACKAGE_ROOT);
	const name = pkg.name ?? "neurastream";
	const installed = pkg.version ?? "";
	const problems: string[] = [];
	const ok: string[] = [];
	const seen = new Set<string>();
	for (const file of [...adapterLiveFiles(home), ...bunLiveFiles(home, PACKAGE_ROOT)]) {
		if (seen.has(file.live)) continue;
		seen.add(file.live);
		if (!existsSync(file.live)) {
			problems.push(`foreign: ${file.live}`);
			continue;
		}
		if (isPackageFile(file.live, file.source)) {
			ok.push(file.live);
			continue;
		}
		problems.push(`hand-edited: ${file.live}`);
	}
	const warnings: string[] = [];
	const viewed = npmViewVersion(name, env);
	let registry: string | null = null;
	if ("warning" in viewed) warnings.push(viewed.warning);
	else {
		registry = viewed.version;
		if (registry !== installed) problems.push(`stale version: installed ${installed}, registry ${registry}`);
	}
	return { ok, problems, warnings, installed, registry };
}

export function formatDoctor(report: DoctorReport): string {
	const lines: string[] = [];
	if (report.problems.length === 0) lines.push("neurastream doctor: ok");
	else lines.push(`neurastream doctor: ${report.problems.length} problem(s)`);
	for (const p of report.problems) lines.push(p);
	lines.push(`installed ${report.installed}`);
	if (report.registry !== null) lines.push(`registry ${report.registry}`);
	for (const w of report.warnings) lines.push(`warning: ${w}`);
	return lines.join("\n");
}

export function runDoctor(): number {
	const report = doctorReport(homedir());
	console.log(formatDoctor(report));
	return report.problems.length === 0 ? 0 : 1;
}
