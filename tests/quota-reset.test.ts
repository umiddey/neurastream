import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

// quota-reset turns a provider's rate-limit reset time into the caller's local time. Runs the real
// bin under a sandbox HOME, with TZ=UTC as the caller's zone and no QUEUE_* variables.
const REPO = join(import.meta.dir, "..");
const BIN = join(REPO, "bin/quota-reset");
const roots: string[] = [];

afterAll(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function sandbox(config?: string): string {
	const home = mkdtempSync("/tmp/neurastream-home-quota-");
	roots.push(home);
	mkdirSync(join(home, ".config/neurastream"), { recursive: true });
	if (config !== undefined) writeFileSync(join(home, ".config/neurastream/config.yml"), config);
	return home;
}

function quota(home: string, args: string[]): { code: number; stdout: string; stderr: string } {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined && !key.startsWith("QUEUE_")) env[key] = value;
	}
	const r = spawnSync(process.execPath, [BIN, ...args], {
		encoding: "utf8",
		env: { ...env, HOME: home, TZ: "UTC" },
	});
	return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

// 08:00 in Asia/Shanghai (the default reset_tz) is 00:00 UTC.
const FUTURE = "2099-01-01 08:00:00";

test("quota-reset converts the provider's reset zone to the caller's local time", () => {
	const r = quota(sandbox(), [FUTURE]);
	expect(r.code).toBe(0);
	expect(r.stdout).toContain("quota reset (local): 2099-01-01 00:00:00");
	expect(r.stdout).toContain("in ");
});

test("a reset time already past says ALREADY BACK and names the label", () => {
	const r = quota(sandbox(), ["2000-01-01 08:00:00"]);
	expect(r.code).toBe(0);
	expect(r.stdout).toContain("ALREADY BACK");
	expect(r.stdout).toContain("Use quota now.");
});

test("--tz overrides reset_tz", () => {
	const r = quota(sandbox(), [FUTURE, "--tz", "UTC"]);
	expect(r.code).toBe(0);
	expect(r.stdout).toContain("quota reset (local): 2099-01-01 08:00:00");
});

test("the label comes from quota.label", () => {
	const r = quota(sandbox('quota:\n  label: "GLM"\n'), ["2000-01-01 08:00:00"]);
	expect(r.stdout).toContain("GLM reset (local):");
	expect(r.stdout).toContain("Use GLM now.");
});

test("a legacy glm: section still sets the zone and label", () => {
	const r = quota(sandbox('glm:\n  reset_tz: "Asia/Shanghai"\n  label: "GLM"\n'), [FUTURE]);
	expect(r.code).toBe(0);
	expect(r.stdout).toContain("GLM reset (local): 2099-01-01 00:00:00");
});

test("no time exits 2 with the usage line", () => {
	const r = quota(sandbox(), []);
	expect(r.code).toBe(2);
	expect(r.stderr).toContain('usage: quota-reset "YYYY-MM-DD HH:MM[:SS]" [--tz <zone>]');
});
