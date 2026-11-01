import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { Config } from "./config.ts";

export function keyOf(path: string, home: string): string {
	const realHome = existsSync(home) ? realpathSync(home) : home;
	const realPath = existsSync(path) ? realpathSync(path) : path;
	return relative(realHome, realPath).replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
}

function walkFolder(dir: string, currentDepth: number, maxDepth: number, out: string[]): void {
	if (currentDepth > maxDepth) return;
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return;
	}
	for (const entry of entries) {
		if (entry === "node_modules" || entry === ".git") continue;
		const fullPath = join(dir, entry);
		let st;
		try {
			st = statSync(fullPath);
		} catch {
			continue;
		}
		if (!st.isDirectory()) continue;

		if (existsSync(join(fullPath, ".git"))) {
			out.push(fullPath);
		} else {
			walkFolder(fullPath, currentDepth + 1, maxDepth, out);
		}
	}
}

export function wipRepos(cfg: Config): string[] {
	const out: string[] = [];
	const maxDepth = Math.max(0, cfg.wip.depth ?? 3);
	for (const root of cfg.wip.roots) {
		if (!existsSync(root)) continue;
		let st;
		try {
			st = statSync(root);
		} catch {
			continue;
		}
		if (!st.isDirectory()) continue;

		if (existsSync(join(root, ".git"))) {
			out.push(root);
		} else {
			walkFolder(root, 1, maxDepth, out);
		}
	}
	return Array.from(new Set(out)).toSorted();
}
