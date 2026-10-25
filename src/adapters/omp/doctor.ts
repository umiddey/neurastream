// Reports hand-edited or missing live files the omp adapter installs, the managed block in
// the owner's AGENTS.md, and a stale registry version. Offline `npm view` is a warning, not a failure.
// Notes, queue state and config are user state: not checked. The one exception is the layout of the
// main index itself: repo-directory lines are the old two-level queue and get flagged until
// `neurastream queue migrate` folds them.

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { blockState, renderBlock } from "../../core/agents-md.ts";
import { loadConfig } from "../../core/config.ts";
import { notifyFindings } from "../../core/notify.ts";
import { loadKnownSecrets, proxyOnPath } from "../../core/secret-redact.ts";
import { readIndex } from "../../core/queue/lib.ts";
import { realTailscale, type Tailscale } from "../../core/tailscale.ts";

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

/** The omp agent's AGENTS.md, which carries the managed neurastream block. */
export function liveAgentsMd(home: string): string {
	return join(home, ".omp/agent/AGENTS.md");
}

/** Files adapter install places under this home. Bun's global bin dir is extra, checked only when a name is present. */
export function adapterLiveFiles(home: string, root: string = PACKAGE_ROOT): LiveFile[] {
	const files: LiveFile[] = [];
	for (const bin of packageBins(root)) {
		files.push({ live: join(home, ".local/bin", bin.name), source: bin.source });
	}
	// P9: the extension symlink is gone (ONE load route — the plugin below);
	// what the adapter installs under the agent dir is the omp plugin link,
	// whose realpath is an installed neurastream package root. `omp plugin
	// link` owns this file; install must never ensureLink it.
	files.push({
		live: join(home, ".omp/plugins/node_modules/neurastream"),
		source: root,
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
	// Skills are copied under ~/.agents/skills/<name>/ by adapter install (copySkills), never linked.
	// Only each shipped SKILL.md is listed: doctor reports a missing or edited skill the way it reports agents.
	const skills = join(root, "templates/skills");
	if (existsSync(skills)) {
		for (const name of readdirSync(skills).sort()) {
			if (!statSync(join(skills, name)).isDirectory()) continue;
			files.push({ live: join(home, ".agents/skills", name, "SKILL.md"), source: join(skills, name, "SKILL.md") });
		}
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
	// `file` itself may be the package root (the omp plugin link's realpath is
	// an installed neurastream root), so the self dir is checked first.
	let dir = file;
	for (let i = 0; i < 9; i++) {
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
	/** Legacy config keys loadConfig renamed or dropped; informational, not problems. */
	notices: string[];
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

export function doctorReport(home: string, env: NodeJS.ProcessEnv = process.env, tailscale: Tailscale = realTailscale): DoctorReport {
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
			problems.push(`missing: ${file.live}`);
			continue;
		}
		if (isPackageFile(file.live, file.source)) {
			ok.push(file.live);
			continue;
		}
		problems.push(`hand-edited: ${file.live}`);
	}
	const agents = liveAgentsMd(home);
	const text = existsSync(agents) ? readFileSync(agents, "utf8") : "";
	const cfg = loadConfig({ home, env });
	// The owner page (plan 20261024_2230): when it is switched on, the login must be set and
	// tailscale must answer, or the unit will start and refuse, or serve nobody.
	if (cfg.ui.enabled) {
		if (!cfg.ui.owner_login) problems.push("ui.enabled but ui.owner_login is empty");
		else if (tailscale.ip4() === null) problems.push("ui.enabled but tailscale does not answer (tailscale ip -4)");
		else ok.push(`ui owner page: login ${cfg.ui.owner_login}`);
	}
	// One index (20261024_1400_one_index): repo-directory lines in the main index are the old
	// two-level queue; the plans they hold are invisible to queue-check until migrate folds them.
	const idx = cfg.paths.queue_index;
	const repoDirs = existsSync(idx)
		? readIndex(idx).filter(l => {
				try {
					return statSync(l).isDirectory();
				} catch {
					return false;
				}
			})
		: [];
	if (repoDirs.length)
		problems.push(`${idx} still lists ${repoDirs.length} repo director${repoDirs.length === 1 ? "y" : "ies"} (${repoDirs.join(", ")}); run neurastream queue migrate`);
	const state = blockState(text, renderBlock(cfg));
	if (state === "ok") ok.push(`${agents} neurastream block`);
	else problems.push(`${state}: ${agents} neurastream block`);
	const warnings: string[] = [];
	const notify = notifyFindings(cfg);
	problems.push(...notify.problems);
	warnings.push(...notify.warnings);
	// Secrets (plan 20261025_2204): the redactor's state and the second net, count only — doctor
	// never prints a value. A missing proxy binary is a warning, never a problem: the launch path
	// falls back to a plain harness start.
	const known = loadKnownSecrets(cfg).length;
	const proxy = proxyOnPath();
	ok.push(`secrets: redactor ${cfg.secrets.redact ? "on" : "off"}, ${known} known value(s), secretgate ${proxy ? "installed" : "missing"}, proxy ${cfg.secrets.proxy}`);
	if (cfg.secrets.proxy === "secretgate" && !proxy) {
		warnings.push("secrets.proxy is secretgate but secretgate is not on PATH; the harness starts without the proxy (README: Secrets)");
	}
	const viewed = npmViewVersion(name, env);
	let registry: string | null = null;
	if ("warning" in viewed) warnings.push(viewed.warning);
	else {
		registry = viewed.version;
		if (registry !== installed) problems.push(`stale version: installed ${installed}, registry ${registry}`);
	}
	return { ok, problems, warnings, installed, registry, notices: cfg.notices };
}

export function formatDoctor(report: DoctorReport): string {
	const lines: string[] = [];
	if (report.problems.length === 0) lines.push("neurastream doctor: ok");
	else lines.push(`neurastream doctor: ${report.problems.length} problem(s)`);
	for (const p of report.problems) lines.push(p);
	for (const n of report.notices) lines.push(`notice: ${n}`);
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
