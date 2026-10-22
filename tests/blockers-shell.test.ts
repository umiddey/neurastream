// Blockers judge actions and file targets, not words in command text (guard-paths plan P1-P4).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	type BlockerCall,
	type BlockerEnv,
	BlockerRefusal,
	blockerEnv,
	denyCommand,
	denyPath,
	noPush,
	splitShell,
} from "../src/core/blockers.ts";

const root = mkdtempSync(path.join(tmpdir(), "ns-blockers-shell-"));
mkdirSync(path.join(root, ".git"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const FORBIDDEN_COMMANDS = ["npm\\s+publish", "bun\\s+link", "git\\s+tag", "--no-verify", "git\\s+add\\s+(-A|--all|\\.)"];

function call(tool: string, input: Record<string, unknown>, agent = "sub", paths: string[] = []): BlockerCall {
	return { tool, input, cwd: root, agent, repo: root, plan: "", paths };
}

function bash(command: string, agent = "sub"): BlockerCall {
	return call("bash", { command }, agent);
}

function refused(check: (env: BlockerEnv) => void, c: BlockerCall, args: string[]): boolean {
	try {
		check(blockerEnv(c, args));
		return false;
	} catch (err) {
		if (err instanceof BlockerRefusal) return true;
		throw err;
	}
}

describe("splitShell", () => {
	test("splits on operators outside quotes and keeps quoted words whole", () => {
		const segs = splitShell('git commit -m "fix: no git push here" && echo ok');
		expect(segs.length).toBe(2);
		expect(segs[0]?.words.map((w) => w.text)).toEqual(["git", "commit", "-m", "fix: no git push here"]);
		expect(segs[1]?.words.map((w) => w.text)).toEqual(["echo", "ok"]);
	});

	test("drops heredoc bodies and reports the redirection target", () => {
		const segs = splitShell("cat > s.sh <<'EOF'\nuv lock --upgrade\nEOF\necho done");
		expect(segs.some((s) => s.words.some((w) => w.text === "uv"))).toBe(false);
		expect(segs[0]?.writes).toEqual(["s.sh"]);
		expect(segs[1]?.words.map((w) => w.text)).toEqual(["echo", "done"]);
	});

	test("does not treat fd duplication (2>&1) as a write", () => {
		const segs = splitShell("make 2>&1 | tail -n 3");
		expect(segs.length).toBe(2);
		expect(segs[0]?.writes).toEqual([]);
	});

	test("emits command substitutions as their own segments, before the parent", () => {
		const segs = splitShell("echo $(git push origin main)");
		expect(segs[0]?.words.map((w) => w.text)).toEqual(["git", "push", "origin", "main"]);
		expect(segs[1]?.words.map((w) => w.text)).toEqual(["echo"]);
	});
});

describe("no-push (plan P2): commands, not words", () => {
	test("allows a commit whose message mentions push", () => {
		expect(refused(noPush, bash('git commit -m "docs: explain why we never git push here"'), [])).toBe(false);
	});

	test("refuses git push, however it is spelled", () => {
		expect(refused(noPush, bash("git push origin feat"), [])).toBe(true);
		expect(refused(noPush, bash("git -C x push origin main"), [])).toBe(true);
		expect(refused(noPush, bash("cd x && git push"), [])).toBe(true);
		expect(refused(noPush, bash('bash -c "git push"'), [])).toBe(true);
	});

	test("refuses MR and PR merges", () => {
		expect(refused(noPush, bash("glab mr merge 3"), [])).toBe(true);
		expect(refused(noPush, bash("gh pr merge 3"), [])).toBe(true);
	});

	test("never applies to the main agent", () => {
		expect(refused(noPush, bash("git push origin main", "main"), [])).toBe(false);
	});
});

describe("deny-command (plan P3): unquoted command words only", () => {
	test("allows forbidden words inside quotes and heredoc bodies", () => {
		expect(refused(denyCommand, bash('git commit -m "tag the release: git tag later"'), FORBIDDEN_COMMANDS)).toBe(false);
		expect(refused(denyCommand, bash("cat > notes.md <<'EOF'\ngit tag v1\nEOF"), FORBIDDEN_COMMANDS)).toBe(false);
	});

	test("refuses the forbidden commands themselves", () => {
		expect(refused(denyCommand, bash("git tag v1.0"), FORBIDDEN_COMMANDS)).toBe(true);
		expect(refused(denyCommand, bash("git commit --no-verify -m x"), FORBIDDEN_COMMANDS)).toBe(true);
		expect(refused(denyCommand, bash("git add -A"), FORBIDDEN_COMMANDS)).toBe(true);
		expect(refused(denyCommand, bash("npm publish"), FORBIDDEN_COMMANDS)).toBe(true);
	});

	test("refuses a forbidden command run through bash -c", () => {
		expect(refused(denyCommand, bash('bash -c "git tag v1"'), FORBIDDEN_COMMANDS)).toBe(true);
	});
});

describe("deny-path (plan P3): real mutation targets only", () => {
	const UV_LOCK = ["uv.lock"];

	test("allows reading or diffing a forbidden file", () => {
		expect(refused(denyPath, bash("git diff uv.lock"), UV_LOCK)).toBe(false);
		expect(refused(denyPath, bash("cat uv.lock"), UV_LOCK)).toBe(false);
	});

	test("refuses every kind of mutation of the file", () => {
		expect(refused(denyPath, bash("rm uv.lock"), UV_LOCK)).toBe(true);
		expect(refused(denyPath, bash("echo y > uv.lock"), UV_LOCK)).toBe(true);
		expect(refused(denyPath, bash("sed -i s/a/b/ uv.lock"), UV_LOCK)).toBe(true);
		expect(refused(denyPath, bash("cp a uv.lock"), UV_LOCK)).toBe(true);
		expect(refused(denyPath, bash("truncate -s 0 uv.lock"), UV_LOCK)).toBe(true);
		expect(refused(denyPath, bash("git checkout -- uv.lock"), UV_LOCK)).toBe(true);
	});

	test("reads the cp source as a read, not a write", () => {
		expect(refused(denyPath, bash("cp uv.lock backup.lock"), UV_LOCK)).toBe(false);
	});

	test("does not treat text in a heredoc or commit message as a target", () => {
		expect(refused(denyPath, bash("cat > notes.md <<'EOF'\nrm uv.lock\nEOF"), UV_LOCK)).toBe(false);
		expect(refused(denyPath, bash('git commit -m "remove uv.lock: rm uv.lock"'), UV_LOCK)).toBe(false);
	});

	test("resolves targets against a cd in the same command", () => {
		expect(refused(denyPath, bash("cd sub && rm ../uv.lock"), UV_LOCK)).toBe(true);
	});

	test("write and edit tools are still refused for the forbidden file", () => {
		expect(refused(denyPath, call("write", { path: "uv.lock" }, "sub", [path.join(root, "uv.lock")]), UV_LOCK)).toBe(true);
	});
});

describe("plan files (plan P4): Progress edits are not blocked by deny-path", () => {
	const PLANS = ["docs/plans/**"];

	test("a write to a live plan file is left to plan-edit", () => {
		const file = path.join(root, "docs/plans/20261022_1930_x.md");
		expect(refused(denyPath, call("write", { path: file }, "sub", [file]), PLANS)).toBe(false);
	});

	test("a shell write to a live plan file is refused by deny-path", () => {
		expect(refused(denyPath, bash("rm docs/plans/20261022_1930_x.md"), PLANS)).toBe(true);
		expect(refused(denyPath, bash("echo x >> docs/plans/20261022_1930_x.md"), PLANS)).toBe(true);
	});

	test("archived plans are not exempt", () => {
		const file = path.join(root, "docs/plans/archive/20261022_1930_x.md");
		expect(refused(denyPath, call("write", { path: file }, "sub", [file]), PLANS)).toBe(true);
	});
});
