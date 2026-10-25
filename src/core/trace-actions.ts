// Suspicious tool actions (plan 20261024_0301 P1): flags the trace activity an owner reads as
// hostile — reads of secret paths, network commands to hosts outside the allow list, writes
// outside the plan worktree roots or onto deny paths, and shells fed from a pipe. Every list
// comes from config (`traces.*`, plus the guard shell/write tool names), so owners tune the
// rules without touching code. Evidence is masked and capped by the shared claim masker, so a
// finding line can never carry a secret value into the CLI, a log or the incident store.

import type { TraceEvent } from "./adapter.ts";
import type { Config } from "./config.ts";
import { maskEvidence } from "./trace-claims.ts";

export type ActionSeverity = "high" | "medium" | "low";

export type ActionRule = "secret-read" | "net-unknown-host" | "write-out-of-scope" | "pipe-to-shell";

export interface ActionsRules {
	home: string;
	secret_globs: string[];
	net_tools: string[];
	allowed_hosts: string[];
	/** Prefixes a run may write (plan `Worktree:` roots); empty falls back to paths.work_roots; both empty = the scope check is off. */
	write_roots: string[];
	deny_globs: string[];
	/** Substrings that mean a shell is fed from a pipe. */
	shell_patterns: string[];
	shell_tools: string[];
	write_tools: string[];
}

export interface SuspiciousAction {
	rule: ActionRule;
	severity: ActionSeverity;
	runId: string;
	ts: number | null;
	tool: string;
	/** Short human sentence; safe for an incident summary. */
	summary: string;
	/** Masked and capped command/args text. */
	evidence: string;
	/** Host (net), matched path (secret/write) or shell pattern (pipe); fingerprint material. */
	target: string;
}

/** Maps config onto the rule set: the `traces.*` lists plus the guard shell/write tool names. */
export function actionsRules(cfg: Config): ActionsRules {
	const write_roots = cfg.traces.actions.write_roots.length > 0 ? cfg.traces.actions.write_roots : cfg.paths.work_roots;
	return {
		home: cfg.paths.home,
		secret_globs: cfg.traces.actions.secret_globs,
		net_tools: cfg.traces.actions.net_tools,
		allowed_hosts: cfg.traces.allowed_hosts,
		write_roots,
		deny_globs: cfg.traces.actions.deny_globs,
		shell_patterns: cfg.traces.actions.shell_patterns,
		shell_tools: cfg.guards.shell_tools,
		write_tools: cfg.guards.write_tools,
	};
}

/**
 * Glob match for the config path lists: a double star followed by a slash is any directory
 * prefix (including none), a bare double star is anything, a star is anything but a slash
 * with leading dots included, a question mark is one non-slash. A leading tilde or `$HOME`
 * on either side expands to the configured home.
 */
export function globMatch(pattern: string, candidate: string, home: string): boolean {
	const expand = (p: string): string => {
		if (p === "~" || p === "$HOME") return home;
		if (p.startsWith("~/")) return home + p.slice(1);
		if (p.startsWith("$HOME/")) return home + p.slice(5);
		return p;
	};
	const pat = expand(pattern);
	let re = "";
	for (let i = 0; i < pat.length; i++) {
		const c = pat[i]!;
		if (c === "*") {
			if (pat[i + 1] === "*") {
				if (pat[i + 2] === "/") {
					re += "(?:.*/)?";
					i += 2;
				} else {
					re += ".*";
					i += 1;
				}
			} else {
				re += "[^/]*";
			}
		} else if (c === "?") {
			re += "[^/]";
		} else {
			re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		}
	}
	return new RegExp(`^${re}$`).test(expand(candidate));
}

function expandHome(p: string, home: string): string {
	if (p === "~" || p === "$HOME") return home;
	if (p.startsWith("~/")) return home + p.slice(1);
	if (p.startsWith("$HOME/")) return home + p.slice(5);
	return p;
}

