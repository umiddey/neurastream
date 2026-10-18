import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, loadConfig, TEMPLATE_PATH } from "../src/core/config.ts";
import type { RunSource } from "../src/core/adapter.ts";
import { toExtensionResult } from "../src/adapters/omp/index.ts";

const home = "/tmp/neurastream-home-config";

function withFile(yaml: string) {
	const dir = mkdtempSync(join(tmpdir(), "neurastream-cfg-"));
	const file = join(dir, "config.yml");
	writeFileSync(file, yaml);
	return file;
}

describe("loadConfig", () => {
	test("defaults match today's thresholds", () => {
		const cfg = loadConfig({ file: "/tmp/neurastream-home-config/missing.yml", home, env: {} });
		expect(cfg.score.diagnose_weight).toBe(4);
		expect(cfg.score.penalties["false-claim"]).toBe(5);
		expect(cfg.score.penalties["rule-break"]).toBe(2);
		expect(cfg.score.penalties["escaped-defect"]).toBe(8);
		expect(cfg.guards.sub_warn_calls).toBe(90);
		expect(cfg.guards.sub_max_calls).toBe(100);
		expect(cfg.guards.main_edit_limit).toBe(5);
		expect(cfg.guards.main_window_min).toBe(15);
		expect(cfg.ledger.max_running_per_provider).toBe(2);
		expect(cfg.wip.limit).toBe(6);
		expect(cfg.machine.avail_min_mb).toBe(3072);
		expect(cfg.paths.home).toBe(home);
		expect(cfg.paths.work_roots).toEqual([`${home}/Work`, `${home}/projects`]);
		expect(cfg.ledger.providers.length).toBe(7);
	});

	test("user file merges one object level and replaces arrays", () => {
		const file = withFile("score:\n  penalties:\n    false-claim: 9\nledger:\n  providers: [one]\n");
		const cfg = loadConfig({ file, home, env: {} });
		expect(cfg.score.penalties["false-claim"]).toBe(9);
		expect(cfg.score.penalties["rule-break"]).toBe(2);
		expect(cfg.score.diagnose_weight).toBe(4);
		expect(cfg.ledger.providers).toEqual(["one"]);
	});

	test("unknown key and bad type are rejected", () => {
		expect(() => loadConfig({ file: withFile("nope: 1\n"), home, env: {} })).toThrow(ConfigError);
		expect(() => loadConfig({ file: withFile("wip:\n  limit: lots\n"), home, env: {} })).toThrow(/must be a number/);
	});

	test("warn above max is rejected", () => {
		const file = withFile("guards:\n  sub_warn_calls: 200\n  sub_max_calls: 100\n");
		expect(() => loadConfig({ file, home, env: {} })).toThrow(/sub_warn_calls/);
	});

	test("env overrides win over the file", () => {
		const file = withFile("wip:\n  limit: 3\n");
		const cfg = loadConfig({ file, home, env: { WIP_LIMIT: "9", QUEUE_INDEX: "~/q.md" } });
		expect(cfg.wip.limit).toBe(9);
		expect(cfg.paths.queue_index).toBe(`${home}/q.md`);
	});

	test("bad YAML is rejected", () => {
		expect(() => loadConfig({ file: withFile(":\n  - ["), home, env: {} })).toThrow(/YAML did not parse/);
	});
});

describe("adapter", () => {
	test("a run source satisfies the interface", () => {
		const src: RunSource = { listRuns: () => [], mainSession: () => null };
		expect(src.listRuns(0)).toEqual([]);
		expect(toExtensionResult({ allow: false, reason: "no" })).toEqual({
			block: true,
			reason: "no",
			decision: "block",
		});
		expect(toExtensionResult({ allow: true, reason: "", inject: "left" })).toEqual({ additionalContext: "left" });
	});
});

describe("core has no harness name", () => {
	test("src/core matches none of the forbidden tokens", () => {
		const root = join(import.meta.dir, "../src/core");
		const hits: string[] = [];
		const rx = /omp|oh-my-pi|claude|opencode|codex|cursor/i;
		for (const name of readdirSync(root)) {
			const text = readFileSync(join(root, name), "utf8");
			if (rx.test(text)) hits.push(name);
		}
		expect(hits).toEqual([]);
		expect(readFileSync(TEMPLATE_PATH, "utf8").length).toBeGreaterThan(100);
	});
});
