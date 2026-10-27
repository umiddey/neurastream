import { closeSync, existsSync, lstatSync, openSync, readdirSync, readFileSync, statSync, writeSync } from "node:fs";
import { basename, join } from "node:path";
import type { Config } from "./config.ts";
import { expandHome } from "./queue/lib.ts";
import { gitRaw } from "./proc.ts";

export interface KnowledgeEntry {
	repo: string;
	topic: string;
	title: string;
	/** ISO-8601 date (commit date or mtime fallback). */
	updated: string;
}

interface ManifestFile {
	built: number;
	entries: KnowledgeEntry[];
}

const KNOWLEDGE_DIR = join("docs", "knowledge");

/** Text order for the lists: code-unit order, so the same list on every machine. */
export function byText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/** One URL path segment or query value: every byte outside the unreserved set becomes %XX. */
export function urlValue(s: string): string {
	let out = "";
	for (const byte of new TextEncoder().encode(s)) {
		const ch = String.fromCharCode(byte);
		out += /[A-Za-z0-9\-._~]/.test(ch) ? ch : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
	}
	return out;
}

/** Inverse of urlValue: %XX byte runs come back as UTF-8 text. */
export function urlField(s: string): string {
	const bytes: number[] = [];
	for (let i = 0; i < s.length; i++) {
		const hex = s.slice(i + 1, i + 3);
		if (s[i] === "%" && /^[0-9A-Fa-f]{2}$/.test(hex)) {
			bytes.push(parseInt(hex, 16));
			i += 2;
		} else {
			bytes.push(...new TextEncoder().encode(s[i]!));
		}
	}
	return new TextDecoder().decode(new Uint8Array(bytes));
}

function repoKey(repoPath: string): string {
	const remote = gitRaw(repoPath, ["remote", "get-url", "origin"]).stdout.trim();
	if (remote) {
		const base = basename(remote.replace(/\/$/, ""));
		return base.endsWith(".git") ? base.slice(0, -4) : base;
	}
	return basename(repoPath);
}

function parseTitle(html: string, fallback: string): string {
	const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
	if (!m) return fallback;
	const t = m[1]!.replace(/\s+/g, " ").trim();
	return t || fallback;
}

function topicUpdated(repoPath: string, rel: string, abs: string, now: number): string {
	const log = gitRaw(repoPath, ["log", "-1", "--format=%cI", "--", rel]).stdout.trim();
	if (log) return log;
	const mtime = statSync(abs).mtimeMs;
	return new Date(mtime).toISOString();
}

function isLinkedWorktree(repoPath: string): boolean {
	const dot = join(repoPath, ".git");
	return existsSync(dot) && lstatSync(dot).isFile();
}

function isGitCheckout(dir: string): boolean {
	const dot = join(dir, ".git");
	return existsSync(dot) && (lstatSync(dot).isDirectory() || lstatSync(dot).isFile());
}

function scanRepo(repoPath: string, now: number): KnowledgeEntry[] {
	if (isLinkedWorktree(repoPath)) return [];
	const knowDir = join(repoPath, KNOWLEDGE_DIR);
	if (!existsSync(knowDir) || !lstatSync(knowDir).isDirectory()) return [];
	const repo = repoKey(repoPath);
	const out: KnowledgeEntry[] = [];
	for (const ent of readdirSync(knowDir, { withFileTypes: true })) {
		if (!ent.isFile() || !ent.name.endsWith(".html")) continue;
		const topic = ent.name.slice(0, -".html".length);
		const abs = join(knowDir, ent.name);
		let html = "";
		try {
			html = readFileSync(abs, "utf8");
		} catch {
			continue;
		}
		out.push({
			repo,
			topic,
			title: parseTitle(html, topic),
			updated: topicUpdated(repoPath, join(KNOWLEDGE_DIR, ent.name), abs, now),
		});
	}
	out.sort((a, b) => byText(a.repo, b.repo) || byText(a.topic, b.topic));
	return out;
}

/** Pure scan: repos directly under expanded roots; unreadable dirs skipped. */
export function scanKnowledge(roots: string[], now: number): KnowledgeEntry[] {
	const entries: KnowledgeEntry[] = [];
	for (const raw of roots) {
		let root = "";
		try {
			root = expandHome(raw);
		} catch {
			continue;
		}
		if (!existsSync(root)) continue;
		let names: string[] = [];
		try {
			names = readdirSync(root);
		} catch {
			continue;
		}
		for (const name of names) {
			const repoPath = join(root, name);
			try {
				if (!lstatSync(repoPath).isDirectory()) continue;
				if (!isGitCheckout(repoPath)) continue;
				entries.push(...scanRepo(repoPath, now));
			} catch {
				continue;
			}
		}
	}
	entries.sort((a, b) => byText(a.repo, b.repo) || byText(a.topic, b.topic));
	return entries;
}

export function knowledgeManifestPath(cfg: Config): string {
	return join(expandHome(cfg.paths.queue_state), "knowledge.json");
}

function readManifest(path: string): ManifestFile | null {
	if (!existsSync(path)) return null;
	try {
		const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!raw || typeof raw !== "object") return null;
		const built = (raw as ManifestFile).built;
		const entries = (raw as ManifestFile).entries;
		if (typeof built !== "number" || !Array.isArray(entries)) return null;
		return { built, entries };
	} catch {
		return null;
	}
}

function writeManifest(path: string, data: ManifestFile): void {
	const fd = openSync(path, "w");
	try {
		writeSync(fd, JSON.stringify(data));
	} finally {
		closeSync(fd);
	}
}

/** Cached manifest in queue state; rescans when older than cfg.knowledge.max_age_s. */
export function knowledgeManifest(cfg: Config, nowSec = Math.floor(Date.now() / 1000)): KnowledgeEntry[] {
	const path = knowledgeManifestPath(cfg);
	const cached = readManifest(path);
	const maxAge = cfg.knowledge.max_age_s;
	if (cached && nowSec - cached.built < maxAge) return cached.entries;
	const entries = scanKnowledge(cfg.knowledge.roots, nowSec * 1000);
	const fresh: ManifestFile = { built: nowSec, entries };
	writeManifest(path, fresh);
	return entries;
}

/** Absolute path to a topic HTML file, or null when repo/topic is unknown. */
export function resolveKnowledgeTopic(cfg: Config, repo: string, topic: string): string | null {
	if (!/^[a-zA-Z0-9._-]+$/.test(repo) || !/^[a-zA-Z0-9._-]+$/.test(topic)) return null;
	for (const raw of cfg.knowledge.roots) {
		let root = "";
		try {
			root = expandHome(raw);
		} catch {
			continue;
		}
		if (!existsSync(root)) continue;
		let names: string[] = [];
		try {
			names = readdirSync(root);
		} catch {
			continue;
		}
		for (const name of names) {
			const repoPath = join(root, name);
			try {
				if (!lstatSync(repoPath).isDirectory() || !isGitCheckout(repoPath) || isLinkedWorktree(repoPath)) continue;
				if (repoKey(repoPath) !== repo) continue;
				const file = join(repoPath, KNOWLEDGE_DIR, `${topic}.html`);
				if (existsSync(file) && lstatSync(file).isFile()) return file;
			} catch {
				continue;
			}
		}
	}
	return null;
}

/** Read topic bytes for serving; null when missing. */
export function readKnowledgeTopicFile(cfg: Config, repo: string, topic: string): Buffer<ArrayBuffer> | null {
	const path = resolveKnowledgeTopic(cfg, repo, topic);
	if (!path) return null;
	try {
		return readFileSync(path);
	} catch {
		return null;
	}
}
