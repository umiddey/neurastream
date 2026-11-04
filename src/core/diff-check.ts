// P6 (plan 20261024_1915): the removal check. Comments that speak of removal ("removed", "no
// longer", "previously") lie once the code they describe is gone, so an added comment line
// matching labels.removal_comment_patterns is flagged, and a commit whose subject matches
// labels.removal_subjects flags every added non-blank line. Pure deletions pass. A config regex
// that does not compile is skipped (write-check.ts's fail-open note convention: a broken pattern
// never blocks a commit). The plan-guard commit gate (guards.ts subRules) scans the staged diff
// through here; `neurastream diff-check` (src/cli/diff-check.ts) scans --staged or one commit.

import { execFileSync } from "node:child_process";
import type { Config } from "./config.ts";

export interface RemovalFlag {
	file: string;
	line: number;
	text: string;
}

// An added line that reads as a comment: //, # (shell/py/yaml/ruby), /* or a * block
// continuation, or an HTML comment.
const COMMENT_LINE = /^\s*(\/\/|#+|\/\*+|\*+|<!--)/;
// Hunk header: the new-file start of `@@ -a,b +c,d @@` (an extra @ covers combined diffs).
const HUNK = /^@+ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @+/;

// Every pattern that compiles; the rest are skipped silently (fail-open), never thrown.
function compiled(patterns: unknown): RegExp[] {
	const out: RegExp[] = [];
	if (!Array.isArray(patterns)) return out;
	for (const p of patterns) {
		if (typeof p !== "string" || p === "") continue;
		try {
			out.push(new RegExp(p));
		} catch { /* a pattern that does not compile checks nothing (write-check.ts:126) */ }
	}
	return out;
}

/**
 * The added non-blank lines of a unified diff the removal check flags: comment lines matching
 * labels.removal_comment_patterns, and — when `subject` matches labels.removal_subjects — every
 * added non-blank line. Removed and context lines never flag; an empty subject (a staged diff has
 * no commit yet) skips the subject match.
 */
export function removalFlags(diff: string, subject: string, cfg: Config): RemovalFlag[] {
	const comments = compiled(cfg.labels.removal_comment_patterns);
	const removal = subject !== "" && compiled(cfg.labels.removal_subjects).some(re => re.test(subject));
	if (!removal && comments.length === 0) return [];
	const flags: RemovalFlag[] = [];
	let file = "";
	let line = 0;
	for (const raw of diff.split("\n")) {
		if (raw.startsWith("diff --git ")) {
			file = "";
			line = 0;
			continue;
		}
		// The post-image header names the file (renames included); /dev/null means a pure deletion.
		// A content line that happens to start with "+++ " but names neither falls through to the
		// added-line branch below.
		if (raw.startsWith("+++ ")) {
			const p = raw.slice(4);
			if (p.startsWith("b/") || p === "/dev/null") {
				file = p.startsWith("b/") ? p.slice(2) : p;
				line = 0;
				continue;
			}
		}
		const hunk = HUNK.exec(raw);
		if (hunk) {
			line = Number(hunk[1]) - 1;
			continue;
		}
		if (!raw.startsWith("+")) {
			// "-" removed lines and "\ No newline" carry no new-file line number; context (" ") does.
			if (raw.startsWith(" ")) line += 1;
			continue;
		}
		const text = raw.slice(1);
		const isComment = COMMENT_LINE.test(text);
		if (text.trim() !== "" && (removal || (isComment && comments.some(re => re.test(text)))))
			flags.push({ file, line: line + 1, text });
		line += 1;
	}
	return flags;
}

/** `git diff --staged` in `dir`. Throws when git fails; callers pick their failure mode (the guard fails open, the CLI reports). maxBuffer is generous: a staged lockfile diff must not truncate the scan. */
export function stagedDiff(dir: string): string {
	return execFileSync("git", ["diff", "--staged"], { cwd: dir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
}

/** One commit's patch (`git show`) with its subject line, for removalFlags. Throws when git fails. */
export function commitDiff(dir: string, rev: string): { diff: string; subject: string } {
	const subject = execFileSync("git", ["log", "-1", "--format=%s", rev], { cwd: dir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }).trim();
	const diff = execFileSync("git", ["show", "--format=", "--patch", "--no-ext-diff", rev], { cwd: dir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
	return { diff, subject };
}
