import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Config } from "./config.ts";
import { queueClose } from "./queue-close.ts";
import {
	activePlans,
	banLine,
	cancelledFile,
	cancelledMatches,
	cancelPending,
	cancelPendingPath,
	repoRoot,
} from "./queue/lib.ts";

/** Internal control-flow error thrown by `die()` so `queueCancel` returns exit code 1 cleanly without killing the process. */
class AbortCancel extends Error {}

/**
 * Record a cancelled plan, global/repo never-do rule, or false-positive cancellation dismissal.
 *
 * Args:
 *     args (string[]): CLI arguments for `queue-cancel`
 *     cfg (Config): Loaded neurastream configuration
 *
 * Returns:
 *     number: Exit code (`0` succeeded, `1` refused, or child `queue-close` exit code)
 */
export function queueCancel(args: string[], cfg: Config): number {
	const STATE_DIR = cfg.paths.queue_state;
	const CANCEL_PENDING = cancelPendingPath(cfg.paths);
	const GLOBAL_CANCELLED = cfg.paths.cancelled;
	const today = new Date().toISOString().slice(0, 10);
	function die(msg: string): never {
		console.error(`queue-cancel: REFUSED: ${msg}`);
		throw new AbortCancel(msg);
	}
	function clearPending(how: string) {
		const p = cancelPending(cfg.paths);
		mkdirSync(STATE_DIR, { recursive: true });
		appendFileSync(path.join(STATE_DIR, "cancel.log"), `${new Date().toISOString()} ${how}${p ? ` (flagged message: ${p.words})` : ""}\n`);
		rmSync(CANCEL_PENDING, { force: true });
	}
	const usage = 'usage: queue-cancel <plan> "<owner words>" | --never "<what>" "<owner words>" [--repo <repo>] | --not-a-cancel "<why>"';
	try {
	if (args[0] === "--not-a-cancel") {
		const why = (args[1] ?? "").trim();
		// Only a message main-guard flagged needs an answer; a bare call is a wasted round.
		if (!cancelPending(cfg.paths)) die("nothing is flagged: main-guard did not see cancel words, so there is nothing to record");
		if (why.length < 10) die(`say why the message was no cancel (at least 10 characters). ${usage}`);
		clearPending(`not a cancel: ${why}`);
		console.log("queue-cancel: noted, not a cancel");
		return 0;
	}

	if (args[0] === "--never") {
		const [what = "", owner = ""] = [args[1]?.trim(), args[2]?.trim()];
		const ri = args.indexOf("--repo");
		const repoArg = ri > 0 ? args[ri + 1] : null;
		if (what.length < 10) die(`describe the work that must not be done (at least 10 characters). ${usage}`);
		if ((owner ?? "").trim().length < 3) die(`quote the owner's words. ${usage}`);
		const line = banLine(what, owner, today);
		const wordsTail = line.split("words: ")[1];
		if (line.endsWith("words: ") || !wordsTail || wordsTail.split(" ").length < 2)
			die(`"${what}" has fewer than 2 key words; name the work concretely (files, feature, action)`);
		let list = GLOBAL_CANCELLED;
		let repo: string | null = null;
		if (repoArg) {
			repo = repoRoot(path.resolve(repoArg));
			if (!repo) die(`${repoArg} is not inside a git repo`);
			list = cancelledFile(repo);
		}
		const before = existsSync(list) ? readFileSync(list, "utf8") : null;
		mkdirSync(path.dirname(list), { recursive: true });
		const header = "# Work the owner cancelled (one line each; written by queue-close/queue-cancel, read by queue-check/main-guard)\n";
		writeFileSync(list, `${before ?? header}${before && !before.endsWith("\n") ? "\n" : ""}${line}\n`);
		console.log(`queue-cancel: recorded in ${list}: ${line}`);
		if (repo) {
			const rel = path.relative(repo, list);
			spawnSync("git", ["-C", repo, "add", "--", rel]);
			const c = spawnSync("git", ["-C", repo, "commit", "-q", "-m", `chore(plans): owner cancelled: ${what.slice(0, 60)}`, "--", rel], { stdio: "inherit" });
			console.log(c.status === 0 ? `queue-cancel: committed in ${repo}; push it with the usual rules` : `queue-cancel: WARNING commit failed (hooks above); the line is in the file and already enforced, commit it later`);
		}
		clearPending(`never: ${line}`);
		for (const p of activePlans(cfg.paths)) if (cancelledMatches(p, cfg.paths).some(c => line.startsWith(`- ${c.name} `)))
			console.log(`queue-cancel: open plan ${p.file} matches it and is now refused; cancel it too: queue-cancel ${p.file} "${owner}"`);
		return 0;
	}

	const [planArg, owner = ""] = args;
	if (!planArg || planArg.startsWith("-")) die(usage);
	const file = path.resolve(planArg);
	const plan = activePlans(cfg.paths).find(p => p.file === file);
	if (!plan) die(`${file} is not an indexed plan; for work without a plan use --never`);
	if (owner.trim().length < 3) die(`quote the owner's words. ${usage}`);
	let text = readFileSync(file, "utf8");
	if (!/^Status:\s*\S+\s*$/m.test(text)) die(`${file} has no "Status:" line`);
	text = text.replace(/^Status:\s*\S+\s*$/m, `Status: cancelled\nCancelled by owner: ${today} ${owner.trim().replace(/\n/g, " ")}`);
	writeFileSync(file, text);
	clearPending(`plan: ${file}`);
	return queueClose([file], cfg);
	} catch (e) {
		if (e instanceof AbortCancel) return 1;
		throw e;
	}
}
