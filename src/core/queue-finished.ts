// queue-finished: fill and search FINISHED.md. Backfill reads archived plans; a word prints matches.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { Config } from "./config.ts";
import { applyQueueEnv } from "./queue/env.ts";
import { finishedEntry, finishedPath, parsePlan, planRepo, prependFinished } from "./queue/lib.ts";

const USAGE = "usage: queue-finished --backfill | queue-finished <word>";

function walkMd(dir: string, out: string[]): void {
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

/** Repos named by work_roots, plus one level of children so a root that holds many checkouts still counts. */
function repoRoots(roots: string[]): string[] {
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
	for (const repo of repoRoots(roots)) walkMd(path.join(repo, "docs/plans/archive"), files);
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
		.sort((a, b) => path.basename(b.file).localeCompare(path.basename(a.file)));
	let added = 0;
	// Oldest first so each prepend leaves the newer entry on top.
	for (const plan of plans.reverse()) {
		if (prependFinished(finishedEntry(plan, plan.file, stampDate(plan.file)))) added++;
	}
	console.log(`queue-finished: backfill added ${added} (${plans.length} complete archived)`);
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
	const word = args.filter(a => !a.startsWith("-")).join(" ").trim();
	if (!word) {
		console.error(USAGE);
		return 2;
	}
	return search(word);
}
