import { copyFileSync, existsSync, lstatSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Config } from "./config.ts";
import { nowSec, strftime } from "./clock.ts";
import { printText } from "./help.ts";
import { pyFloatStr } from "./pyfmt.ts";
import { cmd } from "./proc.ts";
import { failureLine, gitOrFail, realpathOrFail, recordWipRun } from "./wip-fail.ts";
import { keyOf, wipRepos } from "./wip-roots.ts";

const DAY_MS = 86_400_000;

/** Midnight of a `YYYYMMDD-HHMM` save stamp, in ms since the epoch. */
function dayStart(stamp: string): number {
	const parts = /^(\d{4})(\d{2})(\d{2})/.exec(stamp);
	return parts ? Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3])) : Number.NaN;
}

/** The saves to delete: everything but the newest `keepHourly` and the newest of each of the last `keepDays` days. */
function staleOf(refs: string[], keepHourly: number, keepDays: number): string[] {
	const keep = new Set<string>([refs[refs.length - 1]!]);
	for (const ref of refs.slice(-Math.max(1, keepHourly))) keep.add(ref);
	const days = new Set<string>();
	for (let i = refs.length - 1; i >= 0 && days.size < Math.max(1, keepDays); i--) {
		const ref = refs[i]!;
		const day = ref.slice(ref.lastIndexOf("/") + 1, ref.lastIndexOf("/") + 9);
		if (days.has(day)) continue;
		days.add(day);
		keep.add(ref);
	}
	return refs.filter(ref => !keep.has(ref));
}

/**
 * Keeps refs/wip small: per worktree the newest `keep_hourly` saves plus one per day for
 * `keep_days`, and a vanished worktree's saves until `keep_days` after its last save.
 */
export function pruneWip(cfg: Config, failed: string[] = [], repos: string[] = wipRepos(cfg)): void {
	const today = dayStart(strftime(nowSec(), "%Y%m%d"));
	for (const repo of repos) {
		const list = gitOrFail(failed, repo, ["worktree", "list", "--porcelain"]);
		if (!list) continue;
		const live = new Set<string>();
		for (const line of list.stdout.split("\n")) {
			if (line.startsWith("worktree ")) live.add(keyOf(line.slice(9), cfg.paths.home));
		}
		const all = gitOrFail(failed, repo, ["for-each-ref", "--sort=refname", "--format=%(refname)", "refs/wip"]);
		if (!all) continue;
		const byKey = new Map<string, string[]>();
		for (const ref of all.stdout.split("\n").filter(Boolean)) {
			const rest = ref.slice("refs/wip/".length);
			const slash = rest.indexOf("/");
			if (slash < 1) continue;
			const key = rest.slice(0, slash);
			byKey.set(key, [...(byKey.get(key) ?? []), ref]);
		}
		for (const [key, refs] of byKey) {
			const newest = refs[refs.length - 1]!;
			const age = (today - dayStart(newest.slice(newest.lastIndexOf("/") + 1))) / DAY_MS;
			const doomed = live.has(key)
				? staleOf(refs, cfg.wip.keep_hourly, cfg.wip.keep_days)
				: Number.isFinite(age) && age <= cfg.wip.keep_days
					? []
					: refs;
			for (const ref of doomed) gitOrFail(failed, repo, ["update-ref", "-d", ref]);
		}
	}
}


function secretRx(pat: string): RegExp {
	let src = pat;
	let flags = "";
	if (src.startsWith("(?i)")) {
		src = src.slice(4);
		flags = "i";
	}
	return new RegExp(src, flags);
}

