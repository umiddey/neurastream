import { accessSync, constants, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Config } from "./config.ts";
import { nowSec, strftime } from "./clock.ts";
import { printText } from "./help.ts";
import { addIncident } from "./incidents.ts";
import { cmd, gitRaw } from "./proc.ts";
import { failureLine, gitOrFail, realpathOrFail, recordWipRun } from "./wip-fail.ts";
import { backupVisibility, originMatches, type Visibility } from "./wip-private.ts";
import { keyOf, wipRepos } from "./wip-roots.ts";

function executable(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}


export function wipBackup(
	args: string[],
	cfg: Config,
	visibility?: (target: string) => Visibility,
): number {
	if (cfg.wip.roots.length === 0) {
		console.log("wip: no wip.roots set — run `neurastream wip add <path>`");
		recordWipRun(cfg, "backup", [], "no wip.roots set");
		return 0;
	}
	// The target is checked first, on every run, even when there is nothing to push: a repo that
	// turned public must stop the upload before any ref is sent.
	const target = cfg.wip.backup_url;
	const state = target === "" ? "unknown" : (visibility ?? ((url: string) => backupVisibility(url, (a) => cmd(a), cfg.wip.private_check)))(target);
	if (target === "" || state !== "private") {
		const refused = target === "" ? "no wip.backup_url set" : `${target} is ${state}`;
		console.log(
			target === ""
				? "Backup stopped: no wip.backup_url set; nothing was uploaded."
				: `Backup stopped: ${refused}. Make it private; nothing was uploaded.`,
		);
		addIncident(cfg, {
			source: "watch",
			kind: "wip-backup-refused",
			summary: `wip backup refused: ${refused}`,
			evidence: `wip-backup ran at ${strftime(nowSec(), "%Y-%m-%d %H:%M")}`,
			fingerprint: `wip-backup-refused:${target}`,
		});
		recordWipRun(cfg, "backup", [], refused);
		return 1;
	}
	const dry = args.includes("--dry-run");
	const quiet = args.includes("--quiet");
	const seen = new Set<string>();
	const pushed: string[] = [];
	const skipped: string[] = [];
	const failed: string[] = [];

	for (const repo of wipRepos(cfg)) {
		const commonRaw = gitOrFail(failed, repo, ["rev-parse", "--git-common-dir"]);
		if (!commonRaw) continue;
		const common = realpathOrFail(failed, resolve(repo, commonRaw.stdout || "."));
		if (common === null || seen.has(common)) continue;
		seen.add(common);
		const du = cmd(["du", "-sm", common]);
		const mb = Number(du.stdout.split(/\s+/)[0] ?? "NaN");
		const rkeyWhole = keyOf(repo, cfg.paths.home);
		if (mb > cfg.wip.backup_max_repo_mb) {
			skipped.push(`${rkeyWhole}: whole repo (${mb} MB git dir > ${cfg.wip.backup_max_repo_mb} MB limit)`);
			continue;
		}
		const hooks = gitOrFail(failed, repo, ["rev-parse", "--git-path", "hooks"]);
		if (!hooks) continue;
		const prePush = join(repo, hooks.stdout, "pre-push");
		// No origin (exit 2) is normal: it only feeds the hook opt-in match; the push goes to wip.backup_url.
		const origin = gitRaw(repo, ["remote", "get-url", "origin"]).stdout;
		// Exact `host/owner` or `host/owner/repo` only: a substring would opt in every repo at once.
		const noHooks = cfg.wip.backup_hook_off.some(entry => originMatches(entry, origin));
		if (executable(prePush) && !noHooks) {
			skipped.push(`${rkeyWhole}: whole repo (has a pre-push gate; not bypassed — add its origin to wip.backup_hook_off to back it up)`);
			continue;
		}
		const shallow = gitOrFail(failed, repo, ["rev-parse", "--is-shallow-repository"]);
		if (!shallow) continue;
		if (shallow.stdout === "true") {
			skipped.push(`${rkeyWhole}: whole repo (shallow clone; GitHub refuses it)`);
			continue;
		}
		const top = gitOrFail(failed, repo, ["worktree", "list", "--porcelain"]);
		if (!top) continue;
		const mainWt = top.stdout ? top.stdout.split("\n")[0]!.slice(9) : repo;
		const rkey = keyOf(mainWt, cfg.paths.home);
		const specs: { src: string; dst: string }[] = [];
		const heads = gitOrFail(failed, repo, ["for-each-ref", "--format=%(refname)", "refs/heads"]);
		if (!heads) continue;
		for (const ref of heads.stdout.split("\n").filter(Boolean)) {
			// Full refname and a trailing `--`: a branch named like an existing file (ops/x) is not
			// "ambiguous argument" — that failure must not drop the branch from the backup.
			const n = gitOrFail(failed, repo, ["rev-list", "--count", ref, "--not", "--remotes", "--"]);
			if (!n) continue;
			if (/^\d+$/.test(n.stdout) && Number(n.stdout) > 0) {
				const branch = ref.slice("refs/heads/".length);
				specs.push({ src: ref, dst: `refs/heads/${rkey}/${branch}` });
			}
		}
		const wips = gitOrFail(failed, repo, ["for-each-ref", "--sort=-refname", "--format=%(refname)", "refs/wip"]);
		if (!wips) continue;
		const newest: Record<string, string> = {};
		for (const r of wips.stdout.split("\n").filter(Boolean)) {
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
			failed.push(failureLine(repo, `git push --quiet ${cfg.wip.backup_url} ${ok.join(" ")}`, pushedRun.stderr));
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
	return recordWipRun(cfg, "backup", failed, null, skipped.length) ? 0 : 1;
}
