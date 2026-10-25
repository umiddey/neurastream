import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/core/config.ts";

const REPO = join(import.meta.dir, "..");
const roots: string[] = [];

function configFile(text: string): { home: string; file: string } {
	const home = mkdtempSync("/tmp/neurastream-home-notice-");
	roots.push(home);
	mkdirSync(join(home, ".config/neurastream"), { recursive: true });
	const file = join(home, ".config/neurastream/config.yml");
	writeFileSync(file, text);
	return { home, file };
}

function load(text: string) {
	const { home, file } = configFile(text);
	return { file, cfg: () => loadConfig({ file, home, env: {} }) };
}

test("a top-level glm: section loads as quota: with a rename notice", () => {
	const { file, cfg } = load('glm:\n  reset_tz: "Asia/Shanghai"\n  label: "GLM"\n');
	const loaded = cfg();
	expect(loaded.quota).toEqual({
		reset_tz: "Asia/Shanghai",
		reset_pattern: String.raw`reset at (\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?)\s*(Z|UTC|GMT|[+-]\d{2}:?\d{2}|[A-Z]{2,5}\b)?`,
		label: "GLM",
	});
	expect(loaded.notices).toEqual([`config "glm:" is now "quota:"; rename it in ${file}`]);
});

test("a pm: section is ignored with a delete notice", () => {
	const { file, cfg } = load('pm:\n  backend_log: ""\n  fail_lines: 25\n');
	const loaded = cfg();
	expect(loaded.notices).toEqual([`config "pm:" was removed; delete it from ${file}`]);
});

test("a config with glm: and pm: loads with both notices", () => {
	const { file, cfg } = load('glm:\n  label: "GLM"\npm:\n  fail_lines: 25\n');
	const loaded = cfg();
	expect(loaded.quota.label).toBe("GLM");
	expect(loaded.notices).toEqual([
		`config "glm:" is now "quota:"; rename it in ${file}`,
		`config "pm:" was removed; delete it from ${file}`,
	]);
});

test("glm: next to quota: is not a legacy key: it fails as unknown", () => {
	const { cfg } = load('quota:\n  label: "quota"\nglm:\n  label: "GLM"\n');
	expect(() => cfg()).toThrow("unknown key glm");
});

test("no legacy keys means no notices", () => {
	const { cfg } = load('quota:\n  label: "GLM"\n');
	expect(cfg().notices).toEqual([]);
});

test("an unknown key still fails", () => {
	const { cfg } = load("bogus:\n  x: 1\n");
	expect(() => cfg()).toThrow("unknown key bogus");
});

test("doctor prints both legacy notices", () => {
	const { home, file } = configFile('glm:\n  label: "GLM"\npm:\n  fail_lines: 25\n');
	const r = spawnSync(process.execPath, [join(REPO, "src/cli/main.ts"), "doctor"], {
		encoding: "utf8",
		env: { ...process.env, HOME: home, QUEUE_AGENT: "", QUEUE_INDEX: "", QUEUE_BLOCKERS: "", QUEUE_STATE: "", QUEUE_SUBAGENTS: "", QUEUE_CANCELLED: "", QUEUE_UNLOCK: "" },
	});
	expect(r.stdout).toContain(`config "glm:" is now "quota:"; rename it in ${file}`);
	expect(r.stdout).toContain(`config "pm:" was removed; delete it from ${file}`);
});
