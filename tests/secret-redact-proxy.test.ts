// The second net (plan 20261025_2204, P3): with `secrets.proxy: secretgate` the launcher runs the
// harness as `secretgate wrap -- omp`, so everything leaving the machine also passes the proxy. A
// machine without the binary still launches: the plan says one warning, never a block. No real
// secretgate is installed here — the binary check is a PATH lookup and the wrap is a command line.

import { afterAll, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/core/config.ts";
import { PROXY_BIN, proxyOnPath } from "../src/core/secret-redact.ts";
import { proxyPlan } from "../src/adapters/omp/launch.ts";

const HOME = "/tmp/neurastream-home-secret-redact-proxy";
const BIN = join(HOME, "bin");
const EMPTY = join(HOME, "empty");

afterAll(() => {
	rmSync(HOME, { recursive: true, force: true });
});

/** The shipped defaults, with no user config and no env overrides. */
function baseConfig() {
	return loadConfig({ home: HOME, env: {} });
}

test("proxy none (the default): the harness runs as itself and no warning is printed", () => {
	const plan = proxyPlan("omp", baseConfig(), true);
	expect(plan).toEqual({ cmd: "omp", prefix: [], warning: "" });
});

test("proxy secretgate with the binary: the harness runs under secretgate wrap --", () => {
	const cfg = baseConfig();
	cfg.secrets.proxy = "secretgate";
	const plan = proxyPlan("omp", cfg, true);
	expect(plan).toEqual({ cmd: PROXY_BIN, prefix: ["wrap", "--", "omp"], warning: "" });
});

test("proxy secretgate without the binary: a normal launch and exactly one warning", () => {
	const cfg = baseConfig();
	cfg.secrets.proxy = "secretgate";
	const plan = proxyPlan("omp", cfg, false);
	expect(plan.cmd).toBe("omp");
	expect(plan.prefix).toEqual([]);
	expect(plan.warning).toContain("is not on PATH");
	expect(plan.warning).toContain("without the proxy");
});

test("a config with an unknown proxy value is refused", () => {
	mkdirSync(HOME, { recursive: true });
	const file = join(HOME, "bad.yml");
	writeFileSync(file, "secrets:\n  proxy: socks\n");
	expect(() => loadConfig({ home: HOME, env: {}, file })).toThrow('secrets.proxy must be "none" or "secretgate"');
});

test("proxyOnPath finds the binary on PATH and does not invent it", () => {
	rmSync(HOME, { recursive: true, force: true });
	mkdirSync(BIN, { recursive: true });
	mkdirSync(EMPTY, { recursive: true });
	writeFileSync(join(BIN, PROXY_BIN), "#!/bin/sh\n");
	expect(proxyOnPath({ PATH: BIN })).toBe(true);
	expect(proxyOnPath({ PATH: `${EMPTY}:${BIN}` })).toBe(true);
	expect(proxyOnPath({ PATH: EMPTY })).toBe(false);
	expect(proxyOnPath({})).toBe(false);
});
