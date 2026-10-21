// P8 guard parity after the npm cutover: the guards must protect the INSTALLED
// package the way they protect today's live files. protectedPaths() covers the
// package root the running code loads from, bun's global install dir, every
// package.json bin launcher and the omp plugin dir; writeTargets() maps
// package/plugin/cutover commands onto those paths. checkTool
// (src/core/guards.ts) runs the protected check before the role split, so
// every refusal is proved for Main AND for a subagent while .guard-unlock is
// absent or stale, and allowed while it is fresh.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { installOmp } from "../src/adapters/omp/install.ts";
import { initHome } from "../src/cli/init.ts";
import { loadConfig } from "../src/core/config.ts";
import { writeTargets } from "../src/core/queue/lib.ts";

const REPO = dirname(dirname(import.meta.path));
const HOME = "/tmp/neurastream-home-guardpkg";
const AGENT = join(HOME, ".omp/agent");
const UNLOCK = join(AGENT, ".guard-unlock");
const STATE = join(HOME, ".local/state/queue");
const TOY = join(HOME, "projects/toy");
const CUTOVER = join(REPO, "scripts/cutover.sh");

interface Decision {
	allow: boolean;
	reason: string;
	inject?: string;
}

function envFor(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	// Inherited QUEUE_* would override the sandbox config in the child (env
	// beats config.yml), so they are dropped; everything else (PATH, ...) passes
	// through and the sandbox values win.
	return {
		...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("QUEUE_"))),
		HOME,
		BUN_INSTALL: join(HOME, ".bun"),
		QUEUE_AGENT: AGENT,
		QUEUE_INDEX: join(AGENT, "INDEX.md"),
		QUEUE_BLOCKERS: join(AGENT, "blockers"),
		QUEUE_STATE: STATE,
		QUEUE_SUBAGENTS: join(AGENT, "notes/subagents.md"),
		QUEUE_CANCELLED: join(AGENT, "CANCELLED.md"),
		QUEUE_UNLOCK: UNLOCK,
		...extra,
	};
}

function guardCli(agent: "main" | "sub", tool: string, input: Record<string, unknown>): Decision {
	const payload = {
		tool,
		input,
		cwd: TOY,
		agent,
		agentId: agent === "main" ? "main" : "w1",
		calls: 0,
		paths: [],
		writes: [],
		command: String(input.command ?? ""),
	};
	const r = spawnSync("bun", [join(REPO, "src/cli/main.ts"), "guard", "pre-tool", "--json"], {
		input: JSON.stringify(payload),
		encoding: "utf8",
		env: envFor(),
	});
	if (!r.stdout.trim()) throw new Error(`guard printed nothing: ${r.stderr}`);
	return JSON.parse(r.stdout.trim()) as Decision;
}

const writeEvent = (path: string) => ({ path });
const bashEvent = (command: string) => ({ command });

function refuseBoth(name: string, tool: string, input: Record<string, unknown>): void {
	for (const agent of ["main", "sub"] as const) {
		const d = guardCli(agent, tool, input);
		expect(d.allow).toBe(false);
		expect(d.reason).toContain("protected guard file");
	}
}

function allowBoth(name: string, tool: string, input: Record<string, unknown>): void {
	for (const agent of ["main", "sub"] as const) {
		const d = guardCli(agent, tool, input);
		expect(d.allow).toBe(true);
	}
}

function setUnlockAge(msAgo: number): void {
	writeFileSync(UNLOCK, "");
	const t = new Date(Date.now() - msAgo);
	utimesSync(UNLOCK, t, t);
}

function childProtected(extra: NodeJS.ProcessEnv): string[] {
	// Dynamic import is deliberate here (module-loading boundary test): the
	// import runs inside a `bun -e` child whose env pins HOME/BUN_INSTALL/QUEUE_*,
	// so lib.ts re-derives every path from that sandbox — a static import in
	// this test process would bake in the real HOME at module load.
	const body = `const lib = await import(${JSON.stringify(join(REPO, "src/core/queue/lib.ts"))});
lib.refreshQueuePaths();
console.log(JSON.stringify(lib.PROTECTED));`;
	const r = spawnSync("bun", ["-e", body], { encoding: "utf8", env: envFor(extra), cwd: "/tmp" });
	if (r.status !== 0) throw new Error(`protected child failed: ${r.stderr}`);
	return JSON.parse(r.stdout.trim().split("\n").pop() ?? "[]") as string[];
}

