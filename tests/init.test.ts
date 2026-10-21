import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installOmp } from "../src/adapters/omp/install.ts";
import { loadConfig } from "../src/core/config.ts";
import { initHome, treeHash } from "../src/cli/init.ts";

const HOME = "/tmp/neurastream-home-init";
const NOOMP_HOME = "/tmp/neurastream-home-init-noomp";

afterAll(() => {
	rmSync(HOME, { recursive: true, force: true });
	rmSync(NOOMP_HOME, { recursive: true, force: true });
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
	const rendered = readFileSync(join(HOME, ".config/neurastream/queue/TEMPLATE.md"), "utf8");
	expect(rendered).toContain(`Worktree: ${HOME}/Work/<repo>-<topic>`);
	expect(rendered).not.toContain("{{HOME}}");
	expect(rendered).not.toContain("/home/");

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

test("adapter install keeps one omp load route: no extension link, stale symlink removed, plugin linked", () => {
	rmSync(HOME, { recursive: true, force: true });
	initHome(HOME, { env: {} });
	const extension = join(HOME, ".omp/agent/extensions/neurastream.ts");
	const installed = installOmp(HOME);
	// P9: omp loads extensions-dir files AND the plugin package's
	// package.json#omp.extensions, so a link here loads every hook twice.
	// The plugin route is the only one; it is what guard parity locks.
	expect(existsSync(extension)).toBe(false);
	expect(existsSync(installed.plugin)).toBe(true);
	expect(installed.pinsCopied.length).toBe(17);
	const cfg = loadConfig({ home: HOME, env: {} });
	expect(cfg.adapter?.name).toBe("omp");
	expect(cfg.adapter?.extensions).toBe(join(HOME, ".omp/agent/extensions"));
	expect(cfg.adapter?.pins).toBe(join(HOME, ".omp/agent/agents"));
	expect(cfg.guards.protected.some(p => p.endsWith("/extensions/"))).toBe(true);
	// A stale link from an older install is removed; a file someone else put
	// there is never ours to delete. The dir is created here because an old
	// install is the only thing that would have made it (current install
	// doesn't; omp's loader treats a missing extensions dir as empty).
	mkdirSync(join(HOME, ".omp/agent/extensions"), { recursive: true });
	symlinkSync(join(HOME, "gone-target"), extension);
	const second = installOmp(HOME);
	expect(second.removedStaleLink).toBe(extension);
	expect(existsSync(extension)).toBe(false);
	writeFileSync(extension, "// not neurastream's\n");
	const third = installOmp(HOME);
	expect(third.removedStaleLink).toBeNull();
	expect(readFileSync(extension, "utf8")).toBe("// not neurastream's\n");
	rmSync(extension);
	const again = installOmp(HOME);
	expect(again.overlay).toBe("unchanged");
	expect(again.pinsCopied).toEqual([]);
	expect(loadConfig({ home: HOME, env: {} }).adapter?.name).toBe("omp");
	// four installs, each running the real `omp plugin link` (~1-2 s apiece on CI runners)
}, 60_000);

test("adapter install: missing omp binary fails with a clear error, no plugin link", () => {
	rmSync(NOOMP_HOME, { recursive: true, force: true });
	initHome(NOOMP_HOME, { env: {} });
	// installOmp resolves `omp` through the parent's PATH, so the test narrows the
	// live process PATH to directories without an omp binary and restores it after.
	const savedPath = process.env.PATH;
	process.env.PATH = "/usr/bin:/bin";
	try {
		expect(() => installOmp(NOOMP_HOME)).toThrow(
			"omp not found on PATH: install oh-my-pi (npm i -g @oh-my-pi/pi-coding-agent) and retry",
		);
	} finally {
		process.env.PATH = savedPath;
	}
	expect(existsSync(join(NOOMP_HOME, ".omp/plugins"))).toBe(false);
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

test("packed templates contain no /home/ path", () => {
	const dest = join(HOME, "pack");
	rmSync(dest, { recursive: true, force: true });
	mkdirSync(dest, { recursive: true });
	const packed = spawnSync("npm", ["pack", "--silent", "--pack-destination", dest], {
		cwd: join(import.meta.dir, ".."),
		encoding: "utf8",
	});
	expect(packed.status).toBe(0);
	const names = readdirSync(dest).filter(n => n.endsWith(".tgz"));
	expect(names).toHaveLength(1);
	const extract = join(dest, "extract");
	mkdirSync(extract);
	const untar = spawnSync("tar", ["-xzf", join(dest, names[0]!), "-C", extract], { encoding: "utf8" });
	expect(untar.status).toBe(0);
	const hits: string[] = [];
	const walk = (dir: string) => {
		for (const name of readdirSync(dir)) {
			const path = join(dir, name);
			if (statSync(path).isDirectory()) {
				walk(path);
				continue;
			}
			if (readFileSync(path).includes(Buffer.from("/home/"))) hits.push(path);
		}
	};
	walk(extract);
	expect(hits.filter(p => p.includes("/templates/"))).toEqual([]);
	expect(hits).toEqual([]);
});
