import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, fstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Config } from "./config.ts";
import { applyQueueEnv } from "./queue/env.ts";
import { activePlans, cancelledFile, cancelledLine, closeLog, finishedEntry, finishedPath, gitOut as git, INDEX, landed, prependFinished, sha, STATE_DIR, writeIndex } from "./queue/lib.ts";
import { fixedIncident } from "./incidents.ts";

// P4 (plan 20261031_0911): the landing check lives in queue/lib.ts (queueProblems' landed lock
// shares it, and lib cannot import this closer back); re-exported here per the plan.
export { landed };

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
	// A clone of a clone judges "landed" against the middle copy's default branch, which can be
	// stale. Follow local-path origins (at most 3 hops) to the upstream repo and fetch its default
	// branch: that commit is the base. No local origin: the existing base, unchanged.
	function upstreamBase(repo: string, localBase: string): string {
		let cur = repo;
		let hops = 0;
		while (hops < 3) {
			const url = git(cur, "config", "--get", "remote.origin.url").out;
			if (!url || !path.isAbsolute(url) || !existsSync(url) || !git(url, "rev-parse", "--git-dir").ok) break;
			cur = url;
			hops++;
		}
		if (hops === 0) return localBase;
		const named = git(cur, "symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD").out.replace(/^origin\//, "");
		const def = named || git(cur, "symbolic-ref", "-q", "--short", "HEAD").out;
		const fetched = git(repo, "fetch", "-q", cur, def);
		if (fetched.ok) return git(repo, "rev-parse", "FETCH_HEAD").out;
		// The remote's default branch can be gone upstream (renamed, pruned): fall back to the
		// local base ref, then the local main branch, instead of refusing every close.
		const local = git(repo, "rev-parse", "-q", "--verify", localBase);
		if (local.ok) return local.out;
		const fallback = git(repo, "rev-parse", "-q", "--verify", "refs/heads/main");
		if (fallback.ok) return fallback.out;
		die(`could not fetch ${def} from ${cur}: ${fetched.out}`);
	}
	const today = new Date().toISOString().slice(0, 10);

	// --auto (plan 20261031_0911 P4): autoClose starts the closer for an OPEN plan whose branch has
	// landed; the done check decides, and a pass writes "Status: complete" here, nobody else.
	const auto = args[0] === "--auto";
	const arg = auto ? args[1] : args[0];
	if (arg === "-h" || arg === "--help") {
		console.log("usage: queue-close [--auto] <plan file>");
		return 0;
	}
	if (!arg) die("usage: queue-close [--auto] <plan file>");
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
	if (!plan) die(`${file} is not listed in the main index ${INDEX}`);
	if (plan.errors.length) die(`plan does not match the template: ${plan.errors.join("; ")}`);
	if (plan.status !== "complete" && plan.status !== "cancelled" && !(auto && plan.status === "open"))
		die(`plan says "Status: ${plan.status}", not complete or cancelled`);
	const cancelling = plan.status === "cancelled";
	if (plan.worktree && (plan.file === plan.worktree || plan.file.startsWith(`${plan.worktree}/`))) {
		// The plan file may sit under the named worktree when that worktree IS the main checkout
		// (the main checkout is every plan's repo); only a linked worktree is refused.
		let linked = true;
		try { linked = realpathSync(plan.worktree) !== realpathSync(plan.repo); } catch {}
		if (linked) die("the indexed plan file lives inside its worktree; index the copy in the main checkout");
	}

	git(plan.repo, "fetch", "-q", "origin");
	const head = git(plan.repo, "symbolic-ref", "-q", "refs/remotes/origin/HEAD");
	const base = upstreamBase(plan.repo, head.ok ? head.out : "refs/remotes/origin/main");
	// git reports worktree paths through symlinks resolved (macOS: /tmp -> /private/tmp); match resolved paths on both sides.
	const real = (p: string): string => { try { return realpathSync(p); } catch { return path.resolve(p); } };
	const worktrees = (): { path: string; branch: string | null; head: string; main: boolean }[] => {
		const list: { path: string; branch: string | null; head: string; main: boolean }[] = [];
		for (const line of git(plan.repo, "worktree", "list", "--porcelain").out.split("\n")) {
			if (line.startsWith("worktree ")) list.push({ path: real(line.slice(9)), branch: null, head: "", main: list.length === 0 });
			const cur = list.at(-1);
			if (!cur) continue;
			if (line.startsWith("HEAD ")) cur.head = line.slice(5);
			else if (line.startsWith("branch refs/heads/")) cur.branch = line.slice(18);
		}
		return list;
	};
	const wtEntry = plan.worktree ? worktrees().find(w => w.path === real(plan.worktree!)) : undefined;
	const wtExists = !!plan.worktree && existsSync(plan.worktree);
	// A plan worktree is the plan's only while it sits on the plan's branch (or a detached HEAD already merged into it).
	const owned = wtExists && !!plan.branch && !!wtEntry && (wtEntry.branch !== null
		? wtEntry.branch === plan.branch
		: git(plan.repo, "merge-base", "--is-ancestor", wtEntry.head, `refs/heads/${plan.branch}`).ok);
	if (wtExists && !owned) console.log(`queue-close: worktree ${plan.worktree} kept: it is on ${wtEntry?.branch ?? (wtEntry ? "a detached HEAD" : "no branch of this repo")}`);
	const branch = plan.branch;
	const branchExists = !!branch && git(plan.repo, "rev-parse", "--verify", "-q", `refs/heads/${branch}`).ok;
	const merged = branchExists && landed(plan.repo, branch!, base, readFileSync(file, "utf8"));

	// A plan whose worktree is missing or kept is checked against the upstream base, never a foreign checkout.
	const detached = !!plan.worktree && !owned;
	const runIn = owned ? plan.worktree! : plan.repo;
	if (!cancelling) {
		const tip = branchExists ? git(plan.repo, "rev-parse", `refs/heads/${branch}`).out : "";
		const dirty = detached ? `base:${base}` : git(runIn, "status", "--porcelain").out;
		const doneKey = sha(`${plan.doneCheck}\n${tip}\n${dirty}`);
		const doneCache = path.join(STATE_DIR, `done-ok-${sha(file)}`);
		const cached = existsSync(doneCache) && readFileSync(doneCache, "utf8").trim() === doneKey;
		if (cached) console.log(`queue-close: done check passed before for this state (cached ${doneKey})`);
		else {
			let scratch: string | undefined;
			if (detached) {
				// A shared clone of the base, deliberately NOT a registered worktree: it never shows up
				// in `git worktree list` and can be dropped with a plain delete when it stays clean.
				scratch = mkdtempSync(path.join(STATE_DIR, "done-base-"));
				const add = git(plan.repo, "clone", "-q", "--shared", ".", scratch) && git(scratch, "checkout", "-q", "--detach", base);
				if (!add.ok) {
					rmSync(scratch, { recursive: true, force: true });
					die(`could not check out ${base} for the done check: ${add.out}`);
				}
			}
			console.log(`queue-close: done check in ${detached ? `${base} (temporary worktree)` : runIn}: ${plan.doneCheck}`);
			const dc = spawnSync("bash", ["-lc", plan.doneCheck!], { cwd: scratch ?? runIn, stdio: "inherit", timeout: 3600_000 });
			if (scratch) {
				// Whatever the check left behind stays: a dirty scratch is kept for inspection, a clean
				// one equals the base commit and is deleted outright.
				if (git(scratch, "status", "--porcelain").out) console.log(`queue-close: kept the check scratch ${scratch}: the done check left changes in it`);
				else rmSync(scratch, { recursive: true, force: true });
			}
			if (dc.status !== 0) {
				rmSync(doneCache, { force: true });
				if (!auto) {
					const text = readFileSync(file, "utf8")
						.replace(/^Status:\s*complete\s*$/m, "Status: open")
						.replace(/^(## Progress[^\n]*\n(?:Status:[^\n]*\n)?)/m, `$1- ${today} queue-close: done check failed (exit ${dc.status ?? "timeout"}); reopened.\n`);
					writeFileSync(file, text);
					die(`done check failed (exit ${dc.status ?? "timeout"}); plan reopened (Status: open)`);
				}
				// --auto keeps the open plan as it is — no reopen text; the refusal lands in the close
				// log for the landed lock (P5) to report, and the cache is dropped so the next attempt
				// reruns the check.
				die(`done check failed (exit ${dc.status ?? "timeout"})`);
			}
			writeFileSync(doneCache, `${doneKey}\n`);
		}
	}

	// --auto on an open plan: the done check just passed, so this close writes "Status: complete"
	// itself and everything below proceeds as for any complete plan.
	if (auto && plan.status === "open")
		writeFileSync(file, readFileSync(file, "utf8").replace(/^Status:\s*open\s*$/m, "Status: complete"));

	if (branchExists && !merged && !cancelling) {
		result(`queue-close: AWAITING merge: done check green; branch ${branch} is not merged into ${base} yet, plan stays indexed until it lands`);
		return 4;
	}

	const cutoff = Date.now() / 1000 - ARCHIVE_DAYS * 86400;
	for (const line of git(plan.repo, "for-each-ref", "--format=%(refname) %(creatordate:unix)", "refs/queue-archive/").out.split("\n")) {
		const [ref, t] = line.split(" ");
		if (ref && Number(t) < cutoff) git(plan.repo, "update-ref", "-d", ref);
	}
	// One plan = one worktree (20261024_1400_one_index): a successful close removes the plan's
	// worktree with a plain `git worktree remove`, only when it is clean and its branch landed.
	// Dirty, unmerged, unremovable worktrees and main checkouts are kept and the reason printed.
	// Nothing is ever forced: no --force, no rm -rf, no branch -D, no uncommitted work destroyed.
	const list = worktrees();
	const named = wtExists && owned ? list.find(w => w.path === real(plan.worktree!)) : undefined;
	// The plan's worktrees: the one it names plus any registered worktree on the plan's branch.
	const mine = list.filter(w => (plan.branch && w.branch === plan.branch) || w === named);
	const landedOk = !branchExists || merged;
	for (const w of mine) {
		if (w.main) console.log(`queue-close: worktree ${w.path} kept: it is the repo's main checkout`);
		else if (git(w.path, "status", "--porcelain").out) console.log(`queue-close: worktree ${w.path} kept: it has uncommitted changes`);
		else if (!landedOk) console.log(`queue-close: worktree ${w.path} kept: branch ${branch} is not merged`);
		else {
			const rm = git(plan.repo, "worktree", "remove", w.path);
			if (!rm.ok || existsSync(w.path)) console.log(`queue-close: worktree ${w.path} kept: git worktree remove failed (${rm.out})`);
			else console.log(`queue-close: worktree ${w.path} removed`);
		}
	}
	if (branchExists) {
		const holder = worktrees().find(w => w.branch === branch);
		if (holder) console.log(`queue-close: branch ${branch} kept: checked out in ${holder.path}`);
		else {
			// git refuses -d when it cannot see the branch merged (a stale upstream hides the landing);
			// the branch then stays instead of being deleted behind git's back.
			const d = git(plan.repo, "branch", "-d", branch!);
			if (!d.ok) console.log(`queue-close: branch ${branch} kept: git would not delete it (${d.out.split("\n")[0]})`);
			else console.log(`queue-close: branch ${branch} deleted`);
		}
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
	if (!cancelling) {
		const listed = finishedPath();
		const added = prependFinished(finishedEntry(plan, dest, today));
		console.log(added ? `queue-close: recorded in ${listed}` : `queue-close: already in ${listed}`);
	}

	// One index: the closed plan's line leaves the main index; there is no repo INDEX.md.
	const lines = readFileSync(INDEX, "utf8").split("\n").filter(l => l.trim());
	const keep = lines.filter(l => path.resolve(l.trim().replace(/^[-*]\s+/, "").replace(/`/g, "").replace(/^~(?=\/)/, os.homedir())) !== file);
	writeIndex(keep, { removed: cancelling ? "cancel" : "close" });
	console.log(`queue-close: removed from ${INDEX} (${keep.length} plan(s) left)`);
	try {
		const sp = path.join(STATE_DIR, "spawns.json");
		const s = JSON.parse(readFileSync(sp, "utf8"));
		delete s[file];
		writeFileSync(sp, JSON.stringify(s, null, 1));
	} catch {}
	// Incidents this plan fixes (plan P5): each INCIDENT <id> cited outside ## Progress gets a
	// fixed record, so the guards stop pushing a bug whose fix just shipped. Progress is
	// narrative, not fix work (I-20261031-349, P5b): an id Main only filed there ("needs a phase
	// here") was never fixed by a phase — it stays open and the close logs it. Cancelled plans
	// did not ship their fix — the owner records a dismissal instead. A refusal (unknown id,
	// already resolved) is logged into the close log and never fails the close.
	if (!cancelling) {
		// Cut ## Progress (until the next heading) before lifting ids: an id cited in the Goal or
		// a phase counts whether or not the INCIDENT keyword prefixes it; an id whose only
		// citation sits in Progress does not.
		let inProgress = false;
		const body = plan.text.split("\n").filter(l => {
			if (l.startsWith("## ")) inProgress = l.trim() === "## Progress";
			return !inProgress;
		}).join("\n");
		const ids = new Set([...body.matchAll(/\bI-\d{8}-\d+\b/g)].map(m => m[0]));
		for (const id of new Set([...plan.text.matchAll(/\bINCIDENT\s+(I-\d{8}-\d+)\b/g)].map(m => m[1]!)))
			if (!ids.has(id)) result(`queue-close: still open: ${id} (cited only in ## Progress)`);
		const recorded: string[] = [];
		// A plan may cite one incident several times; record it once so the second citation is not a refusal.
		for (const id of ids) {
			const why = fixedIncident(cfg, id, file);
			if (why) result(`queue-close: not recording fixed for ${id}: ${why}`);
			else recorded.push(id);
		}
		if (recorded.length) console.log(`queue-close: recorded fixed for ${recorded.join(", ")}`);
	}
	console.log("queue-close: CLOSED");
	return 0;
}
