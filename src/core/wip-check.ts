import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { Config } from "./config.ts";
import { nowSec } from "./clock.ts";
import { printText } from "./help.ts";
import { pyFixedWidth } from "./pyfmt.ts";
import { gitText } from "./proc.ts";

function repos(roots: string[]): string[] {
	const out: string[] = [];
	for (const root of roots) {
		if (!existsSync(root) || !statSync(root).isDirectory()) continue;
		for (const d of readdirSync(root)) {
			const repo = join(root, d);
			if (existsSync(join(repo, ".git"))) out.push(repo);
		}
	}
	out.sort();
	return out;
}

export function wipCheck(args: string[], cfg: Config): number {
	let limit = cfg.wip.limit;
	if (args.includes("--limit")) limit = Number(args[args.indexOf("--limit") + 1]);
	const days = args.includes("--all") ? 1_000_000 : cfg.wip.days;
	const now = nowSec();
	const seen = new Set<string>();
	const unlanded: { ts: number; name: string; br: string; sha: string; n: number }[] = [];
	const dirty: { wt: string; n: number }[] = [];

	for (const repo of repos(cfg.paths.work_roots)) {
		if (!statSync(repo).isDirectory()) continue;
		const commonRaw = gitText(repo, ["rev-parse", "--git-common-dir"]) || ".";
		// resolve, not join: a linked worktree's common dir comes back absolute (os.path.join keeps it).
		const common = realpathSync(resolve(repo, commonRaw));
		if (seen.has(common)) continue;
		seen.add(common);
		const url = gitText(repo, ["config", "remote.origin.url"]);
		const name = url ? basename(url).replace(/\.git$/, "") : basename(repo);
		const refs = gitText(repo, ["for-each-ref", "--format=%(refname:short)\t%(committerdate:unix)\t%(objectname:short)", "refs/heads"]);
		for (const line of refs.split("\n").filter(Boolean)) {
			const [br, tsRaw, sha] = line.split("\t");
			if (!br || !tsRaw || !sha) continue;
			const ts = Number(tsRaw);
			if (now - ts > days * 86400) continue;
			const nRaw = gitText(repo, ["rev-list", "--count", br, "--not", "--remotes"]);
			const n = Number(nRaw);
			if (nRaw && n > 0) unlanded.push({ ts, name, br, sha, n });
		}
		let wt: string | null = null;
		const porcelain = gitText(repo, ["worktree", "list", "--porcelain"]);
		for (const line of porcelain === "" ? [] : porcelain.split("\n")) {
			if (line.startsWith("worktree ")) wt = line.slice(9);
			else if (line === "bare") wt = null;
			else if (line === "" && wt) wt = null;
			if (wt && line.startsWith("HEAD") && existsSync(wt) && statSync(wt).isDirectory()) {
				const st = gitText(wt, ["status", "--porcelain", "--untracked-files=no"]);
				if (st) dirty.push({ wt, n: st.split("\n").filter(l => l !== "").length });
			}
		}
	}

	// Python sorts (ts, name, br, sha, n) tuples descending; ties on ts fall through to the next field.
	const cmp = (x: string | number, y: string | number): number => (x < y ? -1 : x > y ? 1 : 0);
	unlanded.sort((a, b) => cmp(b.ts, a.ts) || cmp(b.name, a.name) || cmp(b.br, a.br) || cmp(b.sha, a.sha) || cmp(b.n, a.n));
	printText(`UNLANDED branches (commits on no remote): ${unlanded.length}  limit ${limit}`);
	for (const row of unlanded) {
		const age = pyFixedWidth((now - row.ts) / 3600, 1, 6);
		printText(`  ${row.name.padEnd(32, " ")} ${row.br.padEnd(48, " ")} ${row.sha} +${String(row.n).padEnd(3, " ")} ${age}h old`);
	}
	printText(`DIRTY worktrees (uncommitted tracked changes): ${dirty.length}`);
	for (const row of dirty) printText(`  ${row.wt}  ${row.n} files`);
	if (unlanded.length > limit) {
		printText("WIP OVER LIMIT: land, push or close branches before starting new work.");
		return 1;
	}
	return 0;
}