beforeAll(() => {
	rmSync(HOME, { recursive: true, force: true });
	// The real init writes the full config (protected placeholder + ledger
	// line); the adapter install then extends guards.protected with the agents,
	// extensions and plugin dirs — the exact chain a cutover runs. Only the
	// free prefixes are patched afterwards, so Main's edit window stays out of
	// the way and these tests isolate the protected-path/command behaviour.
	initHome(HOME, { env: {} });
	mkdirSync(join(TOY, "docs/plans"), { recursive: true });
	const cfgPath = join(HOME, ".config/neurastream/config.yml");
	const cfg = readFileSync(cfgPath, "utf8").replace(
		/ {2}free_prefixes: \[[^\]]*\]/,
		`  free_prefixes: ["${join(HOME, ".bun/")}", "${join(HOME, ".omp/plugins/")}", "${join(HOME, ".local/bin/")}"]`,
	);
	writeFileSync(cfgPath, cfg);
	installOmp(HOME);
});

afterAll(() => {
	rmSync(HOME, { recursive: true, force: true });
});

test("protectedPaths covers the installed package, its bins and bun's global dir", () => {
	const paths = childProtected({});
	expect(paths).toContain(`${HOME}/.bun/install/global/node_modules/neurastream/`);
	expect(paths).toContain(`${realpathSync(REPO)}/`);
	const bins = Object.keys(JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).bin as Record<string, string>);
	expect(bins.length).toBeGreaterThan(10);
	for (const name of bins) expect(paths).toContain(`${HOME}/.bun/bin/${name}`);
});

test("the adapter overlay lists the plugin dir in guards.protected", () => {
	const cfg = loadConfig({ home: HOME, env: {} });
	// loadConfig expands ~ against the sandbox HOME.
	expect(cfg.guards.protected.some(p => p.endsWith("/.omp/plugins/"))).toBe(true);
	expect(cfg.guards.protected.some(p => p.endsWith("/extensions/"))).toBe(true);
});

test("protectedPaths honours BUN_INSTALL for the global package dir", () => {
	const paths = childProtected({ BUN_INSTALL: join(HOME, ".bun-global") });
	expect(paths).toContain(`${HOME}/.bun-global/install/global/node_modules/neurastream/`);
	expect(paths).toContain(`${HOME}/.bun/bin/neurastream`);
});

test("writeTargets maps global package, plugin and cutover commands to protected roots", () => {
	const savedBunInstall = process.env.BUN_INSTALL;
	const savedQueueAgent = process.env.QUEUE_AGENT;
	process.env.BUN_INSTALL = join(HOME, ".bun");
	process.env.QUEUE_AGENT = AGENT;
	try {
		const bunRoot = `${HOME}/.bun/install/global/node_modules/neurastream`;
		for (const [cmd, want] of [
			["bun add -g neurastream@0.1.5", bunRoot],
			["bun install -g neurastream", bunRoot],
			["bun remove -g neurastream", bunRoot],
			["bun rm -g neurastream", bunRoot],
			["bun update -g neurastream", bunRoot],
			["bun link -g neurastream", bunRoot],
			["bun unlink -g", bunRoot],
			["cd /tmp && bun add -g ./neurastream-0.1.5.tgz", bunRoot],
			["npm install -g neurastream", bunRoot],
			["npm i -g neurastream@latest", bunRoot],
			["npm uninstall -g neurastream", bunRoot],
			["npm update -g neurastream", bunRoot],
			["npm link -g neurastream", bunRoot],
			["neurastream adapter install omp", bunRoot],
			["neurastream adapter uninstall omp", bunRoot],
			["bash scripts/cutover.sh", `${AGENT}/extensions/`],
			["bash $PWD/scripts/rollback.sh x.tar", `${AGENT}/extensions/`],
		] as const) {
			const hits = writeTargets("bash", bashEvent(cmd), TOY);
			expect(hits).toContain(want);
		}
		// Unrelated global packages and reads are not package-guard writes.
		for (const cmd of ["bun add -g lodash", "npm i -g eslint", `cat ${CUTOVER}`, "grep -rn bun\\ add\\ -g README.md"]) {
			expect(writeTargets("bash", bashEvent(cmd), TOY)).not.toContain(bunRoot);
			expect(writeTargets("bash", bashEvent(cmd), TOY)).not.toContain(`${AGENT}/extensions/`);
		}
	} finally {
		if (savedBunInstall === undefined) delete process.env.BUN_INSTALL;
		else process.env.BUN_INSTALL = savedBunInstall;
		if (savedQueueAgent === undefined) delete process.env.QUEUE_AGENT;
		else process.env.QUEUE_AGENT = savedQueueAgent;
	}
});

