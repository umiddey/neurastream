// One index (plan 20261024_1400_one_index P3): `neurastream queue migrate` folds the old two-level
// layout — main index lists repos, each repo lists its plans — into the one main index of plan
// files, deletes the repo INDEX.md files, reports plans still inside a linked worktree instead of
// moving them, and is idempotent. `neurastream doctor` flags a main index that still lists repo
// directories. Behaviour only: which lines the index holds afterwards, which files exist.

import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const REPO = dirname(dirname(import.meta.path));
const ROOT = join(tmpdir(), "neurastream-home-queue-migrate");
const INSTALLED = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).version as string;

afterAll(() => {
	rmSync(ROOT, { recursive: true, force: true });
});

const GIT_ENV: NodeJS.ProcessEnv = {
	...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_") && !k.startsWith("QUEUE_"))),
	GIT_AUTHOR_NAME: "t",
	GIT_AUTHOR_EMAIL: "t@example.com",
	GIT_COMMITTER_NAME: "t",
	GIT_COMMITTER_EMAIL: "t@example.com",
};

function git(cwd: string, ...args: string[]): string {
	const r = spawnSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
	if (r.status !== 0) throw new Error(`git ${args.join(" ")} (in ${cwd}): ${r.stderr}`);
	return `${r.stdout}${r.stderr}`.trim();
}

function fresh(name: string): string {
	const dir = join(ROOT, name);
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	return dir;
}

function makeHome(dir: string): string {
	const home = join(dir, "home");
	mkdirSync(join(home, ".omp/agent"), { recursive: true });
	mkdirSync(join(home, ".config/neurastream"), { recursive: true });
	writeFileSync(
		join(home, ".config/neurastream/config.yml"),
		`paths:
  home: "${home}"
  queue_index: "${join(home, ".omp/agent/INDEX.md")}"
`,
	);
	return home;
}

function migrate(home: string) {
	const agent = join(home, ".omp/agent");
	return spawnSync("bun", [join(REPO, "src/cli/main.ts"), "queue", "migrate"], {
		env: { ...GIT_ENV, HOME: home, QUEUE_INDEX: join(agent, "INDEX.md") },
		encoding: "utf8",
	});
}

function indexLines(home: string): string[] {
	return readFileSync(join(home, ".omp/agent/INDEX.md"), "utf8").split("\n").filter(Boolean);
}

test("queue migrate folds repo INDEX.md plans into the main index and deletes the repo files", () => {
	const dir = fresh("fold");
	const home = makeHome(dir);
	const A = join(dir, "repo-a");
	const B = join(dir, "repo-b");
	mkdirSync(A, { recursive: true });
	mkdirSync(B, { recursive: true });
	git(B, "init", "-q", "-b", "main");
	writeFileSync(join(B, "base.txt"), "base\n");
	git(B, "add", "base.txt");
	git(B, "commit", "-q", "-m", "base");
	const BW = join(dir, "wt-b");
	git(B, "worktree", "add", "-q", "--detach", BW, "main");
	const a1 = join(A, "docs/plans/a1.md");
	const a2 = join(A, "docs/plans/a2.md");
	const b1 = join(BW, "docs/plans/b1.md");
	for (const p of [a1, a2, b1]) mkdirSync(dirname(p), { recursive: true });
	const already = join(dir, "already.md");
	for (const p of [a1, a2, b1, already]) writeFileSync(p, "# plan\nStatus: open\n");
	writeFileSync(join(A, "INDEX.md"), `- ${a1}\n${a2}\n`);
	writeFileSync(join(B, "INDEX.md"), `- ${b1}\n`);
	writeFileSync(join(home, ".omp/agent/INDEX.md"), `- ${A}\n- ${already}\n${B}\n`);

	const r = migrate(home);
	expect(r.status).toBe(0);
	const lines = indexLines(home);
	expect(lines).toContain(a1);
	expect(lines).toContain(a2);
	expect(lines).toContain(b1);
	expect(lines).toContain(already);
	expect(lines).not.toContain(A);
	expect(lines).not.toContain(B);
	// The repo INDEX.md files are gone; the plan files stay where they are.
	expect(existsSync(join(A, "INDEX.md"))).toBe(false);
	expect(existsSync(join(B, "INDEX.md"))).toBe(false);
	for (const p of [a1, a2, b1, already]) expect(existsSync(p)).toBe(true);
	// A plan still inside a linked worktree is reported, not moved.
	expect(r.stdout).toContain(b1);
	expect(r.stdout).toContain(BW);
});

test("queue migrate is idempotent", () => {
	const dir = fresh("idem");
	const home = makeHome(dir);
	const A = join(dir, "repo-a");
	mkdirSync(A, { recursive: true });
	const a1 = join(A, "a1.md");
	writeFileSync(a1, "# plan\nStatus: open\n");
	writeFileSync(join(A, "INDEX.md"), `- ${a1}\n`);
	writeFileSync(join(home, ".omp/agent/INDEX.md"), `- ${A}\n`);
	expect(migrate(home).status).toBe(0);
	const afterFirst = readFileSync(join(home, ".omp/agent/INDEX.md"), "utf8");
	const r2 = migrate(home);
	expect(r2.status).toBe(0);
	expect(readFileSync(join(home, ".omp/agent/INDEX.md"), "utf8")).toBe(afterFirst);
	expect(existsSync(join(A, "INDEX.md"))).toBe(false);
	expect(indexLines(home)).toEqual([a1]);
});

test("doctor flags a main index that still lists repo directories", () => {
	const dir = fresh("doctor");
	const HOME = join(dir, "home");
	mkdirSync(join(HOME, "Work/demo"), { recursive: true });
	const stub = join(HOME, "stub-bin");
	mkdirSync(stub, { recursive: true });
	writeFileSync(join(stub, "npm"), `#!/bin/sh\necho ${INSTALLED}\n`);
	chmodSync(join(stub, "npm"), 0o755);
	// init, install and doctor all run as children on one env without any inherited QUEUE_* state,
	// so the AGENTS.md block is rendered from the sandbox config both when it is written and read.
	const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("QUEUE_") && !k.startsWith("GIT_")));
	const env = { ...base, HOME, PATH: `${stub}:${process.env.PATH ?? ""}` };
	const cli = (args: string[]) => spawnSync("bun", [join(REPO, "src/cli/main.ts"), ...args], { env, encoding: "utf8" });
	expect(cli(["init"]).status).toBe(0);
	expect(cli(["adapter", "install", "omp"]).status).toBe(0);
	// initHome's default layout keeps the index under the agent dir (~/.config/neurastream).
	const idx = join(HOME, ".config/neurastream/INDEX.md");
	const demo = join(HOME, "Work/demo");
	writeFileSync(idx, `- ${demo}\n`);
	const flagged = cli(["doctor"]);
	expect(flagged.status).toBe(1);
	expect(flagged.stdout).toContain(demo);
	// The one-index layout raises no flag.
	writeFileSync(idx, `- ${join(HOME, "docs/plans/x.md")}\n`);
	const clean = cli(["doctor"]);
	expect(clean.status).toBe(0);
	expect(clean.stdout).not.toContain(demo);
});
