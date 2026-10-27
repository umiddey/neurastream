import { copyFileSync, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Config } from "./config.ts";
import { nowSec, strftime } from "./clock.ts";
import { printText } from "./help.ts";
import { pyFloatStr } from "./pyfmt.ts";
import { cmd, gitRaw } from "./proc.ts";

function repos(roots: string[]): string[] {
	const out: string[] = [];
	for (const root of roots) {
		if (!existsSync(root) || !statSync(root).isDirectory()) continue;
		for (const d of readdirSync(root)) {
			if (existsSync(join(root, d, ".git"))) out.push(join(root, d));
		}
	}
	out.sort();
	return out;
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
	const quiet = args.includes("--quiet");
	const maxMb = cfg.wip.snapshot_max_mb;
	const secret = secretRx(cfg.wip.secret_file);
	const stamp = strftime(nowSec(), "%Y%m%d-%H%M");
	const homePrefix = cfg.paths.home.endsWith("/") ? cfg.paths.home : `${cfg.paths.home}/`;
	const seen = new Set<string>();
	const worktrees: string[] = [];
	for (const repo of repos(cfg.paths.work_roots)) {
		const commonRaw = gitRaw(repo, ["rev-parse", "--git-common-dir"]).stdout || ".";
		const common = realpathSync(resolve(repo, commonRaw));
		if (seen.has(common)) continue;
		seen.add(common);
		const out = gitRaw(repo, ["worktree", "list", "--porcelain"]).stdout;
		for (const line of out.split("\n")) {
			if (line.startsWith("worktree ") && existsSync(line.slice(9)) && statSync(line.slice(9)).isDirectory()) {
				worktrees.push(line.slice(9));
			}
		}
	}

	const saved: { wt: string; br: string; n: number; sk: number; ref: string }[] = [];
	let same = 0;
	const failed: string[] = [];
	for (const wt of worktrees) {
		const head = gitRaw(wt, ["rev-parse", "--verify", "HEAD"]);
		if (head.code) continue;
		const st = gitRaw(wt, ["status", "--porcelain"]);
		if (st.code || !st.stdout) continue;
		const gitdir = gitRaw(wt, ["rev-parse", "--absolute-git-dir"]).stdout;
		const tmp = mkdtempSync(join(tmpdir(), "wip-snap-"));
		try {
			const idx = join(tmp, "index");
			if (existsSync(join(gitdir, "index"))) copyFileSync(join(gitdir, "index"), idx);
			const env = { ...process.env, GIT_INDEX_FILE: idx };
			cmd(["git", "-C", wt, "add", "-u"], { env });
			const untracked = gitRaw(wt, ["ls-files", "-o", "--exclude-standard", "-z"], env).stdout;
			const keep: string[] = [];
			let skipped = 0;
			for (const p of untracked.split("\0").filter(Boolean)) {
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
				cmd(["git", "-C", wt, "add", "--pathspec-from-file=-", "--pathspec-file-nul"], {
					env,
					input: Buffer.from(keep.join("\0")),
				});
			}
			const tree = gitRaw(wt, ["write-tree"], env);
			if (tree.code) {
				failed.push(wt);
				continue;
			}
			const headTree = gitRaw(wt, ["rev-parse", "HEAD^{tree}"]).stdout;
			if (tree.stdout === headTree) continue;
			const key = wt.replaceAll(homePrefix, "").replaceAll("/", "_");
			const last = gitRaw(wt, ["for-each-ref", "--sort=-refname", "--count=1", "--format=%(objectname)", `refs/wip/${key}/`]).stdout;
			if (last) {
				const lastTree = gitRaw(wt, ["rev-parse", `${last}^{tree}`]).stdout;
				if (lastTree === tree.stdout) {
					same += 1;
					continue;
				}
			}
			const branch = gitRaw(wt, ["branch", "--show-current"]).stdout;
			const message = `wip-snapshot ${stamp} ${wt} (${branch || "detached"}); skipped ${skipped} new files > ${pyFloatStr(maxMb)}MB`;
			const commit = gitRaw(wt, ["commit-tree", tree.stdout, "-p", head.stdout, "-m", message]);
			if (commit.code || gitRaw(wt, ["update-ref", `refs/wip/${key}/${stamp}`, commit.stdout]).code) {
				failed.push(wt);
				continue;
			}
			saved.push({
				wt,
				br: branch || "detached",
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
	for (const wt of failed) lines.push(`- FAILED: ${wt}`);
	lines.push("", "```", wc.replace(/\s+$/, ""), "```", "");
	writeFileSync(cfg.wip.status_log, lines.join("\n"));
	if (!quiet) printText(lines.slice(0, 8 + saved.length + failed.length).join("\n"));
	return failed.length ? 1 : 0;
}
