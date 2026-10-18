import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, fstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Config } from "./config.ts";
import { applyQueueEnv } from "./queue/env.ts";
import { activePlans, cancelledFile, cancelledLine, closeLog, INDEX, readIndex, readRepoIndex, REPO_INDEX, sha, STATE_DIR } from "./queue/lib.ts";

export function queueClose(args: string[], cfg: Config): number {
	applyQueueEnv(cfg);
	const ARCHIVE_DAYS = cfg.queue.archive_days;

	let resultLog: string | null = null;
	function result(line: string) {
		console.error(line);
		if (!resultLog) return;
		try {
			if (existsSync(resultLog) && fstatSync(2).ino === statSync(resultLog).ino) return;
			appendFileSync(resultLog, `--- ${new Date().toISOString()} manual run\n${line}\n`);
		} catch {}
	}
	function die(msg: string): never {
		result(`queue-close: REFUSED: ${msg}`);
		process.exit(1);
	}
	function git(cwd: string, ...gargs: string[]): { ok: boolean; out: string } {
		const r = spawnSync("git", ["-C", cwd, ...gargs], { encoding: "utf8" });
		return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
	}
	function squashMerged(repo: string, ref: string, base: string): boolean {
		const mb = git(repo, "merge-base", ref, base);
		if (!mb.ok) return false;
		const probe = git(repo, "commit-tree", `${ref}^{tree}`, "-p", mb.out, "-m", "queue-close squash probe");
		if (probe.ok && git(repo, "cherry", base, probe.out).out.startsWith("-")) return true;
		const files = git(repo, "diff", "--name-only", mb.out, ref);
		if (!files.ok || !files.out) return false;
		return git(repo, "diff", "--quiet", ref, base, "--", ...files.out.split("\n")).ok;
	}
	function writeLines(file: string, lines: string[]) {
		if (lines.length) writeFileSync(file, `${lines.join("\n")}\n`);
		else rmSync(file, { force: true });
	}
	const today = new Date().toISOString().slice(0, 10);

	const arg = args[0];
	if (!arg) die("usage: queue-close <plan file>");
	const file = path.resolve(arg);
	resultLog = closeLog(file);

	mkdirSync(STATE_DIR, { recursive: true });
	const lock = path.join(STATE_DIR, `close-${sha(file)}.lock`);
	try {
		const pid = Number(readFileSync(lock, "utf8"));
		if (pid && pid !== process.pid) {
			process.kill(pid, 0);
			console.error(`queue-close: already running for ${file} (pid ${pid})`);
			return 3;
		}
	} catch {}
	writeFileSync(lock, String(process.pid));
	process.on("exit", () => rmSync(lock, { force: true }));

	const plan = activePlans().find(p => p.file === file);
	if (!plan) die(`${file} is not listed in any repo INDEX.md of a repo in ${INDEX}`);
	if (plan.errors.length) die(`plan does not match the template: ${plan.errors.join("; ")}`);
	if (plan.status !== "complete" && plan.status !== "cancelled") die(`plan says "Status: ${plan.status}", not complete or cancelled`);
	const cancelling = plan.status === "cancelled";
	if (plan.worktree && (plan.file === plan.worktree || plan.file.startsWith(`${plan.worktree}/`)))
		die("the indexed plan file lives inside its worktree; index the copy in the main checkout");

	git(plan.repo, "fetch", "-q", "origin");
	const head = git(plan.repo, "symbolic-ref", "-q", "refs/remotes/origin/HEAD");
	const base = head.ok ? head.out : "refs/remotes/origin/main";
	const wtExists = !!plan.worktree && existsSync(plan.worktree);
	let branch = plan.branch;
	if (wtExists) branch ??= git(plan.worktree!, "rev-parse", "--abbrev-ref", "HEAD").out;
	const branchExists = !!branch && git(plan.repo, "rev-parse", "--verify", "-q", `refs/heads/${branch}`).ok;
	const merged = branchExists && (
		git(plan.repo, "merge-base", "--is-ancestor", `refs/heads/${branch}`, base).ok ||
		squashMerged(plan.repo, `refs/heads/${branch}`, base)
	);

	const runIn = wtExists ? plan.worktree! : plan.repo;
	if (!cancelling) {
		const tip = branchExists ? git(plan.repo, "rev-parse", `refs/heads/${branch}`).out : "";
		const dirty = git(runIn, "status", "--porcelain").out;
		const doneKey = sha(`${plan.doneCheck}\n${tip}\n${dirty}`);
		const doneCache = path.join(STATE_DIR, `done-ok-${sha(file)}`);
		const cached = existsSync(doneCache) && readFileSync(doneCache, "utf8").trim() === doneKey;
		if (cached) console.log(`queue-close: done check passed before for this state (cached ${doneKey})`);
		else {
			console.log(`queue-close: done check in ${runIn}: ${plan.doneCheck}`);
			const dc = spawnSync("bash", ["-lc", plan.doneCheck!], { cwd: runIn, stdio: "inherit", timeout: 3600_000 });
			if (dc.status !== 0) {
				rmSync(doneCache, { force: true });
				const text = readFileSync(file, "utf8")
					.replace(/^Status:\s*complete\s*$/m, "Status: open")
					.replace(/^(## Progress[^\n]*\n(?:Status:[^\n]*\n)?)/m, `$1- ${today} queue-close: done check failed (exit ${dc.status ?? "timeout"}); reopened.\n`);
				writeFileSync(file, text);
				die(`done check failed (exit ${dc.status ?? "timeout"}); plan reopened (Status: open)`);
			}
			writeFileSync(doneCache, `${doneKey}\n`);
		}
	}

	if (branchExists && !merged && !cancelling) {
		result(`queue-close: AWAITING merge: done check green; branch ${branch} is not merged into ${base} yet, plan stays indexed until it lands`);
		return 4;
	}

	const cutoff = Date.now() / 1000 - ARCHIVE_DAYS * 86400;
	for (const line of git(plan.repo, "for-each-ref", "--format=%(refname) %(creatordate:unix)", "refs/queue-archive/").out.split("\n")) {
		const [ref, t] = line.split(" ");
		if (ref && Number(t) < cutoff) git(plan.repo, "update-ref", "-d", ref);
	}
	if (wtExists) {
		const saved = git(plan.worktree!, "stash", "create", `queue-close: uncommitted work of ${path.basename(file)}`).out;
		if (saved) {
			const ref = `refs/queue-archive/${path.basename(file, ".md")}-${today}`;
			if (!git(plan.repo, "update-ref", ref, saved).ok || !git(plan.repo, "stash", "show", "-p", ref).out)
				die(`could not save the worktree's uncommitted changes to ${ref}; nothing removed`);
			console.log(`queue-close: uncommitted changes saved as ${ref} (restore: git -C ${plan.repo} stash apply ${ref}; pruned after ${ARCHIVE_DAYS} days)`);
		}
	}
	if (branchExists && !merged) {
		const tip = git(plan.repo, "rev-parse", `refs/heads/${branch}`).out;
		const keep = git(plan.repo, "commit-tree", `${tip}^{tree}`, "-p", tip, "-m", `queue-close: branch ${branch} of cancelled ${path.basename(file)}`);
		const ref = `refs/queue-archive/${path.basename(file, ".md")}-${today}-branch`;
		if (!keep.ok || !git(plan.repo, "update-ref", ref, keep.out).ok) die(`could not save branch ${branch} to ${ref}; nothing removed`);
		console.log(`queue-close: branch ${branch} saved as ${ref} (restore: git -C ${plan.repo} branch ${branch} ${ref}^; pruned after ${ARCHIVE_DAYS} days)`);
	}
	if (wtExists) {
		let rm = git(plan.repo, "worktree", "remove", "--force", plan.worktree!);
		if (!rm.ok && /Permission denied/.test(rm.out)) {
			spawnSync("docker", ["run", "--rm", "-v", `${plan.worktree}:/w`, "alpine", "chown", "-R", `${os.userInfo().uid}:${os.userInfo().gid}`, "/w"], { stdio: "ignore" });
			rm = git(plan.repo, "worktree", "remove", "--force", plan.worktree!);
			if (!rm.ok && existsSync(plan.worktree!)) {
				rmSync(plan.worktree!, { recursive: true, force: true });
				git(plan.repo, "worktree", "prune");
				rm = { ok: !existsSync(plan.worktree!), out: rm.out };
			}
		}
		if (!rm.ok) die(`could not remove worktree ${plan.worktree}: ${rm.out}`);
		console.log(`queue-close: worktree ${plan.worktree} removed`);
	}
	if (branchExists) {
		const d = git(plan.repo, "branch", "-D", branch!);
		if (!d.ok) die(`could not delete branch ${branch}: ${d.out}`);
		console.log(`queue-close: branch ${branch} deleted`);
	}

	const month = today.slice(0, 7).replace("-", "");
	const dest = path.join(path.dirname(file), "archive", month, path.basename(file));
	if (existsSync(dest)) die(`archive target already exists: ${dest}`);
	const top = git(path.dirname(file), "rev-parse", "--show-toplevel");
	const rel = top.ok ? path.relative(top.out, file) : "";
	if (top.ok) {
		const cur = git(top.out, "symbolic-ref", "-q", "--short", "HEAD").out;
		const behind = git(top.out, "merge-base", "--is-ancestor", "HEAD", base).ok && git(top.out, "rev-parse", "HEAD").out !== git(top.out, "rev-parse", base).out;
		if (cur && `refs/remotes/origin/${cur}` === base && behind) {
			const ff = git(top.out, "merge", "-q", "--ff-only", base);
			console.log(ff.ok ? `queue-close: ${top.out} fast-forwarded to ${base}` : `queue-close: WARNING could not fast-forward ${top.out} (${ff.out}); the archive commit may need a rebase before push`);
		}
	}
	const tracked = top.ok && git(top.out, "ls-files", "--error-unmatch", rel).ok;
	mkdirSync(path.dirname(dest), { recursive: true });
	const listFile = cancelledFile(plan.repo);
	const listBefore = existsSync(listFile) ? readFileSync(listFile, "utf8") : null;
	if (cancelling) {
		mkdirSync(path.dirname(listFile), { recursive: true });
		const header = "# Plans the owner cancelled (one line each; written by queue-close, read by queue-check/main-guard)\n";
		writeFileSync(listFile, `${listBefore ?? header}${listBefore && !listBefore.endsWith("\n") ? "\n" : ""}${cancelledLine(file, plan.text, today)}\n`);
		console.log(`queue-close: recorded in ${listFile}`);
	}
	const listRel = top.ok ? path.relative(top.out, listFile) : "";
	const listInside = cancelling && top.ok && !listRel.startsWith("..");
	if (tracked) {
		const destRel = path.relative(top.out, dest);
		const mv = git(top.out, "mv", rel, destRel);
		if (!mv.ok) die(`git mv failed: ${mv.out}`);
		if (listInside) git(top.out, "add", "--", listRel);
		const msg = cancelling ? `chore(plans): cancel ${path.basename(file)} (owner)` : `chore(plans): archive ${path.basename(file)} (done check passed)`;
		const c = spawnSync("git", ["-C", top.out, "commit", "-m", msg, "--", rel, destRel, ...(listInside ? [listRel] : [])], { stdio: "inherit" });
		if (c.status !== 0) {
			git(top.out, "mv", destRel, rel);
			if (cancelling) {
				if (listBefore === null) {
					git(top.out, "rm", "-q", "--cached", "--ignore-unmatch", "--", listRel);
					rmSync(listFile, { force: true });
				} else {
					writeFileSync(listFile, listBefore);
					git(top.out, "reset", "-q", "--", listRel);
				}
			}
			die("archive commit failed (hooks output above); plan moved back, nothing else changed");
		}
		console.log(`queue-close: plan archived and committed in ${top.out} (${git(top.out, "rev-parse", "--short", "HEAD").out}); push it with the usual rules`);
	} else {
		renameSync(file, dest);
		console.log(`queue-close: plan moved to ${dest}`);
	}

	const repoIndexFile = path.join(plan.repo, REPO_INDEX);
	const remaining = readRepoIndex(plan.repo).filter(p => p !== file);
	const rawLines = readFileSync(repoIndexFile, "utf8").split("\n").filter(l => l.trim());
	writeLines(
		repoIndexFile,
		rawLines.filter(l => path.resolve(plan.repo, l.trim().replace(/^[-*]\s+/, "").replace(/`/g, "")) !== file),
	);
	console.log(`queue-close: removed from ${repoIndexFile}${remaining.length ? ` (${remaining.length} plan(s) left)` : " (now empty: deleted)"}`);
	if (!remaining.length) {
		const lines = readFileSync(INDEX, "utf8").split("\n").filter(l => l.trim());
		const keep = lines.filter(l => path.resolve(l.trim().replace(/^[-*]\s+/, "").replace(/`/g, "").replace(/^~(?=\/)/, os.homedir())) !== plan.repo);
		writeFileSync(INDEX, keep.length ? `${keep.join("\n")}\n` : "");
		console.log(`queue-close: ${plan.repo} removed from ${INDEX} (${readIndex().length} repo(s) left)`);
	}
	try {
		const sp = path.join(STATE_DIR, "spawns.json");
		const s = JSON.parse(readFileSync(sp, "utf8"));
		delete s[file];
		writeFileSync(sp, JSON.stringify(s, null, 1));
	} catch {}
	console.log("queue-close: CLOSED");
	return 0;
}
