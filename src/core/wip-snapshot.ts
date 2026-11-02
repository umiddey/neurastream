import { copyFileSync, existsSync, lstatSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Config } from "./config.ts";
import { nowSec, strftime } from "./clock.ts";
import { printText } from "./help.ts";
import { pyFloatStr } from "./pyfmt.ts";
import { cmd } from "./proc.ts";
import { failureLine, gitOrFail, realpathOrFail, recordWipRun } from "./wip-fail.ts";
import { wipRepos } from "./wip-roots.ts";


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
	const seen = new Set<string>();
	const worktrees: string[] = [];
	for (const repo of wipRepos(cfg)) {
		const commonRaw = gitOrFail(failed, repo, ["rev-parse", "--git-common-dir"]);
		if (!commonRaw) continue;
		const common = realpathOrFail(failed, resolve(repo, commonRaw.stdout || "."));
		if (common === null || seen.has(common)) continue;
		seen.add(common);
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
