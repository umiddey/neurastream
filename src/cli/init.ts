// `neurastream init`: one-time layout under the caller's HOME. A second run creates nothing
// and rewrites nothing (docs/config.md). Paths come from the loaded config, not literals in core.

import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, readSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { configFile, loadConfig, TEMPLATE_PATH, type Config } from "../core/config.ts";
import { allowedAgents } from "../core/queue/lib.ts";
import { allowAgents, invalidSlugs, InvalidSlugError } from "../core/subagents.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = resolve(HERE, "../..");

const BLOCKERS: { name: string; fn: string }[] = [
	{ name: "deny-command", fn: "denyCommand" },
	{ name: "deny-path", fn: "denyPath" },
	{ name: "deny-text", fn: "denyText" },
	{ name: "no-push", fn: "noPush" },
];

export interface InitResult {
	created: string[];
	unchanged: string[];
	allowed: string[];
}

function tilde(home: string, p: string): string {
	const abs = resolve(p);
	if (abs === home) return "~";
	if (abs.startsWith(`${home}/`)) return `~/${abs.slice(home.length + 1)}`;
	return abs;
}

function yamlQuote(value: string): string {
	return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function packageBinNames(): string[] {
	const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as { bin?: Record<string, string> };
	return Object.keys(pkg.bin ?? {});
}

/** Installed compatibility bins under this home, as config paths (`~` when under home). */
export function installedBins(home: string, invoked: string): string[] {
	const names = packageBinNames();
	const dirs = [dirname(resolve(invoked || ".")), join(home, ".bun", "bin")];
	const out: string[] = [];
	for (const dir of dirs) {
		for (const name of names) {
			const p = join(dir, name);
			if (existsSync(p)) out.push(tilde(home, p));
		}
	}
	return [...new Set(out)];
}

// The path keys that sit under the agent dir (same derivation as the queue library's agentDir()).
const AGENT_DIR_KEYS = /^(  (?:agent_dir|queue_index|blockers|notes|ranking_board|subagents|cancelled|unlock): )"~\/\.config\/neurastream/gm;

function configText(home: string, invoked: string, agentDir?: string): string {
	let text = readFileSync(TEMPLATE_PATH, "utf8");
	if (!text.endsWith("\n")) text += "\n";
	// An existing machine keeps its index, notes, blockers and unlock where they are today.
	const agent = agentDir ? tilde(home, resolve(home, agentDir.replace(/^~(?=\/|$)/, home))) : "~/.config/neurastream";
	if (agentDir) {
		const hits = text.match(AGENT_DIR_KEYS)?.length ?? 0;
		if (hits !== 8) throw new Error(`templates/config.yml: expected 8 agent-dir path keys, found ${hits}`);
		text = text.replace(AGENT_DIR_KEYS, (_m, key: string) => `${key}${yamlQuote(agent).slice(0, -1)}`);
	}
	const protectedPaths = [...installedBins(home, invoked), `${agent}/notes/`, `${agent}/blockers/`, `${agent}/queue/`];
	const items = protectedPaths.map(p => `    - ${yamlQuote(p)}`);
	const placeholder = /^  protected: \[\](.*)$/m;
	if (!placeholder.test(text)) throw new Error("templates/config.yml has no protected placeholder");
	// The placeholder's trailing comment stays on the `protected:` header line.
	return text.replace(placeholder, (_m, comment: string) => ["  protected:" + comment, ...items].join("\n"));
}

function putFile(dest: string, body: string, mode: number, created: string[], unchanged: string[]): void {
	if (existsSync(dest)) {
		unchanged.push(dest);
		return;
	}
	mkdirSync(dirname(dest), { recursive: true });
	writeFileSync(dest, body, { mode });
	chmodSync(dest, mode);
	created.push(dest);
}

function putDir(dir: string): void {
	mkdirSync(dir, { recursive: true });
}

function blockerWrapper(fn: string): string {
	const from = join(PACKAGE_ROOT, "src/core/blockers.ts");
	return `#!/usr/bin/env bun\nimport { ${fn}, runBlockerScript } from ${JSON.stringify(from)};\n\nrunBlockerScript(${fn});\n`;
}

function note(name: string): string {
	return readFileSync(join(PACKAGE_ROOT, "templates/notes", name), "utf8");
}

const RANKING_STUB = `# Subagent ranking board

Empty until \`agent-score board\` writes this file. Do not hand-edit after that.
`;

/** Create the layout. Existing files are left byte-for-byte alone. */
export function initHome(home: string, opts: { invoked?: string; env?: NodeJS.ProcessEnv; agentDir?: string; allow?: string[]; ask?: () => string } = {}): InitResult {
	const created: string[] = [];
	const unchanged: string[] = [];
	const invoked = opts.invoked ?? "";
	// The allow-list is settled before anything is written, so a bad slug leaves no trace.
	const slugs = opts.allow ?? (opts.ask ? opts.ask().split(",").map(s => s.trim()).filter(s => s !== "") : undefined);
	const bad = invalidSlugs(slugs ?? []);
	if (bad.length) throw new InvalidSlugError(`invalid slug: ${bad.join(", ")} (use a-z, 0-9 and -)`);
	const cfgPath = configFile(home);
	putFile(cfgPath, configText(home, invoked, opts.agentDir), 0o644, created, unchanged);

	const cfg: Config = loadConfig({ home, env: opts.env ?? {} });
	putDir(cfg.paths.config_dir);
	putDir(cfg.paths.agent_dir);
	putDir(cfg.paths.notes);
	putDir(cfg.paths.blockers);
	putDir(dirname(cfg.paths.queue_index));
	putDir(cfg.paths.score_state);
	putDir(cfg.paths.queue_state);
	putDir(dirname(cfg.paths.guard_log));
	putDir(dirname(cfg.paths.plan_guard_log));
	putDir(cfg.paths.alert_state);
	putDir(dirname(cfg.paths.snapshot_lock));
	for (const root of cfg.paths.work_roots) putDir(root);
	putDir(join(cfg.paths.agent_dir, "queue"));

	putFile(cfg.paths.queue_index, "", 0o644, created, unchanged);
	putFile(cfg.paths.subagents, note("subagents.md"), 0o644, created, unchanged);
	putFile(join(cfg.paths.notes, "lessons.md"), note("lessons.md"), 0o644, created, unchanged);
	putFile(cfg.paths.ranking_board, RANKING_STUB, 0o644, created, unchanged);
	// An adopted agent dir (--agent-dir) keeps queue/ for the harness adapter, which links its own
	// queue/lib.ts and queue/TEMPLATE.md there; two writers for one slot would collide.
	if (!opts.agentDir) {
		const queueText = readFileSync(join(PACKAGE_ROOT, "templates/queue/TEMPLATE.md"), "utf8");
		if (!queueText.includes("{{HOME}}")) throw new Error("templates/queue/TEMPLATE.md has no {{HOME}} placeholder");
		putFile(join(cfg.paths.agent_dir, "queue", "TEMPLATE.md"), queueText.replaceAll("{{HOME}}", home), 0o644, created, unchanged);
	}
	for (const b of BLOCKERS) {
		putFile(join(cfg.paths.blockers, b.name), blockerWrapper(b.fn), 0o755, created, unchanged);
	}
	if (slugs?.length) allowAgents(cfg.paths.subagents, slugs);
	return { created, unchanged, allowed: [...allowedAgents(cfg.paths.subagents)] };
}

export function printInit(result: InitResult): void {
	if (result.created.length === 0) {
		console.log("neurastream init: unchanged");
	} else {
		console.log("neurastream init: created");
		for (const p of result.created) console.log(`  ${p}`);
		if (result.unchanged.length) console.log(`neurastream init: left ${result.unchanged.length} existing file(s) alone`);
	}
	if (result.allowed.length === 0) console.log("no subagents allowed yet: neurastream agents allow <name>");
}

/** One line from stdin, read synchronously; a terminal hands over a line at a time. */
export function askLine(prompt: string): string {
	process.stdout.write(prompt);
	const buf = Buffer.alloc(4096);
	const n = readSync(0, buf, 0, buf.length, null);
	return buf.toString("utf8", 0, n).split(/\r?\n/)[0] ?? "";
}

export function runInit(args: string[] = []): number {
	try {
		const i = args.indexOf("--agent-dir");
		const agentDir = i >= 0 ? args[i + 1] : undefined;
		const a = args.indexOf("--allow");
		const allowArg = a >= 0 ? args[a + 1] : undefined;
		if ((i >= 0 && !agentDir) || (a >= 0 && allowArg === undefined)) {
			throw new Error("usage: neurastream init [--agent-dir <dir>] [--allow a,b]");
		}
		const allow = allowArg?.split(",").map(s => s.trim()).filter(s => s !== "");
		const interactive = allow === undefined && Boolean(process.stdin.isTTY && process.stdout.isTTY);
		const ask = interactive ? () => askLine("Subagents allowed to spawn (comma-separated names, empty = none): ") : undefined;
		printInit(initHome(homedir(), { invoked: process.argv[1] ?? "", env: process.env, agentDir, allow, ask }));
		return 0;
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		return err instanceof InvalidSlugError ? 2 : 1;
	}
}

/** Content hash of a tree. Directory entries count; mtimes do not. A no-op init keeps this stable. */
export function treeHash(root: string): string {
	const lines: string[] = [];
	function walk(dir: string): void {
		let names: string[] = [];
		try {
			names = readdirSync(dir).sort();
		} catch {
			return;
		}
		for (const name of names) {
			const p = join(dir, name);
			const rel = relative(root, p);
			const st = lstatSync(p);
			if (st.isSymbolicLink()) {
				lines.push(`link ${rel} -> ${readlinkSync(p)}`);
			} else if (st.isDirectory()) {
				lines.push(`dir ${rel}/`);
				walk(p);
			} else if (st.isFile()) {
				lines.push(`file ${rel} ${createHash("sha256").update(readFileSync(p)).digest("hex")}`);
			}
		}
	}
	walk(root);
	return createHash("sha256").update(lines.join("\n")).digest("hex");
}
