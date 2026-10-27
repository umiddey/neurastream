import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, loadConfig, TEMPLATE_PATH } from "../src/core/config.ts";
import type { RunSource } from "../src/core/adapter.ts";
import { toExtensionResult } from "../src/adapters/omp/index.ts";

const home = "/tmp/neurastream-home-config";

const cfgTmpDirs: string[] = [];
afterAll(() => {
	for (const dir of cfgTmpDirs) rmSync(dir, { recursive: true, force: true });
});

function withFile(yaml: string) {
	const dir = mkdtempSync(join(tmpdir(), "neurastream-cfg-"));
	cfgTmpDirs.push(dir);
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
		expect(cfg.paths.agent_dir).toBe(`${home}/.config/neurastream`);
		expect(cfg.paths.work_roots).toEqual([]);
		expect(cfg.ledger.providers.length).toBe(7);
	});

	test("rollover defaults to 5 MB when the user file has no rollover key", () => {
		const cfg = loadConfig({ file: withFile("wip:\n  limit: 3\n"), home, env: {} });
		expect(cfg.rollover.max_session_mb).toBe(5);
		expect(cfg.rollover.enabled).toBe(true);
		expect(cfg.rollover.exit_grace_s).toBe(20);
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

	test("knowledge defaults carry the roots template and expand $HOME", () => {
		const cfg = loadConfig({ file: "/tmp/neurastream-home-config/missing.yml", home, env: {} });
		expect(cfg.knowledge.roots).toEqual([`${home}/projects`, `${home}/Work`]);
		expect(cfg.knowledge.max_age_s).toBe(300);
		const own = loadConfig({ file: withFile('knowledge:\n  roots: ["~/pages"]\n'), home, env: {} });
		expect(own.knowledge.roots).toEqual([`${home}/pages`]);
		expect(own.knowledge.max_age_s).toBe(300);
	});

	test("knowledge rejects empty roots and a bad max_age_s", () => {
		expect(() => loadConfig({ file: withFile("knowledge:\n  roots: []\n"), home, env: {} })).toThrow(/knowledge.roots/);
		expect(() => loadConfig({ file: withFile("knowledge:\n  max_age_s: 0\n"), home, env: {} })).toThrow(
			/knowledge.max_age_s/,
		);
		expect(() => loadConfig({ file: withFile("knowledge:\n  max_age_s: many\n"), home, env: {} })).toThrow(/must be a number/);
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
	function filesUnder(dir: string): string[] {
		const out: string[] = [];
		for (const name of readdirSync(dir)) {
			const p = join(dir, name);
			if (statSync(p).isDirectory()) out.push(...filesUnder(p));
			else out.push(p);
		}
		return out;
	}

	test("src/core matches none of the forbidden tokens", () => {
		const root = join(import.meta.dir, "../src/core");
		const hits: string[] = [];
		// Same six tokens as the plan grep, substring match: a harness token such as ".omp" or
		// "OMP_" or "cursorX" must fail the scan. The only allowed carriers are the exact words
		// "complete" and "prompt" (required protocol words that contain the letters omp).
		const rx = /omp|oh-my-pi|claude|opencode|codex|cursor/gi;
		const CARRIERS: Record<string, true> = { complete: true, prompt: true };
		const forbiddenHits = (text: string): boolean => {
			for (const m of text.matchAll(rx)) {
				const at = m.index ?? 0;
				let a = at;
				let b = at + m[0].length;
				while (a > 0 && /[A-Za-z0-9]/.test(text[a - 1] ?? "")) a--;
				while (b < text.length && /[A-Za-z0-9]/.test(text[b] ?? "")) b++;
				const word = text.slice(a, b).toLowerCase();
				if (!CARRIERS[word]) return true;
			}
			return false;
		};
		for (const file of filesUnder(root)) {
			if (forbiddenHits(readFileSync(file, "utf8"))) hits.push(file.slice(root.length + 1));
		}
		expect(hits).toEqual([]);
		// The scan is substring-based: these must each be caught, word boundaries would miss them.
		expect(forbiddenHits('const x = process.env.OMP_DATA;')).toBe(true);
		expect(forbiddenHits("cursorX.forEach()")).toBe(true);
		expect(forbiddenHits('status === "complete" || /every prompt,/')).toBe(false);
		expect(readFileSync(TEMPLATE_PATH, "utf8").length).toBeGreaterThan(100);
	});
});
