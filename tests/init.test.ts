import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { installOmp } from "../src/adapters/omp/install.ts";
import { loadConfig } from "../src/core/config.ts";
import { initHome, treeHash } from "../src/cli/init.ts";

const HOME = "/tmp/neurastream-home-init";

afterAll(() => {
	rmSync(HOME, { recursive: true, force: true });
});

test("init creates the layout and a second run changes nothing", () => {
	rmSync(HOME, { recursive: true, force: true });
	const first = initHome(HOME, { env: {} });
	expect(first.created.length).toBeGreaterThan(0);
	expect(existsSync(join(HOME, ".config/neurastream/config.yml"))).toBe(true);
	expect(existsSync(join(HOME, ".config/neurastream/INDEX.md"))).toBe(true);
	expect(existsSync(join(HOME, ".config/neurastream/notes/subagents.md"))).toBe(true);
	expect(existsSync(join(HOME, ".config/neurastream/notes/lessons.md"))).toBe(true);
	expect(existsSync(join(HOME, ".config/neurastream/notes/subagent-ranking.md"))).toBe(true);
	expect(existsSync(join(HOME, ".config/neurastream/queue/TEMPLATE.md"))).toBe(true);
	expect(existsSync(join(HOME, ".local/state/queue"))).toBe(true);
	expect(existsSync(join(HOME, ".local/state/agent-score"))).toBe(true);
	const blocker = join(HOME, ".config/neurastream/blockers/no-push");
	expect(existsSync(blocker)).toBe(true);
	const before = treeHash(HOME);
	const second = initHome(HOME, { env: {} });
	expect(second.created).toEqual([]);
	expect(treeHash(HOME)).toBe(before);

	const cfg = loadConfig({ home: HOME, env: {} });
	expect(cfg.paths.queue_index).toBe(join(HOME, ".config/neurastream/INDEX.md"));
	expect(cfg.guards.protected.some(p => p.endsWith("/notes/"))).toBe(true);
	expect(cfg.score.default_repo).toBe("");
	expect(readFileSync(join(HOME, ".config/neurastream/notes/subagents.md"), "utf8")).toContain("- `glm`");

	const refused = spawnSync("bun", [blocker], {
		input: JSON.stringify({
			tool: "bash",
			input: { command: "git push origin main" },
			cwd: "/tmp",
			agent: "sub",
			repo: "/tmp",
			plan: "/tmp/p.md",
			paths: ["/tmp/README"],
		}),
		encoding: "utf8",
	});
	expect(refused.status).toBe(2);
	expect(refused.stderr).toContain("subagents never push");
});

test("adapter install links the extension under the sandbox home and stays loadable", () => {
	rmSync(HOME, { recursive: true, force: true });
	initHome(HOME, { env: {} });
	const installed = installOmp(HOME);
	expect(existsSync(installed.extension)).toBe(true);
	expect(existsSync(installed.plugin)).toBe(true);
	expect(installed.pinsCopied.length).toBe(17);
	const cfg = loadConfig({ home: HOME, env: {} });
	expect(cfg.adapter?.name).toBe("omp");
	expect(cfg.adapter?.extensions).toBe(join(HOME, ".omp/agent/extensions"));
	expect(cfg.adapter?.pins).toBe(join(HOME, ".omp/agent/agents"));
	expect(cfg.guards.protected.some(p => p.endsWith("/extensions/"))).toBe(true);
	const again = installOmp(HOME);
	expect(again.overlay).toBe("unchanged");
	expect(again.pinsCopied).toEqual([]);
	expect(loadConfig({ home: HOME, env: {} }).adapter?.name).toBe("omp");
});

test("a compatibility bin dispatches by its filename", () => {
	rmSync(HOME, { recursive: true, force: true });
	initHome(HOME, { env: {} });
	const bin = join(import.meta.dir, "../bin/queue-check");
	const ran = spawnSync(bin, [], {
		encoding: "utf8",
		env: { HOME, PATH: process.env.PATH ?? "/usr/bin:/bin" },
	});
	expect(ran.status).toBe(0);
	expect(ran.stdout).toContain("Queue");
	expect(ran.stdout).not.toContain("Usage:");
});
