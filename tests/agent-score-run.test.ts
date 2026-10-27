import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const REPO = dirname(dirname(import.meta.path));
const ROOTS: string[] = [];
const REFUSED = (name: string) =>
	`refused: no run named "${name}" — use the task name (e.g. NsOneIndex3Glm), not the worker type\n`;

afterAll(() => {
	for (const r of ROOTS) rmSync(r, { recursive: true, force: true });
});

function home(): string {
	const h = mkdtempSync(join(tmpdir(), "neurastream-score-run-"));
	ROOTS.push(h);
	mkdirSync(join(h, "Work"), { recursive: true });
	return h;
}

function run(h: string, args: string[]): { code: number; stdout: string; stderr: string } {
	const r = spawnSync("bun", [join(REPO, "src/cli/main.ts"), "agent-score", ...args], {
		env: { ...process.env, HOME: h },
		cwd: h,
		encoding: "utf8",
	});
	return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function events(h: string): Record<string, unknown>[] {
	const p = join(h, ".local/state/agent-score/events.jsonl");
	if (!existsSync(p)) return [];
	return readFileSync(p, "utf8")
		.split("\n")
		.filter(l => l.trim())
		.map(l => JSON.parse(l) as Record<string, unknown>);
}

function commit(h: string): { repo: string; sha: string } {
	const repo = join(h, "repo");
	mkdirSync(repo, { recursive: true });
	const git = (args: string[]): void => {
		const r = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
		if (r.status !== 0) throw new Error(r.stderr || `git ${args.join(" ")} failed`);
	};
	git(["init", "-b", "main"]);
	git(["config", "user.email", "t@example.com"]);
	git(["config", "user.name", "t"]);
	writeFileSync(join(repo, "a.txt"), "a\n");
	git(["add", "a.txt"]);
	git(["commit", "-m", "init"]);
	return { repo, sha: spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim() };
}

function plan(h: string): string {
	const p = join(h, "plan.md");
	writeFileSync(p, "- [x] P1 land it — difficulty: 2 — verify: `true`\n");
	return p;
}

/** A sub-run the score window can see: file stem is the task name, provider+model set scoreModel. */
function plantRun(h: string, name: string, provider: string, model: string): void {
	const dir = join(h, ".omp/agent/sessions/proj");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, `${name}.jsonl`),
		`${JSON.stringify({
			message: {
				role: "assistant",
				provider,
				model,
				usage: { totalTokens: 1, cacheRead: 0, cost: { total: 0.01 } },
				stopReason: "end_turn",
				content: [{ type: "text", text: "done" }],
			},
		})}\n`,
	);
}

test("accept refuses a worker type that names no run and records nothing", () => {
	const h = home();
	const { repo, sha } = commit(h);
	const r = run(h, ["accept", "glm", "--plan", plan(h), "--phase", "P1", "--commits", sha, "--repo", repo, "--branch", "main"]);
	expect(r.code).toBe(1);
	expect(r.stderr).toBe(REFUSED("glm"));
	expect(events(h)).toEqual([]);
});

test("accept of a real run stores that run's model on the event", () => {
	const h = home();
	plantRun(h, "NsOneIndex3Glm", "zai", "glm-5.3");
	const { repo, sha } = commit(h);
	const r = run(h, ["accept", "NsOneIndex3Glm", "--plan", plan(h), "--phase", "P1", "--commits", sha, "--repo", repo, "--branch", "main"]);
	expect(r.stderr).toBe("");
	expect(r.code).toBe(0);
	const ev = events(h);
	expect(ev.length).toBe(1);
	expect(ev[0]!.model).toBe("zai/glm-5.3");
});

test("an opencode-only agent is accepted and the event keeps its model", () => {
	const h = home();
	const dir = join(h, ".local/state/agent-score");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "oc-runs.jsonl"),
		`${JSON.stringify({ agent: "OcOnly", model: "opencode/big-pickle", plan: "", start: Date.now() / 1000, end: Date.now() / 1000, exit: 0, final: true })}\n`,
	);
	const { repo, sha } = commit(h);
	const r = run(h, ["accept", "OcOnly", "--plan", plan(h), "--phase", "P1", "--commits", sha, "--repo", repo, "--branch", "main"]);
	expect(r.stderr).toBe("");
	expect(r.code).toBe(0);
	expect(events(h)[0]!.model).toBe("opencode/big-pickle");
});
