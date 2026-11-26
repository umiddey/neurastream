// Reuse CLI (plan 20261122_1828_reuse_map P3): `neurastream reuse on|off|status|map` against a
// sandbox HOME with fake `graphify`/uv/pipx scripts on a sandbox PATH. The fake graphify answers
// only --version, extract and query; update, hook and anything else exit 1, so any code path
// that ran them would fail every test in this file. Most runs go through the real bin
// (src/cli/main.ts) with a piped stdin, so TTY-less behaviour and exit codes are the real ones;
// the per-repo y/N prompt runs in-process against injected deps and a fake seam.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig, type Config } from "../src/core/config.ts";
import { GRAPHIFY_VERSION, excludePresent, reuseMapDoctor, reuseOn, type ReuseDeps, type ReuseGraph } from "../src/core/reuse-map.ts";

const REPO = join(import.meta.dir, "..");
const CLI = join(REPO, "src/cli/main.ts");
const ROOTS: string[] = [];

afterAll(() => {
	for (const r of ROOTS) rmSync(r, { recursive: true, force: true });
});

function sandbox(label: string): string {
	const h = mkdtempSync(join(tmpdir(), `reuse-cli-${label}-`));
	ROOTS.push(h);
	return h;
}

function git(dir: string, ...args: string[]): void {
	const r = spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: dir, encoding: "utf8" });
	if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
}

/** A committed git repo with a src file naming "alpha" twice; docs/plans unless opts.plans is false. */
function planRepo(work: string, name: string, opts: { plans?: boolean } = {}): string {
	const repo = join(work, name);
	mkdirSync(join(repo, "src"), { recursive: true });
	if (opts.plans !== false) mkdirSync(join(repo, "docs/plans"), { recursive: true });
	writeFileSync(join(repo, "src/a.ts"), "export const alphaOne = 1; // alpha\nconst filler = 2;\nexport const alphaTwo = alphaOne; // alpha again\n");
	git(repo, "init", "-q");
	git(repo, "add", "src/a.ts");
	git(repo, "commit", "-qm", "init");
	return repo;
}

function writeConfig(h: string, work: string | null, reuse = "reuse_map:\n  enabled: false"): string {
	const file = join(h, ".config/neurastream/config.yml");
	mkdirSync(dirname(file), { recursive: true });
	const paths = [`  home: "${h}"`, ...(work ? [`  work_roots: ["${work}"]`] : [])];
	writeFileSync(file, [`paths:`, ...paths, ...(reuse ? [reuse] : [])].filter(Boolean).join("\n").concat("\n"));
	return file;
}

/** The fake graphify: `update`, `hook` and anything unimplemented exit 1. */
const GRAPHIFY_BODY = `#!/bin/sh
case "$1" in
	--version)
		echo "graphify ${GRAPHIFY_VERSION}"
		exit 0
		;;
	extract)
		here=$(basename "$PWD")
		if [ -n "$FAIL_REPO" ] && [ "$FAIL_REPO" = "$here" ]; then
			echo "fake extract boom in $here" >&2
			exit 9
		fi
		if [ -n "$CFG_PROBE" ] && grep -q "enabled: true" "$CFG_PROBE" 2>/dev/null; then
			echo "config was written before the build" >&2
			exit 7
		fi
		mkdir -p graphify-out
		printf '{"nodes": [{"id": "n1"}]}' > graphify-out/graph.json
		exit 0
		;;
	query)
		case "$2" in
			zzz*)
				echo "No matching nodes found." >&2
				exit 4
				;;
			*)
				echo "NODE one() [src=src/a.ts loc=L1]"
				exit 0
				;;
		esac
		;;
	*)
		echo "the real seam never runs: graphify $1" >&2
		exit 1
		;;
esac
`;

/** A bin dir with the fake graphify, plus recording uv/pipx that "install" graphify into it. */
function fakeBins(h: string): string {
	const bin = join(h, "bin");
	mkdirSync(bin, { recursive: true });
	writeFileSync(join(bin, "graphify"), GRAPHIFY_BODY);
	chmodSync(join(bin, "graphify"), 0o755);
	const installer = `#!/bin/sh
printf '%s\\n' "$*" >> "$TOOL_LOG"
if [ -n "$GRAPHIFY_SRC" ]; then
	cp "$GRAPHIFY_SRC" "$(dirname "$0")/graphify"
	chmod +x "$(dirname "$0")/graphify"
fi
exit 0
`;
	for (const tool of ["uv", "pipx"]) {
		writeFileSync(join(bin, tool), installer);
		chmodSync(join(bin, tool), 0o755);
	}
	return bin;
}

