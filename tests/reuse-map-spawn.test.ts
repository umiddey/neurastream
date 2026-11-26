// Reuse map spawn gate (plan 20261122_1828_reuse_map P4b): a delegated planner's brief must carry a
// map or none line that the P2 re-run/compare accepts, checked through checkSpawn against a fake
// seam. Everything runs in temp dirs; the repo is a real git repo because freshGraph stamps from it.

import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { plannerFile } from "../src/core/autonomy.ts";
import { loadConfig, type Config } from "../src/core/config.ts";
import { checkSpawn } from "../src/core/guards/spawn.ts";
import { checkedCite, freshGraph, GRAPHIFY_VERSION, mapLine, type GraphifyResult, type ReuseGraph } from "../src/core/reuse-map.ts";

const TMP = mkdtempSync(join(tmpdir(), "reuse-spawn-"));
const REPO = join(TMP, "repo");
const PLAN = join(REPO, "docs/plans/20261126_1100_planner_toy.md");

mkdirSync(join(REPO, "docs/plans"), { recursive: true });
mkdirSync(join(REPO, "src"), { recursive: true });
writeFileSync(join(REPO, "src/a.ts"), "export const a = 1;\n");
writeFileSync(join(REPO, "src/b.ts"), "export const b = 2;\n");
for (const args of [["init", "-q"], ["add", "src/a.ts", "src/b.ts"], ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]])
	spawnSync("git", ["-C", REPO, ...args], { encoding: "utf8" });

afterAll(() => rmSync(TMP, { recursive: true, force: true }));

function withFile(body: string): string {
	const file = join(TMP, `cfg-${Math.random().toString(36).slice(2)}.yml`);
	writeFileSync(file, body);
	return file;
}

function cfgWith(repos: string[]): Config {
	const reuse = `reuse_map:\n  enabled: true\n  repos:\n${repos.map((r) => `    - "${r}"\n`).join("")}`;
	return loadConfig({
		file: withFile(`paths:\n  home: "${TMP}/home"\n  queue_state: "${TMP}/state"\n  plan_guard_log: "${TMP}/plan-guard.log"\nreview:\n  agents: [reviewer]\n${reuse}`),
		home: join(TMP, "home"),
		env: {},
	});
}
const cfg = cfgWith([REPO]);
mkdirSync(cfg.paths.queue_state, { recursive: true });
mkdirSync(dirname(cfg.paths.subagents), { recursive: true });
writeFileSync(cfg.paths.subagents, "## Allowed\n\n- `task`\n");

/** Delegated planner mode: the planner file says so, so the spawn gate binds the brief to the plan. */
function delegate(): void {
	writeFileSync(plannerFile(cfg.paths), "delegated\n");
}

/** The seam: "gate" hits both code files, graphify's exit codes and version as the real pin. */
function fakeGraphify(): { graph: ReuseGraph } {
	return {
		graph: {
			version: () => ({ status: 0, stdout: `graphify ${GRAPHIFY_VERSION}`, stderr: "" }),
			build: (repo: string): GraphifyResult => {
				mkdirSync(join(repo, "graphify-out"), { recursive: true });
				writeFileSync(join(repo, "graphify-out/graph.json"), JSON.stringify({ nodes: [{ id: "x" }] }));
				return { status: 0, stdout: "ok", stderr: "" };
			},
			query: (): GraphifyResult => ({
				status: 0,
				stdout: "NODE one() [src=src/a.ts loc=L1]\nNODE two() [src=src/b.ts loc=L1]",
				stderr: "",
			}),
		},
	};
}

const MAP_BLOCK = [
	mapLine(["gate"], ["src/a.ts", "src/b.ts"], 2),
	`- new: the gate — ${checkedCite("src/a.ts", 1, "export const a = 1;")} — reuse: existing a`,
	`- new: the other half — ${checkedCite("src/b.ts", 1, "export const b = 2;")} — reuse: existing b`,
].join("\n");

const brief = (reuse: string): string => `Planner role for ${PLAN}\n\nDraft the plan.\n\n## Reuse\n${reuse}\n`;

const spawn = (text: string, graph: ReuseGraph) =>
	checkSpawn({ agent: "task", invocationKind: "task", brief: text, name: "ReusePlanner" }, cfg, undefined, undefined, graph);

test("a delegated planner brief with no map or none line is refused naming the reuse map", () => {
	delegate();
	const d = spawn(brief("- new: the gate — reuse: existing"), fakeGraphify().graph);
	expect(d.allow).toBe(false);
	expect(d.reason).toContain("reuse map");
});

test("a delegated planner brief with a map line the fresh graph confirms is allowed", () => {
	delegate();
	const fake = fakeGraphify();
	// The brief check never builds (a stale map is refused, not rebuilt), so the map is built here first.
	expect(freshGraph(REPO, [], fake.graph)).toEqual([]);
	const d = spawn(brief(MAP_BLOCK), fake.graph);
	expect(d.allow).toBe(true);
});

test("the same brief is refused once the map is stale: the planner spawn never rebuilds", () => {
	delegate();
	const fake = fakeGraphify();
	expect(freshGraph(REPO, [], fake.graph)).toEqual([]);
	writeFileSync(join(REPO, "src/extra.ts"), "export const extra = 3;\n");
	const d = spawn(brief(MAP_BLOCK), fake.graph);
	expect(d.allow).toBe(false);
	expect(d.reason).toContain("is stale");
});
