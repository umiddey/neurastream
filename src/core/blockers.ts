// Plan blockers, ported from the original blocker scripts (shared contract + deny-command,
// deny-path, deny-text, no-push). Executable wrappers live in blockers/<name>; they read one
// JSON call on stdin and exit 2 with one stderr line to refuse (same contract as before).
//
// Contract (called by the guard for every subagent call that touches an open plan's repo,
// worktrees or "## Applies to" paths):
//   argv      the arguments written after the blocker name in the plan's "## Blockers" line
//   stdin     JSON {tool, input, cwd, agent: "main"|"sub", repo, plan, paths: [absolute paths]}
//   exit 0    allow;  exit 2 + one line on stderr = refuse the call with that reason.

import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { expandHome } from "./queue/lib.ts";

export interface BlockerCall {
	tool: string;
	input: Record<string, unknown>;
	cwd: string;
	agent: string;
	repo: string;
	plan: string;
	paths: string[];
}

export interface BlockerEnv {
	call: BlockerCall;
	args: string[];
	shell: boolean;
	writes: boolean;
	command: string;
}

/** A refusal: the wrapper prints `<script name>: <reason>` on stderr and exits 2. */
export class BlockerRefusal extends Error {}

function block(reason: string): never {
	throw new BlockerRefusal(reason);
}

function isDir(p: string): boolean {
	try {
		return statSync(p).isDirectory();
	} catch {
		return false;
	}
}

// Shell/eval text that changes files (the blocker-scoped pattern, smaller than the guard's).
const MUTATING =
	/(\brm\b|\bmv\b|\bcp\b|\btruncate\b|\bsed\s+-i|\btee\b|>{1,2}\s*\S|\bgit\s+(rm|mv|checkout|restore)\b|writeFile|Bun\.write|unlink|\bpatch\b)/;

function blockerEnv(call: BlockerCall, args: string[]): BlockerEnv {
	const shell = call.tool === "bash" || call.tool === "eval";
	const writes = call.tool === "write" || call.tool === "edit" || call.tool === "ast_edit";
	const command = shell ? String(call.input?.command || call.input?.code || "") : "";
	return { call, args, shell, writes, command };
}

export function runBlockerScript(check: (env: BlockerEnv) => void): void {
	const name = path.basename(process.argv[1] ?? "blocker");
	let call: BlockerCall;
	try {
		call = JSON.parse(readFileSync(0, "utf8")) as BlockerCall;
	} catch {
		console.error(`${name}: stdin is not one JSON call`);
		process.exit(2);
	}
	const env = blockerEnv(call, process.argv.slice(2));
	try {
		check(env);
	} catch (err) {
		if (err instanceof BlockerRefusal) {
			console.error(`${name}: ${err.message}`);
			process.exit(2);
		}
		throw err;
	}
}

// Repo/worktree root owning a path: walks up to the nearest .git (worktrees included via their
// .git file mapping back, same as the guard's gitTop but existence-based, as the original).
function gitRoot(p: string): string | null {
	let d = isDir(p) ? p : path.dirname(p);
	for (;;) {
		try {
			statSync(path.join(d, ".git"));
			return d;
		} catch {}
		const up = path.dirname(d);
		if (up === d) return null;
		d = up;
	}
}

// Path relative to the call's repo root; absolute when outside it.
function rel(p: string, call: BlockerCall): string {
	const root = gitRoot(p) ?? (call.repo || "/");
	const r = path.relative(root, p);
	return r.startsWith("..") ? p : r;
}

// Python fnmatch semantics: * and ? cross "/" too; [seq] classes; case-sensitive on POSIX.
function fnmatchToRegExp(glob: string): RegExp {
	let out = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i]!;
		if (c === "*") {
			out += "[\\s\\S]*";
		} else if (c === "?") {
			out += "[\\s\\S]";
		} else if (c === "[") {
			let j = i + 1;
			if (glob[j] === "!" || glob[j] === "^") j++;
			if (glob[j] === "]") j++;
			while (j < glob.length && glob[j] !== "]") j++;
			if (j >= glob.length) {
				out += "\\[";
			} else {
				const raw = glob.slice(i + 1, j);
				out += `[${raw.startsWith("!") ? `^${raw.slice(1)}` : raw}]`;
				i = j;
			}
		} else {
			out += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		}
	}
	return new RegExp(`^${out}$`);
}

