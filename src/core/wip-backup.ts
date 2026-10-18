import { accessSync, constants, existsSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { Config } from "./config.ts";
import { nowSec, strftime } from "./clock.ts";
import { printText } from "./help.ts";
import { cmd, gitRaw } from "./proc.ts";

function executable(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function keyOf(path: string, home: string): string {
	return relative(home, path).replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
}

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

export function wipBackup(args: string[], cfg: Config): number {
	const dry = args.includes("--dry-run");
	const quiet = args.includes("--quiet");
	const seen = new Set<string>();
	const pushed: string[] = [];
	const skipped: string[] = [];
	const failed: string[] = [];

	for (const repo of repos(cfg.paths.work_roots)) {
		const commonRaw = gitRaw(repo, ["rev-parse", "--git-common-dir"]).stdout || ".";
		const common = realpathSync(join(repo, commonRaw));
		if (seen.has(common)) continue;
		seen.add(common);
		const du = cmd(["du", "-sm", common]);
		const mb = Number(du.stdout.split(/\s+/)[0] ?? "NaN");
		const rkeyWhole = keyOf(repo, cfg.paths.home);
		if (mb > cfg.wip.backup_max_repo_mb) {
			skipped.push(`${rkeyWhole}: whole repo (${mb} MB git dir > ${cfg.wip.backup_max_repo_mb} MB limit)`);
			continue;
		}
		const hooks = gitRaw(repo, ["rev-parse", "--git-path", "hooks"]).stdout;
		const prePush = join(repo, hooks, "pre-push");
		const origin = gitRaw(repo, ["remote", "get-url", "origin"]).stdout;
		const noHooks = cfg.wip.backup_hook_off.some(n => origin.includes(n));
		if (executable(prePush) && !noHooks) {
			skipped.push(`${rkeyWhole}: whole repo (has a pre-push gate; not bypassed)`);
			continue;
		}
		if (gitRaw(repo, ["rev-parse", "--is-shallow-repository"]).stdout === "true") {
			skipped.push(`${rkeyWhole}: whole repo (shallow clone; GitHub refuses it)`);
			continue;
		}
		const top = gitRaw(repo, ["worktree", "list", "--porcelain"]).stdout;
		const mainWt = top ? top.split("\n")[0]!.slice(9) : repo;
		const rkey = keyOf(mainWt, cfg.paths.home);
		const specs: { src: string; dst: string }[] = [];
		const heads = gitRaw(repo, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]).stdout;
		for (const b of heads.split("\n").filter(Boolean)) {
			const n = gitRaw(repo, ["rev-list", "--count", b, "--not", "--remotes"]).stdout;
			if (/^\d+$/.test(n) && Number(n) > 0) specs.push({ src: `refs/heads/${b}`, dst: `refs/heads/${rkey}/${b}` });
		}
		const wips = gitRaw(repo, ["for-each-ref", "--sort=-refname", "--format=%(refname)", "refs/wip"]).stdout;
		const newest: Record<string, string> = {};
		for (const r of wips.split("\n").filter(Boolean)) {
			const prefix = r.slice(0, r.lastIndexOf("/"));
			if (!(prefix in newest)) newest[prefix] = r;
		}
		for (const [prefix, r] of Object.entries(newest)) {
			const parts = prefix.split("/");
			specs.push({ src: r, dst: `refs/heads/wip/${parts[2] ?? ""}` });
		}
		const ok: string[] = [];
		for (const spec of specs) {
			const gate = cmd([cfg.wip.secret_gate, "scan", repo, spec.src]);
			if (gate.code !== 0) skipped.push(`${rkey}: ${spec.src} (secret pattern in unpushed commits)`);
			else ok.push(`+${spec.src}:${spec.dst}`);
		}
		if (ok.length === 0) continue;
		if (dry) {
			pushed.push(...ok.map(s => `${rkey}: ${s}`));
			continue;
		}
		const hookOff = noHooks ? ["-c", "core.hooksPath=/dev/null"] : [];
		const pushedRun = cmd(["git", "-C", repo, ...hookOff, "push", "--quiet", cfg.wip.backup_url, ...ok]);
		if (pushedRun.code) {
			failed.push(`${rkey}: ${pushedRun.stderr.trim().slice(-200)}`);
		} else {
			pushed.push(...ok.map(s => `${rkey}: ${s}`));
		}
	}

	const stamp = strftime(nowSec(), "%Y-%m-%d %H:%M");
	const lines = [
		`# WIP backup ${stamp}${dry ? " (dry run)" : ""}`,
		"",
		`Target: ${cfg.wip.backup_url} (private). Refs pushed: ${pushed.length}, skipped: ${skipped.length}, repos failed: ${failed.length}.`,
		"",
		"Restore a branch: `git fetch " + cfg.wip.backup_url + " '<repo-key>/<branch>:<branch>'`",
		"",
	];
	if (skipped.length) lines.push("## Skipped", ...skipped.map(s => `- ${s}`), "");
	if (failed.length) lines.push("## Failed", ...failed.map(s => `- ${s}`), "");
	lines.push("## Pushed", ...pushed.map(s => `- ${s}`));
	if (!dry) writeFileSync(cfg.wip.backup_log, `${lines.join("\n")}\n`);
	printText((quiet ? lines.slice(0, 6) : lines).join("\n"));
	return failed.length ? 1 : 0;
}