/** Trim shell noise off a whitespace token without touching glob stars. */
function bareWord(raw: string): string {
	return raw.replace(/^[\s'"`]+|[\s'"`;]+$/g, "");
}

/** Path-like words of one command string: with a slash, or dotfiles, or home-relative. */
function pathTokens(command: string): string[] {
	const out: string[] = [];
	for (const raw of command.split(/\s+/)) {
		const tok = bareWord(raw.replace(/^\d+>&\d+$/, "")).replace(/^\d+>/, "");
		if (tok === "") continue;
		if (tok.includes("/") || tok.startsWith(".") || tok.startsWith("~") || tok.startsWith("$HOME")) out.push(tok);
	}
	return out;
}

/** Every string an args object carries, nested arrays and objects included. */
function argStrings(args: Record<string, unknown> | undefined): string[] {
	if (!args) return [];
	const out: string[] = [];
	const walk = (v: unknown): void => {
		if (typeof v === "string") out.push(v);
		else if (Array.isArray(v)) for (const x of v) walk(x);
		else if (v && typeof v === "object") for (const x of Object.values(v as Record<string, unknown>)) walk(x);
	};
	for (const v of Object.values(args)) walk(v);
	return out;
}

/** Host out of a URL authority or a `user@host[:port][:path]` destination (path stripped). */
function hostOf(authority: string): string {
	let h = authority;
	const at = h.lastIndexOf("@");
	if (at !== -1) h = h.slice(at + 1);
	if (h.startsWith("[")) {
		const end = h.indexOf("]");
		return end === -1 ? h.slice(1) : h.slice(1, end);
	}
	return h.split(/[/:?#]/, 1)[0] ?? h;
}

// Short options that take a separate value, so the value is never read as a host operand.
const VALUE_FLAGS: Record<string, true> = {
	"-p": true, "-i": true, "-L": true, "-R": true, "-D": true, "-J": true, "-F": true,
	"-w": true, "-W": true, "-b": true, "-c": true, "-e": true, "-m": true, "-o": true,
	"-O": true, "-Q": true, "-B": true, "-S": true, "-s": true, "-l": true, "-P": true, "-T": true,
};

/** Non-flag operands of one simple command (given without its tool word). */
function operands(words: string[]): string[] {
	const out: string[] = [];
	let skipValue = false;
	for (const raw of words) {
		const w = bareWord(raw);
		if (w === "") continue;
		if (skipValue) {
			skipValue = false;
			continue;
		}
		if (w.startsWith("-")) {
			if (!w.includes("=") && VALUE_FLAGS[w]) skipValue = true;
			continue;
		}
		out.push(w);
	}
	return out;
}

// curl/wget options that carry a body or an upload: short clusters with a data letter
// (`-d@f`, `-sSd x`), long forms, and an explicit sending method.
const SENDS_DATA = /(?:^|[\s|;&("'])-(?:[a-z]*d[@=\s-]|F[@=\s-]|[a-z]*T[@=\s-]|X\s*(?:POST|PUT|PATCH)\b|--?data[\w-]*[@=\s]|--?form[\w-]*[@=\s]|--upload-file[@=\s]|--put[@=\s]|--post-[\w-]*[@=\s])/;

interface NetHit {
	tool: string;
	host: string;
	exfil: boolean;
}

/**
 * Network destinations in one command: every word-boundary occurrence of a net tool, the host
 * it talks to, and whether the shape sends data (pipe into the tool, a body/upload option, a
 * stdin redirect, or a local file as the scp source).
 */
function netHits(command: string, netTools: string[]): NetHit[] {
	const hits: NetHit[] = [];
	for (const tool of netTools) {
		const word = tool.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const re = new RegExp("(?:^|[\\s|;&(\"'`/])" + word + "(?=$|[\\s'\";&|)`])", "g");
		for (const m of command.matchAll(re)) {
			const at = (m.index ?? 0) + m[0].lastIndexOf(tool);
			const rest = command.slice(at);
			const brk = rest.search(/\n|;|&&/);
			const seg = brk === -1 ? rest : rest.slice(0, brk);
			let host = "";
			let exfil = command.slice(0, at).trimEnd().endsWith("|");
			const url = seg.match(/[A-Za-z][A-Za-z0-9+.-]*:\/\/([^\s'"`<>\\]+)/);
			if (url) host = hostOf(url[1]!);
			const ops = operands(seg.split(/\s+/).slice(1));
			if (tool === "scp") {
				// first remote (colon) operand is the other end; local operands before it are being sent
				const first = ops.findIndex((t) => t.includes(":"));
				if (first !== -1) {
					if (host === "") host = hostOf(ops[first]!);
					exfil = exfil || first > 0;
				}
			} else if (tool === "nc") {
				if (/(?:^|\s)-(?:l|listen)\b/.test(seg)) continue;
				if (host === "") host = hostOf(ops[0] ?? "");
				if (/\s<\s*[^\s|;&]/.test(seg)) exfil = true;
			} else if (tool === "ssh") {
				if (host === "") host = hostOf(ops[0] ?? "");
			} else if (SENDS_DATA.test(seg)) {
				exfil = true;
			}
			if (host !== "") hits.push({ tool, host, exfil });
		}
	}
	return hits;
}

const WRITE_WORDS: Record<string, true> = { tee: true, touch: true, cp: true, mv: true, install: true, ln: true };
const OUT_WORDS: Record<string, true> = { "-o": true, "-O": true, "--output": true, "--output-document": true };
const DEV_TARGET = /^\/dev\/[\w.]+$/;

/** Absolute write targets of one command: redirections, `of=`, and the writing commands. */
function writeTargets(command: string): string[] {
	const out: string[] = [];
	for (const seg of command.split(/\n|;|&&|\|\|/)) {
		for (const m of seg.matchAll(/\d*>>?>?|>&\d*/g)) {
			const after = seg.slice((m.index ?? 0) + m[0].length).trim();
			if (after !== "") out.push(after.split(/\s+/)[0]!);
		}
		for (const m of seg.matchAll(/\bof=([^\s;&|]+)/g)) out.push(m[1]!);
		const words = seg.split(/\s+/);
		for (let i = 0; i < words.length; i++) {
			const w = bareWord(words[i]!);
			const rest = operands(words.slice(i + 1));
			if (rest.length === 0) continue;
			if (WRITE_WORDS[w]) {
				// tee/touch write every operand; cp/mv/install/ln write the destination (last)
				if (w === "tee" || w === "touch") out.push(...rest);
				else out.push(rest[rest.length - 1]!);
			} else if (OUT_WORDS[w]) {
				out.push(rest[0]!);
			}
		}
	}
	return out
		.map((t) => bareWord(t.replace(/^\d+>&?\d*$/, "")).replace(/^\d+>/, ""))
		.filter((t) => t.startsWith("/") || t.startsWith("~") || t.startsWith("$HOME"))
		.filter((t) => !DEV_TARGET.test(t));
}

function hostAllowed(host: string, allowed: string[]): boolean {
	const h = host.toLowerCase();
	for (const a of allowed) {
		const pat = a.toLowerCase();
		if (pat.startsWith("*.")) {
			if (h === pat.slice(2) || h.endsWith(pat.slice(1))) return true;
		} else if (h === pat) {
			return true;
		}
	}
	return false;
}

/**
 * Every suspicious action in one run's trace, in event order, deduped on rule+target (the
 * first occurrence carries the evidence). Read paths are checked against `secret_globs`,
 * network commands against `allowed_hosts`, write targets against `deny_globs` and the
 * `write_roots` scope (deny paths fire wherever the roots point), and commands against the
 * pipe-to-shell patterns.
 */
export function suspiciousActions(events: TraceEvent[], rules: ActionsRules): SuspiciousAction[] {
	const out: SuspiciousAction[] = [];
	const seen = new Set<string>();
	const add = (a: SuspiciousAction): void => {
		const key = `${a.rule}:${a.target}`;
		if (seen.has(key)) return;
		seen.add(key);
		out.push({ ...a, evidence: maskEvidence(a.evidence) });
	};
	for (const ev of events) {
		if (ev.kind !== "toolCall") continue;
		const tool = ev.tool ?? "?";
		const shell = rules.shell_tools.includes(tool);
		const command = shell && typeof ev.args?.command === "string" ? ev.args.command : "";
		const writer = !shell && rules.write_tools.includes(tool);
		// A write tool's content is data, not an action: only its path arguments are checked.
		const scanArgs = command === "" && !writer;
		const writes = new Set<string>([
			...writeTargets(command).map((w) => expandHome(w, rules.home)),
			...(writer ? argStrings(ev.args).map((w) => expandHome(w, rules.home)) : []),
		]);
		const evidence = command !== "" ? command : JSON.stringify(ev.args ?? {});
		for (const w of writes) {
			if (rules.deny_globs.some((g) => globMatch(g, w, rules.home))) {
				add({ rule: "write-out-of-scope", severity: "medium", runId: ev.runId, ts: ev.ts, tool, target: w, summary: `writes ${w} — a deny path`, evidence });
				continue;
			}
			const inScope =
				rules.write_roots.length === 0 ||
				rules.write_roots.some((r) => {
					const root = expandHome(r, rules.home);
					return w === root || w.startsWith(root.endsWith("/") ? root : `${root}/`);
				});
			if (!inScope) {
				add({ rule: "write-out-of-scope", severity: "medium", runId: ev.runId, ts: ev.ts, tool, target: w, summary: `writes ${w} outside the allowed roots`, evidence });
			}
		}
		const candidates = [
			...pathTokens(command),
			...(scanArgs ? argStrings(ev.args).filter((s) => s.includes("/") || s.startsWith(".") || s.startsWith("~")) : []),
		];
		for (const c of candidates) {
			const full = expandHome(c, rules.home);
			if (writes.has(full)) continue;
			const glob = rules.secret_globs.find((g) => globMatch(g, c, rules.home));
			if (glob === undefined) continue;
			add({ rule: "secret-read", severity: "high", runId: ev.runId, ts: ev.ts, tool, target: full, summary: `reads ${c} (matches ${glob})`, evidence });
		}
		if (command === "") continue;
		for (const h of netHits(command, rules.net_tools)) {
			if (hostAllowed(h.host, rules.allowed_hosts)) continue;
			add({ rule: "net-unknown-host", severity: h.exfil ? "high" : "low", runId: ev.runId, ts: ev.ts, tool, target: h.host, summary: `${h.tool} to unknown host ${h.host}${h.exfil ? " (sends data)" : ""}`, evidence: command });
		}
		for (const p of rules.shell_patterns) {
			if (command.includes(p)) {
				add({ rule: "pipe-to-shell", severity: "medium", runId: ev.runId, ts: ev.ts, tool, target: p, summary: `feeds a shell from a pipe (${p})`, evidence: command });
			}
		}
	}
	return out;
}
