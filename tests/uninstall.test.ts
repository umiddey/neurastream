// uninstall: the inverse of init + adapter install. install -> uninstall leaves nothing of
// ours behind (bins, plugin link, template-identical pins, the managed AGENTS.md block), the
// owner's own text and edited pins survive, --purge adds the config file and agent-dir state,
// and any planned path resolving outside the sandbox HOME is refused before nothing is removed.

import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { installOmp } from "../src/adapters/omp/install.ts";
import { initHome } from "../src/cli/init.ts";

const REPO = dirname(dirname(import.meta.path));
const ROOTS: string[] = [];

afterAll(() => {
	for (const r of ROOTS) rmSync(r, { recursive: true, force: true });
});

function home(): string {
	const h = mkdtempSync(join(tmpdir(), "neurastream-uninstall-"));
	ROOTS.push(h);
	return h;
}

function childEnv(h: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	// Inherited QUEUE_* would override the sandbox config in the child (env beats config.yml).
	return {
		...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("QUEUE_"))),
		HOME: h,
		...extra,
	};
}

function run(h: string, args: string[], extra: NodeJS.ProcessEnv = {}): { code: number; stdout: string; stderr: string } {
	const r = spawnSync("bun", [join(REPO, "src/cli/main.ts"), "uninstall", ...args], {
		env: childEnv(h, extra),
		cwd: h,
		encoding: "utf8",
	});
	return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** init + adapter install on a sandbox HOME whose AGENTS.md carries personal text first. */
function setup(h: string): string {
	const agentDir = join(h, ".omp/agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "AGENTS.md"), "my own notes, written before neurastream\n");
	initHome(h, { env: {} });
	installOmp(h);
	return join(agentDir, "AGENTS.md");
}

const OUR_BINS = ["wip-check", "agent-score", "queue-check"];

function ourBinsLeft(h: string): string[] {
	const left: string[] = [];
	for (const dir of [join(h, ".local/bin"), join(h, ".bun/bin")]) {
		if (!existsSync(dir)) continue;
		for (const name of readdirSync(dir)) if (OUR_BINS.includes(name)) left.push(join(dir, name));
	}
	return left;
}

test("install then uninstall --yes leaves nothing of ours; personal text survives", () => {
	const h = home();
	const agentsMd = setup(h);
	expect(readFileSync(agentsMd, "utf8")).toContain("my own notes, written before neurastream");
	expect(existsSync(join(h, ".omp/plugins/node_modules/neurastream"))).toBe(true);
	expect(existsSync(join(h, ".omp/agent/agents/example.md"))).toBe(true);

	const dry = run(h, []);
	expect(dry.code).toBe(1);
	expect(dry.stdout).toContain("would remove:");
	expect(ourBinsLeft(h).length).toBeGreaterThan(0); // dry run removed nothing

	const r = run(h, ["--yes"]);
	expect(r.code).toBe(0);
	expect(r.stdout).toContain("uninstalled");
	expect(ourBinsLeft(h)).toEqual([]);
	expect(existsSync(join(h, ".omp/plugins/node_modules/neurastream"))).toBe(false);
	expect(existsSync(join(h, ".omp/agent/agents/example.md"))).toBe(false); // template-identical pin
	const text = readFileSync(agentsMd, "utf8");
	expect(text).toContain("my own notes, written before neurastream");
	expect(text).not.toContain("neurastream:begin");
	expect(text).not.toContain("neurastream:end");
}, 60_000);

test("an owner-edited pin is kept; unknown flags are refused", () => {
	const h = home();
	setup(h);
	const pin = join(h, ".omp/agent/agents/example.md");
	writeFileSync(pin, `${readFileSync(pin, "utf8")}\nmy own tweak\n`);
	expect(run(h, ["--nope"]).code).toBe(2);
	const r = run(h, ["--yes"]);
	expect(r.code).toBe(0);
	expect(r.stdout).toContain("kept:");
	expect(readFileSync(pin, "utf8")).toContain("my own tweak");
}, 60_000);

test("--purge removes the config file and the agent-dir state init created", () => {
	const h = home();
	setup(h);
	const r = run(h, ["--purge", "--yes"]);
	expect(r.code).toBe(0);
	expect(existsSync(join(h, ".config/neurastream/config.yml"))).toBe(false);
	expect(existsSync(join(h, ".config/neurastream/INDEX.md"))).toBe(false);
	expect(existsSync(join(h, ".config/neurastream/notes"))).toBe(false);
	expect(existsSync(join(h, ".config/neurastream/blockers"))).toBe(false);
	expect(existsSync(join(h, ".config/neurastream/queue"))).toBe(false);
	expect(existsSync(join(h, ".config/neurastream/CANCELLED.md"))).toBe(false);
	expect(existsSync(join(h, ".config/neurastream/.guard-unlock"))).toBe(false);
}, 60_000);

test("planned paths outside HOME are refused and nothing is removed", () => {
	const h = home();
	setup(h);
	const outside = "/tmp/neurastream-uninstall-outside";
	// The purge plan only selects entries that exist: create the state the env override points at.
	for (const dir of ["notes", "blockers", "queue"]) mkdirSync(join(outside, dir), { recursive: true });
	for (const file of ["INDEX.md", "CANCELLED.md", ".guard-unlock"]) writeFileSync(join(outside, file), "x\n");
	const r = run(h, ["--purge", "--yes"], { QUEUE_AGENT: outside });
	expect(r.code).toBe(1);
	expect(r.stdout).toContain("refused:");
	expect(r.stdout).toContain("nothing removed");
	expect(existsSync(join(h, ".config/neurastream/config.yml"))).toBe(true);
	expect(existsSync(join(h, ".omp/plugins/node_modules/neurastream"))).toBe(true);
}, 60_000);

test("an identical shipped skill is removed; a skill dir with an owner file is kept", () => {
	const clean = home();
	setup(clean);
	const cleanDir = join(clean, ".agents/skills/architecture-drilldown");
	expect(existsSync(join(cleanDir, "SKILL.md"))).toBe(true);
	expect(run(clean, ["--yes"]).code).toBe(0);
	expect(existsSync(cleanDir)).toBe(false);

	const edited = home();
	setup(edited);
	const editedDir = join(edited, ".agents/skills/architecture-drilldown");
	writeFileSync(join(editedDir, "notes.md"), "mine\n");
	const r = run(edited, ["--yes"]);
	expect(r.code).toBe(0);
	expect(r.stdout).toContain("kept:");
	expect(readFileSync(join(editedDir, "notes.md"), "utf8")).toBe("mine\n");
}, 60_000);
