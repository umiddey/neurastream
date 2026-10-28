// queue-finished: fill and search FINISHED.md. Backfill reads archived plans; a word prints matches.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Config } from "./config.ts";
import { applyQueueEnv } from "./queue/env.ts";
import { finishedEntry, finishedKey, finishedPath, parsePlan, planRepo, prependFinished, repoRoot } from "./queue/lib.ts";

const USAGE = "usage: queue-finished --backfill | --dedupe | queue-finished <word>";

/** Shared with src/core/results.ts: every *.md under dir, recursively. */
export function walkMd(dir: string, out: string[]): void {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return;
	}
	for (const name of names) {
		const file = path.join(dir, name);
		let st: ReturnType<typeof statSync> | null = null;
		try {
			st = statSync(file);
		} catch {
			continue;
		}
		if (st.isDirectory()) walkMd(file, out);
		else if (name.endsWith(".md")) out.push(file);
	}
}

/** Repos named by work_roots, plus one level of children so a root that holds many checkouts still counts. Shared with src/core/results.ts. */
export function repoRoots(roots: string[]): string[] {
	const out: string[] = [];
	for (const root of roots) {
		if (!existsSync(root)) continue;
		out.push(root);
		let names: string[] = [];
		try {
			names = readdirSync(root);
		} catch {
			continue;
		}
		for (const name of names) {
			if (name.startsWith(".")) continue;
			const child = path.join(root, name);
			try {
				if (statSync(child).isDirectory()) out.push(child);
			} catch {}
		}
	}
	return out;
}

function stampDate(file: string): string {
	const stamp = /^(\d{4})(\d{2})(\d{2})_/.exec(path.basename(file));
	if (stamp) return `${stamp[1]}-${stamp[2]}-${stamp[3]}`;
	try {
		return new Date(statSync(file).mtimeMs).toISOString().slice(0, 10);
	} catch {
		return new Date().toISOString().slice(0, 10);
	}
}

function archivedPlans(roots: string[]): string[] {
	const files: string[] = [];
	const seen = new Set<string>();
	// Main checkouts sort first; a linked worktree adds only plan file names the main checkout lacks.
	const dirs = repoRoots(roots).map(dir => ({ dir, repo: repoRoot(dir) ?? dir }));
	dirs.sort((a, b) => Number(b.repo === b.dir) - Number(a.repo === a.dir));
	for (const { dir, repo } of dirs) {
		const found: string[] = [];
		walkMd(path.join(dir, "docs/plans/archive"), found);
		for (const file of found) {
			// Same repo + file name = the same plan seen through another worktree; across repos the name may repeat.
			const key = `${repo}\0${path.basename(file)}`;
			if (seen.has(key)) continue;
			seen.add(key);
			files.push(file);
		}
	}
	return files;
}

function backfill(cfg: Config): number {
	const files = archivedPlans(cfg.paths.work_roots);
	const plans = files
		.map(file => {
			let raw = "";
			try {
				raw = readFileSync(file, "utf8");
			} catch {
				return null;
			}
			const plan = parsePlan(planRepo(file), file, raw);
			return plan.status === "complete" ? plan : null;
		})
		.filter(p => p !== null)
		.sort((a, b) => (path.basename(a.file) < path.basename(b.file) ? -1 : 1));
	let added = 0;
	// Oldest first so each prepend leaves the newer entry on top.
	for (const plan of plans) {
		if (prependFinished(finishedEntry(plan, plan.file, stampDate(plan.file)))) added++;
	}
	console.log(`queue-finished: backfill added ${added} (${plans.length} complete archived)`);
	return 0;
}

/** Keeps the first entry for each finished key and drops later repeats. */
function dedupe(): number {
	const file = finishedPath();
	let text = "";
	try {
		text = readFileSync(file, "utf8");
	} catch {}
	const seen = new Set<string>();
	const kept: string[] = [];
	let removed = 0;
	for (const block of text.split(/^(?=## )/m)) {
		if (!block.startsWith("## ")) kept.push(block);
		else if (seen.has(finishedKey(block))) removed++;
		else {
			seen.add(finishedKey(block));
			kept.push(block);
		}
	}
	if (removed) writeFileSync(file, kept.join(""));
	console.log(`queue-finished: removed ${removed} duplicate entries`);
	return 0;
}

function entries(text: string): string[] {
	return text.split(/^(?=## )/m).filter(p => p.startsWith("## ")).map(p => p.trimEnd());
}

function search(word: string): number {
	let text = "";
	try {
		text = readFileSync(finishedPath(), "utf8");
	} catch {}
	const needle = word.toLowerCase();
	const hits = entries(text).filter(e => e.toLowerCase().includes(needle));
	if (!hits.length) {
		console.error(`queue-finished: no entry matches ${word}`);
		return 1;
	}
	console.log(hits.join("\n\n"));
	return 0;
}

export function queueFinished(args: string[], cfg: Config): number {
	applyQueueEnv(cfg);
	if (args[0] === "--help" || args[0] === "-h") {
		console.log(USAGE);
		return 0;
	}
	if (args.includes("--backfill")) return backfill(cfg);
	if (args.includes("--dedupe")) return dedupe();
	const word = args.filter(a => !a.startsWith("-")).join(" ").trim();
	if (!word) {
		console.error(USAGE);
		return 2;
	}
	return search(word);
}
