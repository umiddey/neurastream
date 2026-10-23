import { afterAll, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { allowedAgents } from "../src/core/queue/lib.ts";

const REPO = resolve(import.meta.dir, "..");
const HOME = "/tmp/neurastream-home-agents";
const AGENT = join(HOME, ".config", "neurastream");
const SUBAGENTS = join(AGENT, "notes", "subagents.md");
const UNLOCK = join(AGENT, ".guard-unlock");
const STATE = join(HOME, ".local", "state", "queue");

function envFor(): NodeJS.ProcessEnv {
	return { ...process.env, HOME, QUEUE_SUBAGENTS: SUBAGENTS, QUEUE_UNLOCK: UNLOCK, QUEUE_STATE: STATE, QUEUE_AGENT: AGENT };
}

function cli(args: string[]): { code: number; out: string; err: string } {
	const r = spawnSync("bun", [join(REPO, "src/cli/main.ts"), ...args], { encoding: "utf8", env: envFor(), cwd: REPO });
	return { code: r.status ?? 1, out: r.stdout, err: r.stderr };
}

function guard(event: string, payload: unknown): { code: number; d: { allow: boolean; reason: string } } {
	const r = spawnSync("bun", [join(REPO, "src/cli/main.ts"), "guard", event, "--json"], {
		input: JSON.stringify(payload),
		encoding: "utf8",
		env: envFor(),
	});
	return { code: r.status ?? 1, d: JSON.parse(r.stdout.trim()) };
}

function fresh(seed: string): void {
	rmSync(HOME, { recursive: true, force: true });
	mkdirSync(join(AGENT, "notes"), { recursive: true });
	writeFileSync(SUBAGENTS, seed);
}

const SEED = `# Subagents

Notes for the subagent registry.

## Allowed

<!-- Empty by default: only listed slugs may run as subagents. -->

- \`alpha\`

## Notes

Anything below the allow-list stays untouched.
`;

beforeEach(() => fresh(SEED));
afterAll(() => rmSync(HOME, { recursive: true, force: true }));

test("agents list prints the allowed slugs then the file path", () => {
	const r = cli(["agents", "list"]);
	expect(r.code).toBe(0);
	expect(r.out).toBe(`alpha\nfile: ${SUBAGENTS}\n`);
});

test("agents allow adds a bullet and keeps the comment and later sections", () => {
	const r = cli(["agents", "allow", "beta-2"]);
	expect(r.code).toBe(0);
	const text = readFileSync(SUBAGENTS, "utf8");
	expect(text).toContain("<!-- Empty by default: only listed slugs may run as subagents. -->");
	expect(text).toContain("- `beta-2`");
	expect(text.endsWith("Anything below the allow-list stays untouched.\n")).toBe(true);
	expect(text.indexOf("- `beta-2`")).toBeLessThan(text.indexOf("## Notes"));
});

test("agents allow is idempotent: an existing slug is not added twice", () => {
	cli(["agents", "allow", "alpha"]);
	const once = readFileSync(SUBAGENTS, "utf8");
	cli(["agents", "allow", "alpha"]);
	expect(readFileSync(SUBAGENTS, "utf8")).toBe(once);
	expect(once.match(/- `alpha`/g)?.length).toBe(1);
});

test("an invalid slug exits 2 and changes nothing", () => {
	const before = readFileSync(SUBAGENTS, "utf8");
	const r = cli(["agents", "allow", "good-one", "Bad_Slug"]);
	expect(r.code).toBe(2);
	expect(readFileSync(SUBAGENTS, "utf8")).toBe(before);
});

test("agents deny removes only that bullet, every other byte stays", () => {
	cli(["agents", "allow", "beta"]);
	const withBeta = readFileSync(SUBAGENTS, "utf8");
	const r = cli(["agents", "deny", "beta"]);
	expect(r.code).toBe(0);
	expect(readFileSync(SUBAGENTS, "utf8")).toBe(withBeta.replace("- `beta`\n", ""));
});

test("allowAgents result is what allowedAgents() reads", () => {
	cli(["agents", "allow", "gamma"]);
	expect([...allowedAgents(SUBAGENTS)]).toEqual(["alpha", "gamma"]);
});

test("usage: agents with no action exits 2", () => {
	expect(cli(["agents"]).code).toBe(2);
	expect(cli(["agents", "allow"]).code).toBe(2);
});

test("a subagent's bash agents allow is refused while locked and allowed after unlock", () => {
	const event = (cmd: string) => ({
		tool: "bash",
		input: { command: cmd },
		cwd: REPO,
		agent: "sub",
		agentId: "w1",
		calls: 0,
		paths: [],
		writes: [],
		command: cmd,
	});
	const locked = guard("pre-tool", event("neurastream agents allow sneaky"));
	expect(locked.code).toBe(2);
	expect(locked.d.allow).toBe(false);
	expect(readFileSync(SUBAGENTS, "utf8")).not.toContain("sneaky");

	writeFileSync(UNLOCK, new Date().toISOString());
	const open = guard("pre-tool", event("neurastream agents allow sneaky"));
	expect(open.code).toBe(0);
	expect(open.d.allow).toBe(true);
	expect(existsSync(UNLOCK)).toBe(true);
});