function childEnv(h: string, bin: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	return {
		...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("QUEUE_"))),
		HOME: h,
		PATH: `${bin}:${process.env.PATH ?? ""}`,
		...extra,
	};
}

function run(h: string, bin: string, args: string[], extra: NodeJS.ProcessEnv = {}): { code: number; stdout: string; stderr: string } {
	const r = spawnSync(process.execPath, [CLI, "reuse", ...args], { env: childEnv(h, bin, extra), cwd: h, encoding: "utf8" });
	return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** The seam stand-in for in-process runs: version answers, build writes a readable graph. */
function fakeGraph(): ReuseGraph {
	return {
		version: () => ({ status: 0, stdout: `graphify ${GRAPHIFY_VERSION}`, stderr: "" }),
		build: (repo: string) => {
			mkdirSync(join(repo, "graphify-out"), { recursive: true });
			writeFileSync(join(repo, "graphify-out/graph.json"), '{"nodes": []}');
			return { status: 0, stdout: "ok", stderr: "" };
		},
		query: () => ({ status: 4, stdout: "No matching nodes found.", stderr: "" }),
	};
}

/** A sandbox with the map already on for one repo; returns what the map/status tests need. */
function mapped(h: string): { bin: string; r1: string; plan: string } {
	const work = join(h, "Work");
	mkdirSync(work, { recursive: true });
	const r1 = planRepo(work, "alpha");
	writeConfig(h, work);
	const bin = fakeBins(h);
	expect(run(h, bin, ["on", r1]).code).toBe(0);
	return { bin, r1, plan: join(r1, "docs/plans/20261126_1200_toy.md") };
}

describe("reuse on", () => {
	test("args skip the prompt; config.yml is written last (the build fails if it was not)", () => {
		const h = sandbox("args");
		const work = join(h, "Work");
		mkdirSync(work, { recursive: true });
		const r1 = planRepo(work, "alpha");
		const cfgFile = writeConfig(h, work);
		const before = readFileSync(cfgFile, "utf8");
		const bin = fakeBins(h);
		// CFG_PROBE makes the fake build exit 7 when the config already says enabled: true —
		// so a green run proves the build happened while the config was still untouched.
		const r = run(h, bin, ["on", r1], { CFG_PROBE: cfgFile });
		expect(r.code).toBe(0);
		expect(r.stderr).not.toContain("config was written before the build");
		expect(r.stdout).toContain(`mapped ${r1}`);
		const cfg = readFileSync(cfgFile, "utf8");
		expect(cfg).toContain("enabled: true");
		expect(cfg).toContain(`["${r1}"]`);
		expect(existsSync(join(r1, "graphify-out/graph.json"))).toBe(true);
		expect(excludePresent(r1)).toBe(true);
		const exclude = readFileSync(join(r1, ".git/info/exclude"), "utf8");
		expect(exclude).toContain("# neurastream reuse map");
		expect(exclude).toContain("graphify-out/");
		expect(before).toContain("enabled: false");
	}, 60_000);

	test("the pinned package is installed with uv when graphify is missing", () => {
		const h = sandbox("install");
		const work = join(h, "Work");
		mkdirSync(work, { recursive: true });
		const r1 = planRepo(work, "alpha");
		writeConfig(h, work);
		const bin = fakeBins(h);
		rmSync(join(bin, "graphify")); // nothing answers --version until the installer runs
		const src = join(h, "tools/graphify.fake");
		mkdirSync(dirname(src), { recursive: true });
		writeFileSync(src, GRAPHIFY_BODY);
		chmodSync(src, 0o755);
		const log = join(h, "tools.log");
		const r = run(h, bin, ["on", r1], { GRAPHIFY_SRC: src, TOOL_LOG: log });
		expect(r.code).toBe(0);
		const lines = readFileSync(log, "utf8").trim().split("\n");
		expect(lines).toHaveLength(1); // uv, not pipx, and exactly one install run
		expect(lines[0]).toContain("graphifyy==");
		expect(lines[0]).not.toContain("uninstall");
		expect(existsSync(join(r1, "graphify-out/graph.json"))).toBe(true);
	}, 60_000);

	test("neither uv nor pipx: exit 1 with the fix, nothing written", () => {
		const h = sandbox("notools");
		const work = join(h, "Work");
		mkdirSync(work, { recursive: true });
		const r1 = planRepo(work, "alpha");
		const cfgFile = writeConfig(h, work);
		const before = readFileSync(cfgFile, "utf8");
		const bin = join(h, "empty-bin");
		mkdirSync(bin, { recursive: true }); // on PATH, holds nothing
		const r = run(h, bin, ["on", r1], { PATH: bin });
		expect(r.code).toBe(1);
		expect(r.stderr).toContain("install uv or pipx");
		expect(readFileSync(cfgFile, "utf8")).toBe(before);
		expect(existsSync(join(r1, "graphify-out"))).toBe(false);
		expect(excludePresent(r1)).toBe(false);
	}, 60_000);

	test("a second-repo failure rolls back this run's repos and leaves config.yml byte-identical", () => {
		const h = sandbox("rollback");
		const work = join(h, "Work");
		mkdirSync(work, { recursive: true });
		const r1 = planRepo(work, "a-good");
		const r2 = planRepo(work, "b-bad");
		const cfgFile = writeConfig(h, work);
		const before = readFileSync(cfgFile, "utf8");
		const bin = fakeBins(h);
		const r = run(h, bin, ["on", r1, r2], { FAIL_REPO: "b-bad" });
		expect(r.code).toBe(1);
		expect(r.stderr).toContain("fake extract boom in b-bad");
		expect(r.stderr).toContain("rolled back");
		expect(readFileSync(cfgFile, "utf8")).toBe(before);
		expect(excludePresent(r1)).toBe(false);
		expect(existsSync(join(r1, "graphify-out"))).toBe(false);
		expect(excludePresent(r2)).toBe(false);
		expect(existsSync(join(r2, "graphify-out"))).toBe(false);
	}, 60_000);

	test("no TTY and no args: exit 2 listing the candidates, nothing written", () => {
		const h = sandbox("nontty");
		const work = join(h, "Work");
		mkdirSync(work, { recursive: true });
		const r1 = planRepo(work, "a-plans");
		const r2 = planRepo(work, "b-noplans", { plans: false });
		mkdirSync(join(work, "c-plain"), { recursive: true });
		const cfgFile = writeConfig(h, work);
		const before = readFileSync(cfgFile, "utf8");
		const bin = fakeBins(h);
		const r = run(h, bin, ["on"]);
		expect(r.code).toBe(2);
		expect(r.stderr).toContain("stdin is not a terminal");
		expect(r.stderr).toContain(r1);
		expect(r.stderr).not.toContain(r2);
		expect(r.stderr).not.toContain("c-plain");
		expect(readFileSync(cfgFile, "utf8")).toBe(before);
		expect(excludePresent(r1)).toBe(false);
	}, 60_000);

	test("on a terminal it asks y/N per repo in sorted order and maps only the yes ones", () => {
		const h = sandbox("prompt");
		const work = join(h, "Work");
		mkdirSync(work, { recursive: true });
		const r1 = planRepo(work, "a-first");
		const r2 = planRepo(work, "b-second");
		writeConfig(h, work);
		const bin = fakeBins(h);
		const prompts: string[] = [];
		const answers = ["n", "y"];
		const deps: ReuseDeps = {
			home: h,
			env: { PATH: `${bin}:${process.env.PATH ?? ""}` },
			terminal: true,
			ask: (q) => {
				prompts.push(q);
				return answers.shift() ?? "n";
			},
		};
		const r = reuseOn([], deps, fakeGraph());
		expect(r.code).toBe(0);
		expect(prompts).toEqual([`Map ${r1} with graphify? [y/N] `, `Map ${r2} with graphify? [y/N] `]);
		expect(r.out.join("\n")).toContain(`mapped ${r2}`);
		const cfg = readFileSync(join(h, ".config/neurastream/config.yml"), "utf8");
		expect(cfg).toContain(`["${r2}"]`);
		expect(cfg).not.toContain(r1);
		expect(excludePresent(r1)).toBe(false);
		expect(excludePresent(r2)).toBe(true);

		const none = reuseOn([], { ...deps, ask: () => "n" }, fakeGraph());
		expect(none.code).toBe(0);
		expect(none.out.join("\n")).toContain("nothing selected");
	}, 60_000);

	test("idempotent: a second on of the same repo rewrites the same config bytes", () => {
		const h = sandbox("idem");
		const work = join(h, "Work");
		mkdirSync(work, { recursive: true });
		const r1 = planRepo(work, "alpha");
		writeConfig(h, work);
		const bin = fakeBins(h);
		expect(run(h, bin, ["on", r1]).code).toBe(0);
		const after1 = readFileSync(join(h, ".config/neurastream/config.yml"), "utf8");
		const second = run(h, bin, ["on", r1]);
		expect(second.code).toBe(0);
		expect(readFileSync(join(h, ".config/neurastream/config.yml"), "utf8")).toBe(after1);
		expect(after1.match(new RegExp(r1, "g"))).toHaveLength(1);
	}, 60_000);

	test("a worktree maps too: the exclude line lands in the main .git's info/exclude", () => {
		const h = sandbox("worktree");
		const work = join(h, "Work");
		mkdirSync(work, { recursive: true });
		const main = planRepo(work, "main-repo");
		const wt = join(work, "wt-branch");
		git(main, "worktree", "add", wt, "-b", "wt");
		writeConfig(h, work);
		const bin = fakeBins(h);
		const r = run(h, bin, ["on", wt]);
		expect(r.code).toBe(0);
		expect(readFileSync(join(main, ".git/info/exclude"), "utf8")).toContain("# neurastream reuse map");
		expect(existsSync(join(wt, "graphify-out/graph.json"))).toBe(true);
	}, 60_000);

	test("an argument that is not a git repository is refused with exit 2", () => {
		const h = sandbox("badarg");
		const elsewhere = join(h, "elsewhere");
		mkdirSync(elsewhere, { recursive: true });
		writeConfig(h, null);
		const bin = fakeBins(h);
		const r = run(h, bin, ["on", elsewhere]);
		expect(r.code).toBe(2);
		expect(r.stderr).toContain(`${elsewhere} is not a git repository`);
	}, 60_000);
});

describe("reuse off", () => {
	test("off reverses on; --purge deletes graphify-out and uninstalls the tool; off is idempotent", () => {
		const h = sandbox("off");
		const work = join(h, "Work");
		mkdirSync(work, { recursive: true });
		const r1 = planRepo(work, "alpha");
		writeConfig(h, work);
		const bin = fakeBins(h);
		const log = join(h, "tools.log");
		expect(run(h, bin, ["on", r1], { TOOL_LOG: log }).code).toBe(0);

		const r = run(h, bin, ["off", "--purge"], { TOOL_LOG: log });
		expect(r.code).toBe(0);
		const cfg = readFileSync(join(h, ".config/neurastream/config.yml"), "utf8");
		expect(cfg).toContain("enabled: false");
		expect(cfg).toContain("repos: []");
		expect(excludePresent(r1)).toBe(false);
		expect(existsSync(join(r1, "graphify-out"))).toBe(false);
		expect(readFileSync(log, "utf8")).toContain("uninstall");
		expect(readFileSync(log, "utf8")).toContain("graphifyy");

		const again = run(h, bin, ["off"]);
		expect(again.code).toBe(0);
		expect(again.stdout).toContain("already off");
	}, 60_000);
});

describe("reuse status", () => {
	test("status --json reports version, age and fresh; stale is a state, not a problem", () => {
		const h = sandbox("status");
		const work = join(h, "Work");
		mkdirSync(work, { recursive: true });
		const r1 = planRepo(work, "alpha");
		writeConfig(h, work);
		const bin = fakeBins(h);
		expect(run(h, bin, ["on", r1]).code).toBe(0);

		const ok = run(h, bin, ["status", "--json"]);
		expect(ok.code).toBe(0);
		const parsed = JSON.parse(ok.stdout);
		expect(parsed.enabled).toBe(true);
		expect(parsed.version).toBe(GRAPHIFY_VERSION);
		expect(parsed.problems).toEqual([]);
		expect(parsed.repos[0].repo).toBe(r1);
		expect(parsed.repos[0].fresh).toBe(true);

		// A code change makes the graph stale but readable: reported, exit stays 0.
		writeFileSync(join(r1, "src/a.ts"), `${readFileSync(join(r1, "src/a.ts"), "utf8")}export const newer = 3;\n`);
		const stale = run(h, bin, ["status"]);
		expect(stale.code).toBe(0);
		expect(stale.stdout).toContain("stale");

		// No graph at all is a problem: exit 1, named.
		rmSync(join(r1, "graphify-out"), { recursive: true });
		const broken = run(h, bin, ["status", "--json"]);
		expect(broken.code).toBe(1);
		expect(JSON.parse(broken.stdout).problems.join("\n")).toContain("no readable graphify-out/graph.json");
	}, 60_000);

	test("status when the map is off is ok and says so", () => {
		const h = sandbox("statusoff");
		writeConfig(h, null);
		const bin = fakeBins(h);
		const text = run(h, bin, ["status"]);
		expect(text.code).toBe(0);
		expect(text.stdout).toContain("reuse map: off");
		const json = run(h, bin, ["status", "--json"]);
		expect(JSON.parse(json.stdout).enabled).toBe(false);
	}, 60_000);
});

describe("reuse map", () => {
	test("prints the map line plus up to 5 path:line candidates per matched file", () => {
		const h = sandbox("map");
		const { bin, plan } = mapped(h);
		const r = run(h, bin, ["map", plan, "alpha"]);
		expect(r.code).toBe(0);
		const out = r.stdout.split("\n");
		expect(out[0]).toBe('- map: graphify "alpha" → src/a.ts — cite: 1');
		expect(r.stdout).toContain('src/a.ts:1 "export const alphaOne = 1; // alpha"');
		expect(r.stdout).toContain('src/a.ts:3 "export const alphaTwo = alphaOne; // alpha again"');
	}, 60_000);

	test("all terms missing: the none line with 3 terms; fewer refuses", () => {
		const h = sandbox("map-none");
		const { bin, plan } = mapped(h);
		const none = run(h, bin, ["map", plan, "zzz1", "zzz2", "zzz3"]);
		expect(none.code).toBe(0);
		expect(none.stdout.split("\n")[0]).toBe('- new: none to reuse — searched: "zzz1", "zzz2", "zzz3"');
		const few = run(h, bin, ["map", plan, "zzz1"]);
		expect(few.code).toBe(1);
		expect(few.stderr).toContain("3 distinct terms");
	}, 60_000);

	test("an unmapped repo refuses with the reuse on fix", () => {
		const h = sandbox("map-unmapped");
		const { bin, r1, plan } = mapped(h);
		const other = planRepo(join(h, "Elsewhere"), "other");
		writeConfig(h, null, `reuse_map:\n  enabled: true\n  repos: ["${other}"]\n`);
		const r = run(h, bin, ["map", plan, "alpha"]);
		expect(r.code).toBe(1);
		expect(r.stderr).toContain(`${r1} is not mapped`);
		expect(r.stderr).toContain(`reuse on ${r1}`);
	}, 60_000);

	test("usage: no terms is exit 2; more than the term cap is refused", () => {
		const h = sandbox("map-usage");
		const { bin, plan } = mapped(h);
		expect(run(h, bin, ["map", plan]).code).toBe(2);
		const many = run(h, bin, ["map", plan, ...Array.from({ length: 9 }, (_, i) => `t${i}`)]);
		expect(many.code).toBe(1);
		expect(many.stderr).toContain("at most 8");
	}, 60_000);
});

describe("reuse usage and doctor lines", () => {
	test("an unknown subcommand is exit 2 with the usage line", () => {
		const h = sandbox("usage");
		const bin = fakeBins(h);
		const r = run(h, bin, ["bogus"]);
		expect(r.code).toBe(2);
		expect(r.stderr).toContain("usage: neurastream reuse on [<repo>...]");
	}, 60_000);

	test("doctor lines: off is one ok line and never touches the seam; a mapped repo reports", () => {
		const h = sandbox("doctor");
		const work = join(h, "Work");
		mkdirSync(work, { recursive: true });
		const r1 = planRepo(work, "alpha");
		const cfgOff = loadConfig({ file: writeConfig(h, work), home: h, env: {} });
		const cfgOn: Config = loadConfig({ file: writeConfig(h, null, `reuse_map:\n  enabled: true\n  repos: ["${r1}"]\n`), home: h, env: {} });
		const hostile: ReuseGraph = {
			...fakeGraph(),
			version: () => {
				throw new Error("the seam must not run while the map is off");
			},
		};
		const off = reuseMapDoctor(cfgOff, hostile);
		expect(off.ok).toEqual(["reuse map: off"]);
		expect(off.problems).toEqual([]);

		mkdirSync(join(r1, "graphify-out"), { recursive: true });
		writeFileSync(join(r1, "graphify-out/graph.json"), '{"nodes": []}');
		const on = reuseMapDoctor(cfgOn, fakeGraph());
		expect(on.problems).toEqual([]);
		expect(on.ok.join("\n")).toContain(`reuse map: graphify ${GRAPHIFY_VERSION}, 1 repo(s)`);
		expect(on.ok.join("\n")).toContain(`${r1} stale`);
	}, 60_000);
});
