import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import type { Config } from "./config.ts";
import { applyQueueEnv } from "./queue/env.ts";
import { activePlans, queueProblems, queueSummary, readIndex, readPlans, REPO_INDEX } from "./queue/lib.ts";

export function queueCheck(args: string[], cfg: Config): number {
	applyQueueEnv(cfg);
	if (args.includes("--priority-ids")) {
		for (const p of activePlans()) if (p.priorityId && !p.waiting && p.status === "open") console.log(p.priorityId);
		return 0;
	}
	function git(repo: string, ...gargs: string[]): boolean {
		try {
			execFileSync("git", ["-C", repo, ...gargs], { stdio: "ignore" });
			return true;
		} catch {
			return false;
		}
	}
	const index = readIndex();
	const extra: string[] = [];
	for (const repo of index) {
		if (!git(repo, "rev-parse", "--git-dir")) continue;
		if (git(repo, "ls-files", "--error-unmatch", REPO_INDEX))
			extra.push(`${repo}: ${REPO_INDEX} is tracked by git; it never goes into git (git rm --cached ${REPO_INDEX})`);
		else if (!git(repo, "check-ignore", "-q", "--no-index", REPO_INDEX))
			extra.push(`${repo}: ${REPO_INDEX} is not git-ignored; add "/${REPO_INDEX}" to ${repo}/.git/info/exclude`);
	}
	for (const root of cfg.paths.work_roots) {
		let dirs: string[] = [];
		try {
			dirs = readdirSync(root);
		} catch {}
		for (const d of dirs) {
			const repo = path.join(root, d);
			if (!index.includes(repo) && readPlans(repo).length)
				extra.push(`${repo}: ${REPO_INDEX} lists plans but the repo is not in the main index (add it, or empty the repo index)`);
		}
	}
	console.log(queueSummary());
	if (extra.length) console.log(`More problems:\n${extra.map(e => `  - ${e}`).join("\n")}`);
	return queueProblems().length || extra.length ? 1 : 0;
}