export function wipSnapshot(args: string[], cfg: Config): number {
	if (cfg.wip.roots.length === 0) {
		console.log("wip: no wip.roots set — run `neurastream wip add <path>`");
		recordWipRun(cfg, "snapshot", [], "no wip.roots set");
		return 0;
	}
	const quiet = args.includes("--quiet");
	const maxMb = cfg.wip.snapshot_max_mb;
	const secret = secretRx(cfg.wip.secret_file);
	const stamp = strftime(nowSec(), "%Y%m%d-%H%M");
	// git prints worktree paths resolved (macOS: /var → /private/var), so the home prefix must be resolved too.
	const home = existsSync(cfg.paths.home) ? realpathSync(cfg.paths.home) : cfg.paths.home;
	const homePrefix = home.endsWith("/") ? home : `${home}/`;
	const failed: string[] = [];
	const seen = new Map<string, string>();
	const worktrees: string[] = [];
	for (const repo of wipRepos(cfg)) {
		const commonRaw = gitOrFail(failed, repo, ["rev-parse", "--git-common-dir"]);
		if (!commonRaw) continue;
		const common = realpathOrFail(failed, resolve(repo, commonRaw.stdout || "."));
		if (common === null || seen.has(common)) continue;
		seen.set(common, repo);
		const list = gitOrFail(failed, repo, ["worktree", "list", "--porcelain"]);
		if (!list) continue;
		for (const line of list.stdout.split("\n")) {
			if (line.startsWith("worktree ") && existsSync(line.slice(9)) && statSync(line.slice(9)).isDirectory()) {
				worktrees.push(line.slice(9));
			}
		}
	}

	const saved: { wt: string; br: string; n: number; sk: number; ref: string }[] = [];
	let same = 0;
	for (const wt of worktrees) {
		const head = gitOrFail(failed, wt, ["rev-parse", "--verify", "HEAD"]);
		if (!head) continue;
		const st = gitOrFail(failed, wt, ["status", "--porcelain"]);
		if (!st || !st.stdout) continue;
		const gitdir = gitOrFail(failed, wt, ["rev-parse", "--absolute-git-dir"]);
		if (!gitdir) continue;
		const tmp = mkdtempSync(join(tmpdir(), "wip-snap-"));
		try {
			const idx = join(tmp, "index");
			if (existsSync(join(gitdir.stdout, "index"))) copyFileSync(join(gitdir.stdout, "index"), idx);
			const env = { ...process.env, GIT_INDEX_FILE: idx };
			const addAll = cmd(["git", "-C", wt, "add", "-u"], { env });
			if (addAll.code) {
				failed.push(failureLine(wt, "git add -u", addAll.stderr));
				continue;
			}
			const untracked = gitOrFail(failed, wt, ["ls-files", "-o", "--exclude-standard", "-z"], env);
			if (!untracked) continue;
			const keep: string[] = [];
			let skipped = 0;
			for (const p of untracked.stdout.split("\0").filter(Boolean)) {
				const fp = join(wt, p);
				let big = false;
				try {
					const lst = lstatSync(fp);
					big = !lst.isSymbolicLink() && lst.isFile() && lst.size > maxMb * 2 ** 20;
				} catch {
					big = false;
				}
				if (secret.test(p) || big) skipped += 1;
				else keep.push(p);
			}
			if (keep.length) {
				const addNew = cmd(["git", "-C", wt, "add", "--pathspec-from-file=-", "--pathspec-file-nul"], {
					env,
					input: Buffer.from(keep.join("\0")),
				});
				if (addNew.code) {
					failed.push(failureLine(wt, "git add --pathspec-from-file=- --pathspec-file-nul", addNew.stderr));
					continue;
				}
			}
			const tree = gitOrFail(failed, wt, ["write-tree"], env);
			if (!tree) continue;
			const headTree = gitOrFail(failed, wt, ["rev-parse", "HEAD^{tree}"]);
			if (!headTree) continue;
			if (tree.stdout === headTree.stdout) continue;
			const key = wt.replaceAll(homePrefix, "").replaceAll("/", "_");
			const lastRef = gitOrFail(failed, wt, ["for-each-ref", "--sort=-refname", "--count=1", "--format=%(objectname)", `refs/wip/${key}/`]);
			if (!lastRef) continue;
			if (lastRef.stdout) {
				const lastTree = gitOrFail(failed, wt, ["rev-parse", `${lastRef.stdout}^{tree}`]);
				if (!lastTree) continue;
				if (lastTree.stdout === tree.stdout) {
					same += 1;
					continue;
				}
			}
			const branch = gitOrFail(failed, wt, ["branch", "--show-current"]);
			if (!branch) continue;
			const message = `wip-snapshot ${stamp} ${wt} (${branch.stdout || "detached"}); skipped ${skipped} new files > ${pyFloatStr(maxMb)}MB`;
			const commit = gitOrFail(failed, wt, ["commit-tree", tree.stdout, "-p", head.stdout, "-m", message]);
			if (!commit) continue;
			if (!gitOrFail(failed, wt, ["update-ref", `refs/wip/${key}/${stamp}`, commit.stdout])) continue;
			saved.push({
				wt,
				br: branch.stdout || "detached",
				n: st.stdout.split("\n").filter(l => l !== "").length,
				sk: skipped,
				ref: `refs/wip/${key}/${stamp}`,
			});
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	}

	// Only repos this run already resolved: a corrupt one was reported once and keeps that line.
	pruneWip(cfg, failed, [...seen.values()]);

	const wc = cmd(["wip-check"]).stdout;
	const lines = [
		`# WIP status ${strftime(nowSec(), "%Y-%m-%d %H:%M")}`,
		"",
		`Snapshot: ${saved.length} new, ${same} unchanged since last, ${failed.length} failed.`,
		"",
		"Every uncommitted change is saved as a hidden commit (refs/wip/...); nothing in the",
		"worktrees changed. Restore one: `git -C <worktree> restore --source=<ref> --worktree -- .`.",
		"",
	];
	for (const row of saved) {
		lines.push(`- ${row.wt} [${row.br}] ${row.n} changed paths -> \`${row.ref}\`${row.sk ? ` (${row.sk} big new files NOT saved)` : ""}`);
	}
	for (const line of failed) lines.push(`- ${line}`);
	lines.push("", "```", wc.replace(/\s+$/, ""), "```", "");
	writeFileSync(cfg.wip.status_log, lines.join("\n"));
	if (!quiet) printText(lines.slice(0, 8 + saved.length + failed.length).join("\n"));
	return recordWipRun(cfg, "snapshot", failed) ? 0 : 1;
}
