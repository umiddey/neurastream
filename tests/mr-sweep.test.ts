import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { forgeOf, mentioned, mrSweep, remoteHost, type CommandRunner } from "../src/core/mr-sweep.ts";

const TMP = mkdtempSync(path.join(tmpdir(), "mr-sweep-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

function plan(status: "open" | "complete", body = ""): string {
	return `# fixture\n\n## Progress\nStatus: ${status}\n${body}\n`;
}

function plant(dir: string, origin: string | null, text: string, name = "pm"): { index: string; repo: string } {
	const repo = path.join(TMP, dir, name);
	mkdirSync(path.join(repo, "docs/plans"), { recursive: true });
	const init = spawnSync("git", ["init", "-q", "-b", "main"], { cwd: repo, encoding: "utf8" });
	if (init.status !== 0) throw new Error(init.stderr || "git init");
	if (origin) {
		const add = spawnSync("git", ["remote", "add", "origin", origin], { cwd: repo, encoding: "utf8" });
		if (add.status !== 0) throw new Error(add.stderr || "git remote");
	}
	const file = path.join(repo, "docs/plans/20261026_1530_fixture.md");
	writeFileSync(file, text);
	const index = path.join(TMP, dir, "INDEX.md");
	writeFileSync(index, `${file}\n`);
	return { index, repo };
}

function runner(stdout: string, calls: { args: string[]; cwd?: string }[] = [], code = 0, missing = false): CommandRunner {
	return (args, opts) => {
		calls.push({ args, cwd: opts.cwd });
		return { code, stdout, stderr: code === 0 ? "" : "401 Unauthorized", missing };
	};
}

const GL = (iid: number, branch: string) => JSON.stringify([{ iid, source_branch: branch, title: "t", state: "opened" }]);
const GH = (n: number, branch: string) => JSON.stringify([{ number: n, headRefName: branch, title: "t" }]);

test("remote host and forge come from the origin URL", () => {
	expect(remoteHost("git@gitlab.com:group/pm.git")).toBe("gitlab.com");
	expect(remoteHost("https://gitlab.example:8443/group/pm.git")).toBe("gitlab.example");
	expect(remoteHost("ssh://git@github.com/acme/pm.git")).toBe("github.com");
	expect(forgeOf("gitlab.example")).toBe("gitlab");
	expect(forgeOf("github.com")).toBe("github");
	expect(forgeOf("git.example.com")).toBeNull();
});

test("an open MR whose token and branch are absent is untracked", () => {
	const calls: { args: string[]; cwd?: string }[] = [];
	const { index, repo } = plant("untracked", "https://gitlab.example/group/pm.git", plan("open", "no mention here"));
	const sweep = mrSweep({ index, runner: runner(GL(206, "feat/lost"), calls) });
	expect(calls[0]?.args.slice(0, 3)).toEqual(["glab", "mr", "list"]);
	expect(calls[0]?.cwd).toBe(repo);
	expect(sweep.fail).toBe(true);
	expect(sweep.lines).toContain(`UNTRACKED MR !206 pm ${repo} (feat/lost) — no open plan mentions it`);
});

test("!N in an open plan of the same repo tracks the MR", () => {
	const { index, repo } = plant("token", "https://gitlab.example/group/pm.git", plan("open", "opened as !206"));
	const sweep = mrSweep({ index, runner: runner(GL(206, "feat/lost")) });
	expect(sweep.fail).toBe(false);
	expect(sweep.lines).toContain(`tracked MR !206 pm ${repo} (feat/lost)`);
	expect(sweep.lines.join("\n")).not.toContain("UNTRACKED");
});

test("the source branch name in an open plan tracks the MR", () => {
	const { index, repo } = plant("branch", "https://gitlab.example/group/pm.git", plan("open", "branch feat/lost is the work"));
	const sweep = mrSweep({ index, runner: runner(GL(206, "feat/lost")) });
	expect(sweep.fail).toBe(false);
	expect(sweep.lines).toContain(`tracked MR !206 pm ${repo} (feat/lost)`);
});

test("MR !N: ignored counts as tracked", () => {
	const { index } = plant("ignored", "https://gitlab.example/group/pm.git", plan("open", "MR !206: ignored (pre-neurastream stray)"));
	const sweep = mrSweep({ index, runner: runner(GL(206, "feat/stray")) });
	expect(sweep.fail).toBe(false);
	expect(sweep.mrs[0]?.tracked).toBe(true);
	expect(sweep.lines.join("\n")).not.toContain("UNTRACKED");
});

test("a github origin dispatches gh and tracks #N", () => {
	const calls: { args: string[]; cwd?: string }[] = [];
	const { index, repo } = plant("gh", "git@github.com:acme/pm.git", plan("open", "see #12"));
	const sweep = mrSweep({ index, runner: runner(GH(12, "feat/gh"), calls) });
	expect(calls[0]?.args.slice(0, 3)).toEqual(["gh", "pr", "list"]);
	expect(sweep.fail).toBe(false);
	expect(sweep.lines).toContain(`tracked MR #12 pm ${repo} (feat/gh)`);
	const missed = mrSweep({ index, runner: runner(GH(13, "feat/other")) });
	expect(missed.fail).toBe(true);
	expect(missed.lines).toContain(`UNTRACKED MR #13 pm ${repo} (feat/other) — no open plan mentions it`);
});

test("unknown forge, no origin, and a non-repo path skip without calling a forge CLI", () => {
	const calls: { args: string[] }[] = [];
	const { index, repo } = plant("unknown", "https://git.example.com/acme/pm.git", plan("open"));
	const unknown = mrSweep({ index, runner: runner("[]", calls) });
	expect(calls).toEqual([]);
	expect(unknown.fail).toBe(false);
	expect(unknown.lines).toContain(`mr-sweep: skipped ${repo} (unknown forge)`);

	const bare = plant("noremote", null, plan("open"), "bare");
	const noOrigin = mrSweep({ index: bare.index, runner: runner("[]", calls) });
	expect(calls).toEqual([]);
	expect(noOrigin.lines).toContain(`mr-sweep: skipped ${bare.repo} (no origin remote)`);

	const outside = path.join(TMP, "notgit");
	mkdirSync(path.join(outside, "docs"), { recursive: true });
	const file = path.join(outside, "docs/p.md");
	writeFileSync(file, plan("open"));
	const loose = path.join(TMP, "notgit-index.md");
	writeFileSync(loose, `${file}\n`);
	const notGit = mrSweep({ index: loose, runner: runner("[]", calls) });
	expect(calls).toEqual([]);
	expect(notGit.lines.some(l => l.includes("not a git repo"))).toBe(true);
});

test("a missing CLI skips and does not fail; a non-zero CLI exit is unreachable, not zero MRs", () => {
	const { index, repo } = plant("missing", "https://gitlab.example/group/pm.git", plan("open"));
	const missing = mrSweep({ index, runner: () => ({ code: 127, stdout: "", stderr: "not found", missing: true }) });
	expect(missing.fail).toBe(false);
	expect(missing.lines).toContain("mr-sweep: skipped (no forge CLI)");
	expect(missing.lines.join("\n")).not.toContain("UNTRACKED");

	const auth = mrSweep({ index, runner: () => ({ code: 1, stdout: "", stderr: "401 Unauthorized" }) });
	expect(auth.fail).toBe(false);
	expect(auth.lines).toContain(`mr-sweep: skipped ${repo} (forge unreachable)`);
	expect(auth.lines.join("\n")).not.toContain("UNTRACKED");
	expect(auth.lines.join("\n")).not.toContain("no forge CLI");
});

test("an empty index exits the sweep with nothing to report", () => {
	const index = path.join(TMP, "empty.md");
	writeFileSync(index, "");
	const sweep = mrSweep({ index, runner: () => ({ code: 0, stdout: "[]", stderr: "" }) });
	expect(sweep.fail).toBe(false);
	expect(sweep.lines).toEqual([]);
	expect(sweep.mrs).toEqual([]);
});

test("a mention in another repo, a longer number, or a complete plan does not track", () => {
	expect(mentioned("!206", "feat/lost", ["see !2060 and !20"])).toBe(false);
	expect(mentioned("!206", "feat/lost", ["MR !206: ignored (stale)"])).toBe(true);

	const repoA = path.join(TMP, "split", "a");
	const repoB = path.join(TMP, "split", "b");
	for (const repo of [repoA, repoB]) {
		mkdirSync(path.join(repo, "docs/plans"), { recursive: true });
		spawnSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
		spawnSync("git", ["remote", "add", "origin", "https://gitlab.example/group/pm.git"], { cwd: repo });
	}
	const fileA = path.join(repoA, "docs/plans/a.md");
	const fileB = path.join(repoB, "docs/plans/b.md");
	writeFileSync(fileA, plan("open", "nothing"));
	writeFileSync(fileB, plan("open", "!206 lives in the other repo"));
	const openIndex = path.join(TMP, "split", "INDEX.md");
	writeFileSync(openIndex, `${fileA}\n${fileB}\n`);
	const split = mrSweep({ index: openIndex, runner: runner(GL(206, "feat/lost")) });
	expect(split.mrs.find(m => m.repo === repoA)?.tracked).toBe(false);
	expect(split.mrs.find(m => m.repo === repoB)?.tracked).toBe(true);

	const { index } = plant("closed", "https://gitlab.example/group/pm.git", plan("complete", "!206 and feat/lost"));
	const closed = mrSweep({ index, runner: runner(GL(206, "feat/lost")) });
	expect(closed.fail).toBe(true);
	expect(closed.lines.join("\n")).toContain("UNTRACKED MR !206");
});
