// The managed AGENTS.md block: rendered from templates/AGENTS.md with the config's agent dir,
// upserted between two markers so every byte outside them stays the owner's.

import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installOmp } from "../src/adapters/omp/install.ts";
import { adapterLiveFiles } from "../src/adapters/omp/doctor.ts";
import { BEGIN_MARK, END_MARK, renderBlock } from "../src/core/agents-md.ts";
import { loadConfig } from "../src/core/config.ts";
import { initHome } from "../src/cli/init.ts";
import { checkInject } from "../src/core/guards.ts";
import { applyQueueEnv } from "../src/core/queue/env.ts";

const REPO = join(import.meta.dir, "..");
const HOME = "/tmp/neurastream-home-agentsmd";
const cfg = loadConfig({ home: HOME, env: {} });
const block = renderBlock(cfg);
const PERSONAL = "# my notes\n\nBe kind.\n\n- Pipelines on our local computer: one combined merge request at a time\n";

// Install and doctor run against their own sandbox HOME, with a stub npm that reports the package's own version.
const SANDBOX = "/tmp/neurastream-home-agentsmd-p2";
const AGENTS = join(SANDBOX, ".omp/agent/AGENTS.md");
const CLI = join(REPO, "src/cli/main.ts");
const INSTALLED = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).version as string;

afterAll(() => {
	rmSync(SANDBOX, { recursive: true, force: true });
});

function freshInstall(personal?: string) {
	rmSync(SANDBOX, { recursive: true, force: true });
	initHome(SANDBOX, { env: {} });
	mkdirSync(join(SANDBOX, ".omp/agent"), { recursive: true });
	if (personal !== undefined) writeFileSync(AGENTS, personal);
	return installOmp(SANDBOX);
}

function runDoctor() {
	const dir = join(SANDBOX, "stub-bin");
	mkdirSync(dir, { recursive: true });
	const npm = join(dir, "npm");
	writeFileSync(npm, `#!/bin/sh\necho ${INSTALLED}\n`);
	chmodSync(npm, 0o755);
	return spawnSync(process.execPath, [CLI, "doctor"], {
		encoding: "utf8",
		env: { ...process.env, HOME: SANDBOX, PATH: `${dir}:${process.env.PATH ?? ""}` },
	});
}

test("renderBlock fills in the agent dir and wraps the rules in the markers", () => {
	expect(block.startsWith(`${BEGIN_MARK}\n`)).toBe(true);
	expect(block.endsWith(`\n${END_MARK}`)).toBe(true);
	expect(block).toContain(`${HOME}/.config/neurastream/INDEX.md`);
	expect(block).not.toContain("{{AGENT_DIR}}");
});

test("the template holds only the neurastream rules: no owner-personal, provider, project or edit-limit text", () => {
	const tpl = readFileSync(join(REPO, "templates/AGENTS.md"), "utf8");
	for (const word of [
		"better person",
		"dumb",
		"one combined merge request",
		"GLM",
		"Grok",
		"Gateforge",
		"/home/ukd",
		"5 times",
		"15-minute",
		"Script changes go to neurastream",
		"pm-fail-facts",
		"glm-reset",
	]) {
		expect(tpl).not.toContain(word);
	}
	expect(/\b(PM|CP)\b/.test(tpl)).toBe(false);
	expect(tpl).toContain("{{AGENT_DIR}}/INDEX.md");
});

test("install never writes the block; it strips one an older install left, keeping the owner's bytes", () => {
	const first = freshInstall(PERSONAL);
	expect(first.agentsMd).toBe("unchanged");
	expect(readFileSync(AGENTS, "utf8")).toBe(PERSONAL);
	writeFileSync(AGENTS, `${PERSONAL}\n${block}\n- tail\n`);
	const removed = installOmp(SANDBOX);
	expect(removed.agentsMd).toBe("removed");
	const text = readFileSync(AGENTS, "utf8");
	expect(text).toBe(`${PERSONAL}\n\n- tail\n`);
	expect(text).not.toContain(BEGIN_MARK);
	expect(installOmp(SANDBOX).agentsMd).toBe("unchanged");
	expect(readFileSync(AGENTS, "utf8")).toBe(text);
});

test("a clean install passes doctor", () => {
	freshInstall(PERSONAL);
	const ran = runDoctor();
	expect(ran.stdout).toContain("neurastream doctor: ok");
	expect(ran.status).toBe(0);
});

test("a neurastream block left in the owner's AGENTS.md is reported stale", () => {
	freshInstall(PERSONAL);
	writeFileSync(AGENTS, `${PERSONAL}\n${block}\n`);
	const ran = runDoctor();
	expect(ran.stdout).toContain(`stale: neurastream block still in ${AGENTS}`);
	expect(ran.status).toBe(1);
});

test("an edit outside the block is not reported", () => {
	freshInstall(PERSONAL);
	writeFileSync(AGENTS, readFileSync(AGENTS, "utf8").replace("Be kind.", "Be kind, always."));
	const ran = runDoctor();
	expect(ran.stdout).toContain("neurastream doctor: ok");
	expect(ran.status).toBe(0);
});

test("a deleted linked bin is reported missing, not foreign", () => {
	freshInstall(PERSONAL);
	const bin = adapterLiveFiles(SANDBOX).find(f => f.live.includes("/.local/bin/"));
	if (!bin) throw new Error("no linked bin in adapterLiveFiles");
	unlinkSync(bin.live);
	const ran = runDoctor();
	expect(ran.stdout).toContain(`missing: ${bin.live}`);
	expect(ran.stdout).not.toContain("foreign:");
	expect(ran.status).toBe(1);
});
// P3: the edit limit shown to Main comes from config, never from template text.
const P3_HOME = "/tmp/neurastream-home-agentsmd-p3";
rmSync(P3_HOME, { recursive: true, force: true });
const p3Base = loadConfig({ home: P3_HOME, env: {} });
mkdirSync(p3Base.paths.queue_state, { recursive: true });
mkdirSync(p3Base.paths.agent_dir, { recursive: true });
applyQueueEnv(p3Base);
const tuned = { ...p3Base, guards: { ...p3Base.guards, main_edit_limit: 7, main_window_min: 20 } };

test("the main prompt states the tier and the edit limit from config", () => {
	const d = checkInject({ inject: "hello", agent: "main" }, tuned);
	expect(d.inject).toContain("autonomy: opinionated —");
	expect(d.inject).toContain("at most 7 project files per 20 min");
	expect(d.inject).not.toContain("at most 5");
});

test("a stop continuation does not repeat the tier line", () => {
	const d = checkInject({ inject: "main-guard: keep going", agent: "main" }, tuned);
	expect(d.inject).not.toContain("autonomy: opinionated");
});