test("the adapter matcher maps plugin commands onto the plugin dir", () => {
	const plugins = `${homedir()}/.omp/plugins/`;
	for (const cmd of ["omp plugin link /tmp/neurastream", "omp plugin install x", "omp plugin uninstall x", "omp plugin unlink x", "omp plugin update"]) {
		expect(writeTargets("bash", bashEvent(cmd), TOY)).toContain(plugins);
	}
	for (const cmd of ["omp plugin list", "omp --version", "cat scripts/cutover.sh"]) {
		expect(writeTargets("bash", bashEvent(cmd), TOY)).not.toContain(plugins);
	}
	// The sandbox escape: with HOME pinned to /tmp on the same command line the
	// cutover scripts are free (every sandbox test runs them that way).
	for (const cmd of [`HOME=/tmp/neurastream-home-cut bash ${CUTOVER}`, "NEURASTREAM_TARBALL=x HOME=/tmp/h bash scripts/rollback.sh t.tar"]) {
		expect(writeTargets("bash", bashEvent(cmd), TOY)).not.toContain(`${AGENT}/extensions/`);
	}
});

test("package and plugin writes are refused for Main and a sub without an unlock", () => {
	rmSync(UNLOCK, { force: true });
	expect(existsSync(UNLOCK)).toBe(false);
	refuseBoth("bun bin write", "write", writeEvent(join(HOME, ".bun/bin/queue-check")));
	refuseBoth("plugins write", "write", writeEvent(join(HOME, ".omp/plugins/pwned")));
	refuseBoth("bun add", "bash", bashEvent("bun add -g neurastream@0.1.5"));
	refuseBoth("npm install", "bash", bashEvent("npm install -g neurastream"));
	refuseBoth("omp plugin link", "bash", bashEvent("omp plugin link /tmp/neurastream"));
	refuseBoth("adapter install", "bash", bashEvent("neurastream adapter install omp"));
	refuseBoth("cutover.sh", "bash", bashEvent(`bash ${CUTOVER}`));
	refuseBoth("rollback.sh", "bash", bashEvent(`bash ${join(REPO, "scripts/rollback.sh")} x.tar`));
});

test("a stale unlock is no unlock", () => {
	setUnlockAge(31 * 60_000);
	refuseBoth("stale bun bin write", "write", writeEvent(join(HOME, ".bun/bin/queue-check")));
	refuseBoth("stale bun add", "bash", bashEvent("bun add -g neurastream@0.1.5"));
});

test("a fresh unlock allows both roles", () => {
	setUnlockAge(0);
	allowBoth("bun bin write", "write", writeEvent(join(HOME, ".bun/bin/queue-check")));
	allowBoth("plugins write", "write", writeEvent(join(HOME, ".omp/plugins/pwned")));
	allowBoth("bun add", "bash", bashEvent("bun add -g neurastream@0.1.5"));
	allowBoth("npm install", "bash", bashEvent("npm install -g neurastream"));
	allowBoth("omp plugin link", "bash", bashEvent("omp plugin link /tmp/neurastream"));
	allowBoth("adapter install", "bash", bashEvent("neurastream adapter install omp"));
	allowBoth("cutover.sh", "bash", bashEvent(`bash ${CUTOVER}`));
});

test("the sandbox HOME escape and unrelated packages need no unlock", () => {
	rmSync(UNLOCK, { force: true });
	allowBoth("cutover with HOME=/tmp", "bash", bashEvent(`HOME=/tmp/neurastream-home-cut bash ${CUTOVER}`));
	allowBoth("unrelated bun add", "bash", bashEvent("bun add -g lodash"));
	allowBoth("unrelated npm install", "bash", bashEvent("npm install -g eslint"));
	allowBoth("reading the cutover script", "bash", bashEvent(`cat ${CUTOVER}`));
});
