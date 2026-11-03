// `neurastream wip restore [<worktree>]` (plan 20261027_1130 P7): lists one worktree's hidden saves,
// newest first, and restores one into the worktree. A dirty worktree is snapshotted first, so the
// restore can never discard work done since the save; the new ref is printed.

import { existsSync, realpathSync } from "node:fs";
import type { Config } from "./config.ts";
import { cmd } from "./proc.ts";
import { keyOf } from "./wip-roots.ts";
import { wipSnapshot } from "./wip-snapshot.ts";

/** One hidden save of a worktree, as its commit message and diff describe it. */
export interface WipSave {
	/** The `YYYYMMDD-HHMM` stamp: the ref's last segment, and the order key. */
	at: string;
	ref: string;
	commit: string;
	/** The branch the worktree was on when the save ran. */
	branch: string;
	/** Paths the save changed against the branch head it was made on. */
	changed: number;
	/** New files the save refused: too big, or a secret path. */
	skipped: number;
}

export function wipSaves(wt: string, home: string): WipSave[] {
	const key = keyOf(wt, home);
	const r = cmd(["git", "-C", wt, "for-each-ref", "--sort=-refname", "--format=%(objectname) %(refname)", `refs/wip/${key}/`]);
	if (r.code !== 0) return [];
	const saves: WipSave[] = [];
	for (const line of r.stdout.split("\n").filter(Boolean)) {
		const [commit, ref] = line.split(" ");
		if (!commit || !ref) continue;
		const subject = cmd(["git", "-C", wt, "log", "-1", "--format=%s", commit]).stdout.trim();
		const m = /\(([^)]*)\); skipped (\d+) new files/.exec(subject);
		const diff = cmd(["git", "-C", wt, "diff", "--name-only", `${commit}^`, commit]);
		saves.push({
			at: ref.slice(ref.lastIndexOf("/") + 1),
			ref,
			commit,
			branch: m?.[1] ?? "detached",
			changed: diff.code === 0 ? diff.stdout.split("\n").filter(Boolean).length : 0,
			skipped: m ? Number(m[2]) : 0,
		});
	}
	// The stamp is the order key; refname sort already agrees, and this keeps it true if it does not.
	return saves.toSorted((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

/**
 * List the saves of `[<worktree>]`, or with `--pick N` restore the Nth of that newest-first list.
 * Returns the runner's exit code: 0 listed/restored, 1 git refused, 2 bad usage.
 */
export function wipRestore(args: string[], cfg: Config, cwd: string = process.cwd()): number {
	const pickAt = args.indexOf("--pick");
	const pick = pickAt >= 0 ? args[pickAt + 1] : undefined;
	if (pickAt >= 0 && pick === undefined) {
		console.error("usage: neurastream wip restore [<worktree>] [--pick N]");
		return 2;
	}
	// The value of --pick is not a worktree; with no --pick at all, -1 never matches an index.
	const pickValueAt = pickAt >= 0 ? pickAt + 1 : -1;
	const target = args.find((a, i) => !a.startsWith("--") && i !== pickValueAt) ?? cwd;
	if (!existsSync(target)) {
		console.error(`neurastream wip: ${target} does not exist`);
		return 2;
	}
	const wt = realpathSync(target);
	const saves = wipSaves(wt, cfg.paths.home);
	if (saves.length === 0) {
		console.log(`wip: no saves for ${wt} yet`);
		return 0;
	}
	if (pick === undefined) {
		saves.forEach((save, i) => {
			const skipped = save.skipped ? `, ${save.skipped} skipped big files` : "";
			console.log(`${i + 1}. ${save.at} [${save.branch}] ${save.changed} changed paths${skipped} — ${save.ref}`);
		});
		console.log(`restore one: neurastream wip restore ${wt} --pick N`);
		return 0;
	}
	const n = Number(pick);
	if (!Number.isInteger(n) || n < 1 || n > saves.length) {
		console.error(`neurastream wip: --pick takes 1..${saves.length}`);
		return 2;
	}
	const save = saves[n - 1]!;
	// Nothing may be lost: uncommitted changes are saved — and the ref printed — before the restore.
	if (cmd(["git", "-C", wt, "status", "--porcelain"]).stdout.trim() !== "") {
		wipSnapshot(["--quiet"], cfg);
		const newest = wipSaves(wt, cfg.paths.home)[0];
		if (newest) console.log(`saved ${newest.ref} before restoring`);
	}
	// The commit, not the ref: a save made in this same minute reuses the stamp and moves the ref.
	const r = cmd(["git", "-C", wt, "restore", `--source=${save.commit}`, "--worktree", "--", "."]);
	if (r.code !== 0) {
		console.error(`neurastream wip: git restore failed${r.stderr.trim() ? `: ${r.stderr.trim()}` : ""}`);
		return 1;
	}
	console.log(`restored ${save.ref} into ${wt}`);
	return 0;
}