// A glob matches a path: absolute globs against the path itself, relative ones against the
// repo-relative form, matching the glob's directory and everything under it.
function matchesPath(p: string, glob: string, call: BlockerCall): boolean {
	if (glob.startsWith("/") || glob.startsWith("~")) return fnmatchToRegExp(expandHome(glob)).test(p);
	const r = rel(p, call);
	const bare = glob.replace(/\/+$/, "");
	return fnmatchToRegExp(glob).test(r) || fnmatchToRegExp(`${bare}/*`).test(r) || r === bare;
}

// Absolute forms of every word in a shell command, resolved against the call's cwd.
function shellPaths(env: BlockerEnv): string[] {
	if (!env.shell) return [];
	const raw = env.call.input?.cwd || env.call.cwd || "/";
	const base = expandHome(String(raw));
	const out: string[] = [];
	for (const w of env.command.split(/[\s;&|<>()'"]+/)) {
		const t = w.trim();
		if (t && !t.startsWith("-")) out.push(path.normalize(path.join(base, expandHome(t))));
	}
	return out;
}

// The text a call would write: write content, the added lines of an edit, the whole input of an
// ast_edit, and the command itself for shell/eval.
function writtenText(env: BlockerEnv): string {
	if (env.call.tool === "write") return String(env.call.input?.content || "");
	if (env.call.tool === "edit") {
		return String(env.call.input?.input || "")
			.split("\n")
			.filter(l => l.startsWith("+"))
			.map(l => l.slice(1))
			.join("\n");
	}
	if (env.call.tool === "ast_edit") return JSON.stringify(env.call.input ?? {});
	return env.command;
}

/** deny-command <regex>...: refuse shell/eval commands matching any regex (use \s for spaces). */
export function denyCommand(env: BlockerEnv): void {
	if (!env.args.length) block("deny-command needs at least one regex in the plan");
	if (env.shell) {
		for (const rx of env.args) {
			if (new RegExp(rx).test(env.command)) block(`command matches forbidden pattern /${rx}/ (plan Forbidden list)`);
		}
	}
}

/** deny-path <glob>...: refuse any change to matching paths (write/edit/ast_edit targets, mutating shell commands naming them). */
export function denyPath(env: BlockerEnv): void {
	if (!env.args.length) block("deny-path needs at least one glob in the plan");
	if (env.writes || (env.shell && MUTATING.test(env.command))) {
		for (const p of [...(env.call.paths ?? []), ...shellPaths(env)]) {
			for (const g of env.args) {
				if (matchesPath(p, g, env.call)) block(`${p} is forbidden by the plan (deny-path ${g})`);
			}
		}
	}
}

/** deny-text <regex>...: refuse writes/edits (and shell commands) whose new text matches any regex. */
export function denyText(env: BlockerEnv): void {
	if (!env.args.length) block("deny-text needs at least one regex in the plan");
	if (env.writes || env.shell) {
		const text = writtenText(env);
		for (const rx of env.args) {
			if (new RegExp(rx).test(text)) block(`new text matches forbidden pattern /${rx}/ (plan Forbidden list)`);
		}
	}
}

/** no-push: subagents may never push (Main pushes and merges). */
export function noPush(env: BlockerEnv): void {
	if (
		env.shell &&
		env.call.agent !== "main" &&
		/\bgit\b[^;&|\n]*\bpush\b|\bglab\s+mr\s+merge\b|\bgh\s+pr\s+merge\b/.test(env.command)
	)
		block("subagents never push or merge; commit on the feature branch and report");
}
