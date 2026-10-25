// Secrets never reach the model, the chat or the session log (plan 20261025_2204, incident
// I-20261025-197). Detection is by CONTENT, not by file name: gitleaks-style shapes plus the exact
// values this machine holds (env vars, ~/.npmrc, dotenv files under the work roots, notify webhook
// URLs). Every hit becomes `[REDACTED:<type>]`; the value itself never appears in the returned
// text, in the hit list or in a log line — the hits carry a type and a count only.
//
// Pure TypeScript, no harness and no agent: the harness adapter (tool_result), notify.ts (outbound
// posts), `neurastream redact` and doctor all call this one module.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Config } from "./config.ts";

/** One owner-defined shape: the marker type and its regex source. */
export interface SecretPattern {
	type: string;
	regex: string;
}

export interface RedactHit {
	type: string;
	count: number;
}

export interface RedactResult {
	text: string;
	hits: RedactHit[];
}

interface Rule {
	/** Named in `[REDACTED:<type>]` and in the hit summary. */
	type: string;
	regex: RegExp;
	/** Leading capture groups kept verbatim (a key name, an assignment prefix) before the marker. */
	keep?: number;
}

// Shape rules in application order: a structural prefix (`_authToken=`, a URL's user part) is
// recognised before the bare token shapes, and the generic assignment rule runs after both so a
// token keeps its own type name. Every regex is linear: no nested quantifier over the same text.
// The `(?!\[REDACTED:)` lookahead keeps a rule from matching a value an earlier rule already
// replaced — `OPENAI_API_KEY=[REDACTED:sk-key]` must not become a generic hit.
const RULES: Rule[] = [
	{ type: "private-key", regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g },
	{ type: "npmrc-auth-token", regex: /(_authToken\s*=\s*)(?!\[REDACTED:)\S+/g, keep: 1 },
	{ type: "npmrc-password", regex: /(_password\s*=\s*)(?!\[REDACTED:)\S+/g, keep: 1 },
	{ type: "url-password", regex: /\b([a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:)(?!\[REDACTED:)[^\s/@]+(?=@)/gi, keep: 1 },
	{ type: "aws-secret-access-key", regex: /(aws_secret_access_key\s*[:=]\s*['"]?)(?!\[REDACTED:)[A-Za-z0-9/+=]{16,}/gi, keep: 1 },
	{ type: "aws-access-key-id", regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
	{ type: "github-token", regex: /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})\b/g },
	{ type: "gitlab-token", regex: /\bglpat-[A-Za-z0-9_-]{16,}\b/g },
	{ type: "npm-token", regex: /\bnpm_[A-Za-z0-9]{36}\b/g },
	{ type: "sk-key", regex: /\bsk-(?:ant-|or-|proj-)?[A-Za-z0-9_-]{16,}\b/g },
	{ type: "google-api-key", regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
	{ type: "slack-token", regex: /\bxox[abpr]-[A-Za-z0-9-]{10,}\b/g },
	{ type: "discord-webhook", regex: /\bhttps?:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+/g },
	{ type: "stripe-key", regex: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{10,}\b/g },
	{ type: "jwt", regex: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
];

// Runs after the shapes above and after the owner's own patterns, so a specific shape names the
// value first; only what nothing else recognised becomes `generic-secret`. The key name may be
// a multi-part name (`DB_PASSWORD=`, `MY_APP_TOKEN:`): the identifier is kept whole, so the reader still
// sees which key was hidden, and only the value goes.
const GENERIC_RULE: Rule = {
	type: "generic-secret",
	regex: /([A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret))(\s*[:=]\s*)(['"]?)(?!\[REDACTED:)([^\s'",;]{8,})/gi,
	keep: 3,
};

/** The external proxy that can sit on the wire as a second net (plan 20261025_2204, P3). */
export const PROXY_BIN = "secretgate";

/** Whether the proxy binary is on PATH. Never spawned here: launch and doctor only need to know. */
export function proxyOnPath(env: NodeJS.ProcessEnv = process.env): boolean {
	for (const dir of (env.PATH ?? "").split(":")) {
		if (dir === "") continue;
		try {
			if (statSync(join(dir, PROXY_BIN)).isFile()) return true;
		} catch {}
	}
	return false;
}

/** A known value shorter than this is not redacted: it would shred ordinary text. */
const MIN_KNOWN_LEN = 8;

/** Env var names whose values count as secrets. */
const SECRET_ENV_NAME = /KEY|TOKEN|SECRET|PASSWORD|PASS|AUTH|CREDENTIAL|WEBHOOK/i;

/** A dotenv file at the top of a repo: `.` + `env` and anything after it (`.env`, `.env.local`). */
const DOTENV_NAME = /^\.env/;

/** Files larger than this are not scanned for values: no env file or webhook file is that big. */
const MAX_FILE_BYTES = 1024 * 1024;

function bump(counts: Map<string, number>, type: string): void {
	counts.set(type, (counts.get(type) ?? 0) + 1);
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const extraCache = new Map<string, RegExp>();

/** Owner-defined shapes, built once per process; a bad regex cannot reach here (config.check). */
function extraRules(extra: SecretPattern[]): Rule[] {
	const out: Rule[] = [];
	for (const p of extra) {
		if (typeof p?.type !== "string" || p.type === "" || typeof p.regex !== "string" || p.regex === "") continue;
		let re = extraCache.get(p.regex);
		if (!re) {
			try {
				re = new RegExp(p.regex, "g");
			} catch {
				continue;
			}
			extraCache.set(p.regex, re);
		}
		out.push({ type: p.type, regex: re });
	}
	return out;
}

function applyRule(text: string, rule: Rule, counts: Map<string, number>): string {
	const keep = rule.keep ?? 0;
	return text.replace(rule.regex, (...args: unknown[]) => {
		const prefix = args
			.slice(1, 1 + keep)
			.map(g => (typeof g === "string" ? g : ""))
			.join("");
		bump(counts, rule.type);
		return `${prefix}[REDACTED:${rule.type}]`;
	});
}

/** Exact values, deduped, longest first so a value that contains another is matched whole. */
function knownPattern(values: Iterable<string>): RegExp | null {
	const seen = new Set<string>();
	for (const value of values) {
		const text = value.trim();
		if (text.length >= MIN_KNOWN_LEN) seen.add(text);
	}
	if (seen.size === 0) return null;
	const pattern = [...seen]
		.sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0))
		.map(escapeRegExp)
		.join("|");
	return new RegExp(pattern, "g");
}

/**
 * Replaces every secret in `text` with `[REDACTED:<type>]` and reports what it hid. `known` holds
 * exact values (see `loadKnownSecrets`); `extra` holds the owner's own shapes. Running it twice on
 * the same text is stable: a marker matches no rule.
 */
export function redactSecrets(text: string, known: Iterable<string> = [], extra: SecretPattern[] = []): RedactResult {
	if (text === "") return { text, hits: [] };
	const counts = new Map<string, number>();
	let out = text;
	for (const rule of RULES) out = applyRule(out, rule, counts);
	for (const rule of extraRules(extra)) out = applyRule(out, rule, counts);
	out = applyRule(out, GENERIC_RULE, counts);
	const knownRe = knownPattern(known);
	if (knownRe) {
		out = out.replace(knownRe, () => {
			bump(counts, "known-value");
			return "[REDACTED:known-value]";
		});
	}
	return { text: out, hits: [...counts].map(([type, count]) => ({ type, count })) };
}

/** The one line the adapter adds to a tool result when it hid anything. Types only, never values. */
export function redactSummary(hits: RedactHit[]): string {
	const total = hits.reduce((n, h) => n + h.count, 0);
	return `secret-redact: hid ${total} value(s) (${hits.map(h => h.type).join(", ")})`;
}

// --- known values ---

interface CachedFile {
	mtimeMs: number;
	size: number;
	values: string[];
}

type FileKind = "npmrc" | "env" | "text";

const fileCache = new Map<string, CachedFile>();
let discovered: { roots: string; atMs: number; files: string[] } | null = null;
/** The work-root dotenv list is a directory walk, not a file read: rescan at this interval. */
const DISCOVERY_TTL_MS = 60_000;
const MAX_REPO_DIRS = 500;

/** Forgets every cached file and the discovered dotenv list (tests switch sandboxes). */
export function clearKnownSecretsCache(): void {
	fileCache.clear();
	discovered = null;
}

/** `_authToken` and `_password` values of an npmrc. */
function npmrcValues(text: string): string[] {
	const out: string[] = [];
	for (const line of text.split("\n")) {
		const m = /^\s*(?:\/\/[^\s=]*:)?_(?:authToken|password)\s*=\s*(\S+)/i.exec(line);
		if (m?.[1]) out.push(m[1]);
	}
	return out;
}

/** `KEY=value` values of an env-style file (quotes stripped, comments ignored). */
function envValues(text: string): string[] {
	const out: string[] = [];
	for (const line of text.split("\n")) {
		const m = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.+)$/.exec(line);
		if (!m?.[1]) continue;
		let value = m[1].trim();
		if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0])) value = value.slice(1, -1);
		const hash = value.search(/\s#/);
		if (hash !== -1) value = value.slice(0, hash).trim();
		if (value !== "") out.push(value);
	}
	return out;
}

function fileValues(path: string, kind: FileKind): string[] {
	const key = `${kind}\0${path}`;
	let size: number;
	let mtimeMs: number;
	try {
		const st = statSync(path);
		if (!st.isFile() || st.size > MAX_FILE_BYTES) return [];
		size = st.size;
		mtimeMs = st.mtimeMs;
	} catch {
		fileCache.delete(key);
		return [];
	}
	const hit = fileCache.get(key);
	if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return hit.values;
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return hit?.values ?? [];
	}
	const values = kind === "npmrc" ? npmrcValues(text) : kind === "env" ? envValues(text) : [text.trim()];
	fileCache.set(key, { mtimeMs, size, values });
	return values;
}

/** Dotenv files at the top of `dir` (its own, not its subdirectories'). */
function envFilesIn(dir: string): string[] {
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries.filter(e => e.isFile() && DOTENV_NAME.test(e.name)).map(e => join(dir, e.name));
}

/** Every top-level dotenv file under a work root, plus each repo directory's own. */
function workRootEnvFiles(roots: string[]): string[] {
	const key = roots.join("\0");
	const nowMs = Date.now();
	if (discovered && discovered.roots === key && nowMs - discovered.atMs < DISCOVERY_TTL_MS) return discovered.files;
	const files = new Set<string>();
	for (const root of roots) {
		for (const file of envFilesIn(root)) files.add(file);
		let repos;
		try {
			repos = readdirSync(root, { withFileTypes: true });
		} catch {
			continue;
		}
		let seen = 0;
		for (const entry of repos) {
			if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
			if (seen++ >= MAX_REPO_DIRS) break;
			for (const file of envFilesIn(join(root, entry.name))) files.add(file);
		}
	}
	const list = [...files];
	discovered = { roots: key, atMs: nowMs, files: list };
	return list;
}

/** The notify webhook files: the URL in one is a secret like any other (config holds only paths). */
function notifyFiles(cfg: Config): string[] {
	return [cfg.notify.discord_webhook_file, cfg.notify.slack_webhook_file].filter(f => typeof f === "string" && f !== "");
}

/**
 * The exact values this machine holds, so a secret is hidden wherever it appears whatever the file
 * is called: env vars whose name looks like a credential, `~/.npmrc`, `secrets.known_value_files`,
 * every top-level dotenv file under `paths.work_roots`, and the notify webhook files. File contents
 * are cached per process and re-read when a file's mtime or size changes.
 */
export function loadKnownSecrets(cfg: Config, env: NodeJS.ProcessEnv = process.env): string[] {
	const out = new Set<string>();
	const add = (value: string): void => {
		const text = value.trim();
		if (text.length >= MIN_KNOWN_LEN) out.add(text);
	};
	for (const [name, value] of Object.entries(env)) {
		if (typeof value === "string" && SECRET_ENV_NAME.test(name)) add(value);
	}
	for (const value of fileValues(join(homedir(), ".npmrc"), "npmrc")) add(value);
	for (const file of cfg.secrets.known_value_files) for (const value of fileValues(file, "env")) add(value);
	for (const file of workRootEnvFiles(cfg.paths.work_roots)) for (const value of fileValues(file, "env")) add(value);
	for (const file of notifyFiles(cfg)) for (const value of fileValues(file, "text")) add(value);
	return [...out];
}
