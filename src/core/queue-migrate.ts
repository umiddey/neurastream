import { existsSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Config } from "./config.ts";
import { applyQueueEnv } from "./queue/env.ts";
import { gitTop, readIndex } from "./queue/lib.ts";

// One index (20261024_1400_one_index): fold the old two-level layout into the main index. Every
// repo directory the main index still lists has its INDEX.md plan lines moved into the main index
// and the repo INDEX.md deleted. Idempotent: with plan lines only, nothing changes. A plan still
// inside a linked worktree is reported, not moved.
export function queueMigrate(args: string[], cfg: Config): number {
	applyQueueEnv(cfg);
	const index = cfg.paths.queue_index;
	if (!existsSync(index)) {
		console.log(`queue migrate: ${index} does not exist; nothing to migrate`);
		return 0;
	}
	const lines = readIndex(index);
	const dirs = lines.filter(l => {
		try {
			return statSync(l).isDirectory();
		} catch {
			return false;
		}
	});
	if (dirs.length === 0) {
		console.log(`queue migrate: ${index} lists plans only; nothing to migrate`);
		return 0;
	}
	const kept: string[] = [];
	let folded = 0;
	for (const l of lines) {
		if (!dirs.includes(l)) {
			kept.push(l);
			continue;
		}
		const repoIndex = path.join(l, "INDEX.md");
		if (!existsSync(repoIndex)) {
			console.log(`queue migrate: ${l} lists no INDEX.md; its line is dropped`);
			continue;
		}
		folded++;
		kept.push(...readIndex(repoIndex));
		rmSync(repoIndex);
	}
	const unique = [...new Set(kept)];
	writeFileSync(index, unique.length ? `${unique.join("\n")}\n` : "");
	console.log(`queue migrate: ${index} now lists ${unique.length} plan(s); folded ${folded} repo INDEX.md file(s)`);
	for (const p of unique) {
		const g = gitTop(p);
		if (g && g.top !== g.repo) console.log(`queue migrate: ${p} still lives in the linked worktree ${g.top}; move it to the main checkout ${g.repo}`);
	}
	return 0;
}
