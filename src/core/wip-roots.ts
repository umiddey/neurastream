import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { Config } from "./config.ts";

/** True when `dir/.git` is a file naming a gitdir that no longer exists: no repo is left to save. */
export function deadGitfile(dir: string): boolean {
	const gitPath = join(dir, ".git");
	let first: string | undefined;
	try {
		if (!statSync(gitPath).isFile()) return false;
		first = readFileSync(gitPath, "utf8").split("\n")[0];
	} catch {
		return false; // an unreadable .git file is not our call: the repo stays and its failure is real
	}
	if (!first?.startsWith("gitdir: ")) return false;
	return !existsSync(resolve(dir, first.slice("gitdir: ".length).trim()));
}

/** The worktree's ref key: one valid git ref component, also for paths outside home (`../`) or dot dirs. */
export function keyOf(path: string, home: string): string {
	const realHome = existsSync(home) ? realpathSync(home) : home;
	const realPath = existsSync(path) ? realpathSync(path) : path;
	return relative(realHome, realPath)
		.replace(/[^A-Za-z0-9._-]+/g, "_")
		.replace(/\.{2,}/g, "_")
		.replace(/^[._]+|_+$/g, "")
		.replace(/\.lock$/, "_lock");
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

		// A dead worktree dir has no repo left to save: not pushed as a repo, not recursed into.
		if (deadGitfile(fullPath)) continue;
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

		if (deadGitfile(root)) continue;
		if (existsSync(join(root, ".git"))) {
			out.push(root);
		} else {
			walkFolder(root, 1, maxDepth, out);
		}
	}
	return Array.from(new Set(out)).toSorted();
}
