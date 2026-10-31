// `neurastream config set|get|list` (plan 20261028_2356 P1b): the non-interactive door to the
// generic config editor. Every test runs against a temp HOME; nothing touches the real config.

import { afterAll, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { run } from "../src/cli/dispatch.ts";
import { runConfigKeys } from "../src/cli/config-set.ts";
import { configFile, loadConfig } from "../src/core/config.ts";

const TMP = mkdtempSync(join(tmpdir(), "config-set-"));
const HOME = join(TMP, "home");
const CONFIG_FILE = configFile(HOME);

// The caller's shell may export live QUEUE_* overrides; loadConfig would see them. Save and
// delete them, put them back at the end (same pattern as tests/ui-on-off.test.ts).
const queueEnvBefore = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("QUEUE_")));
for (const k of Object.keys(queueEnvBefore)) delete process.env[k];

afterAll(() => {
	rmSync(TMP, { recursive: true, force: true });
	for (const k of Object.keys(process.env)) if (k.startsWith("QUEUE_")) delete process.env[k];
	Object.assign(process.env, queueEnvBefore);
});

beforeEach(() => {
	rmSync(HOME, { recursive: true, force: true });
	mkdirSync(HOME, { recursive: true });
});

function writeConfig(text: string): void {
	mkdirSync(dirname(CONFIG_FILE), { recursive: true });
	writeFileSync(CONFIG_FILE, text);
}

// Runs fn with console.log/error captured; the real console is restored even when fn throws.
async function capture(fn: () => number | Promise<number>): Promise<{ code: number; out: string; err: string }> {
	const out: string[] = [];
	const err: string[] = [];
	const log = console.log;
	const error = console.error;
	const warn = console.warn;
	console.log = (...a: unknown[]) => void out.push(a.map(String).join(" "));
	console.error = (...a: unknown[]) => void err.push(a.map(String).join(" "));
	console.warn = (...a: unknown[]) => void err.push(a.map(String).join(" "));
	try {
		const code = await fn();
		return { code, out: out.join("\n"), err: err.join("\n") };
	} finally {
		console.log = log;
		console.error = error;
		console.warn = warn;
	}
}

test("set then get round-trips a typed number", async () => {
	expect((await capture(() => runConfigKeys(["set", "ui.port", "7788"], HOME))).code).toBe(0);
	expect(readFileSync(CONFIG_FILE, "utf8")).toBe("ui:\n  port: 7788\n");
	const got = await capture(() => runConfigKeys(["get", "ui.port"], HOME));
	expect(got.code).toBe(0);
	expect(got.out).toBe("7788");
});

test("set writes booleans, numbers and lists typed; lists as one flow-style line", async () => {
	expect((await capture(() => runConfigKeys(["set", "ui.enabled", "true"], HOME))).code).toBe(0);
	expect((await capture(() => runConfigKeys(["set", "rules.max_bytes", "7788"], HOME))).code).toBe(0);
	expect((await capture(() => runConfigKeys(["set", "paths.work_roots", '["a","b"]'], HOME))).code).toBe(0);
	const text = readFileSync(CONFIG_FILE, "utf8");
	expect(text).toContain("  enabled: true\n");
	expect(text).toContain("  max_bytes: 7788\n");
	expect(text).toContain('  work_roots: ["a", "b"]\n');
	expect((await capture(() => runConfigKeys(["get", "paths.work_roots"], HOME))).out).toBe('["a","b"]');
	expect((await capture(() => runConfigKeys(["get", "ui.enabled"], HOME))).out).toBe("true");
});

test("a comment line and key order elsewhere in the file survive a set", async () => {
	writeConfig("# keep this\nharness: omp\nui:\n  port: 7788  # the port\n");
	expect((await capture(() => runConfigKeys(["set", "ui.port", "9000"], HOME))).code).toBe(0);
	expect(readFileSync(CONFIG_FILE, "utf8")).toBe("# keep this\nharness: omp\nui:\n  port: 9000  # the port\n");
});

test("an unknown key is refused non-zero, lists the valid keys, and writes nothing", async () => {
	const set = await capture(() => runConfigKeys(["set", "nope.key", "1"], HOME));
	expect(set.code).toBe(1);
	expect(set.err).toContain("unknown key");
	expect(set.err).toContain("ui.port");
	expect((await capture(() => runConfigKeys(["get", "nope.key"], HOME))).code).toBe(1);
	expect(existsSync(CONFIG_FILE)).toBe(false);
});

test("a value that makes the config fail to load is refused and the file is untouched", async () => {
	writeConfig("ui:\n  port: 7788\n");
	const before = readFileSync(CONFIG_FILE, "utf8");
	const set = await capture(() => runConfigKeys(["set", "paths.work_roots", "7"], HOME));
	expect(set.code).toBe(1);
	expect(readFileSync(CONFIG_FILE, "utf8")).toBe(before);
});

test("list prints every valid key with its current value", async () => {
	const got = await capture(() => runConfigKeys(["list"], HOME));
	expect(got.code).toBe(0);
	expect(got.out).toContain("rules.max_bytes = 24000");
	expect(got.out).toContain("harness = omp");
});

test("bare config still prints the merged config, unchanged", async () => {
	// Bun's os.homedir() ignores runtime changes to process.env.HOME, so this compares against the same
	// no-argument loadConfig() the bare branch uses. It reads the real config, read-only; nothing is written.
	const plain = await capture(() => run("config", []));
	expect(plain.code).toBe(0);
	expect(plain.out).toBe(JSON.stringify(loadConfig()));
	const json = await capture(() => run("config", ["--json"]));
	expect(json.out).toBe(JSON.stringify(loadConfig(), null, 2));
});
