import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runLabels } from "../src/cli/labels.ts";
import { loadConfig, type Config } from "../src/core/config.ts";
import type { Episode } from "../src/core/episodes.ts";
import { openIncidents } from "../src/core/incidents.ts";
import { appendLabel, blameParty, flipAccepted, labelLedgerPath, readLabels } from "../src/core/labels.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function sandbox(): string {
	const dir = mkdtempSync(join(tmpdir(), "ns-label-party-"));
	dirs.push(dir);
	return dir;
}

function episode(overrides: Partial<Episode> = {}): Episode {
	return {
		id: "agent:plan:P2", agent: "agent", model: "model", plan: "", phase: "P2", repo: "", commits: [],
		runId: "agent", briefRef: null, acceptedAt: 10, rework: false, ...overrides,
	};
}

function gitRepo(files: Record<string, string>): { repo: string; sha: string } {
	const repo = join(sandbox(), "repo");
	mkdirSync(repo, { recursive: true });
	const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
	git("init", "-q");
	git("config", "user.name", "Test");
	git("config", "user.email", "test@example.com");
	for (const [name, body] of Object.entries(files)) {
		mkdirSync(dirname(join(repo, name)), { recursive: true });
		writeFileSync(join(repo, name), body);
	}
	git("add", "-A");
	git("commit", "-qm", "episode work");
	return { repo, sha: execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim() };
}

const PLAN = `## Background
The symbol is \`appendLabel\` in \`src/named.ts\`.

## Phases
- [ ] P2 land \`appendLabel\` — difficulty: 2
`;

function planFile(): string {
	const path = join(sandbox(), "plan.md");
	writeFileSync(path, PLAN);
	return path;
}

function homeCfg(): { home: string; cfg: Config } {
	const home = sandbox();
	mkdirSync(join(home, ".config/neurastream"), { recursive: true });
	writeFileSync(join(home, ".config/neurastream/config.yml"), `paths:\n  home: "${home}"\n`);
	return { home, cfg: loadConfig({ home, env: {} }) };
}

function linesOf(scoreState: string): Record<string, unknown>[] {
	return readFileSync(labelLedgerPath(scoreState), "utf8").split("\n").filter(l => l.trim()).map(l => JSON.parse(l) as Record<string, unknown>);
}

test("party is plan when a backticked plan token is in a file the plan names", () => {
	const plan = planFile();
	const { repo, sha } = gitRepo({ "src/named.ts": "export function appendLabel() {}\n" });
	expect(blameParty(episode({ plan, repo, commits: [sha] }))).toBe("plan");
});

test("party is implementer when blamed lines sit in a file the plan never names", () => {
	const plan = planFile();
	const { repo, sha } = gitRepo({ "src/other.ts": "export function mystery() {}\n" });
	expect(blameParty(episode({ plan, repo, commits: [sha] }))).toBe("implementer");
});

test("party is both when an unnamed file also contains a plan token", () => {
	const plan = planFile();
	const { repo, sha } = gitRepo({ "src/other.ts": "call appendLabel()\n" });
	expect(blameParty(episode({ plan, repo, commits: [sha] }))).toBe("both");
});

test("party is none when the plan names the file but the blamed lines carry no plan token", () => {
	const plan = planFile();
	const { repo, sha } = gitRepo({ "src/named.ts": "export function mystery() {}\n" });
	// Neither condition holds: the plan calls that "unclear", recorded as none.
	expect(blameParty(episode({ plan, repo, commits: [sha] }))).toBe("none");
});

test("a flip of an accepted episode appends a test-party line and one incident", () => {
	const { cfg } = homeCfg();
	const plan = planFile();
	const { repo, sha } = gitRepo({ "src/named.ts": "export function appendLabel() {}\n" });
	const ep = episode({ id: "agent:plan:P2", plan, repo, commits: [sha] });
	const fix = "abc1234";
	appendLabel(cfg.paths.score_state, { ts: 1, episode: ep.id, label: "good", reason: "accepted", party: "none", evidence: "accept" });
	const before = readFileSync(labelLedgerPath(cfg.paths.score_state));
	const first = flipAccepted(cfg, ep, fix, 42);
	expect(first.party).toBe("plan");
	const after = readFileSync(labelLedgerPath(cfg.paths.score_state));
	expect(after.subarray(0, before.length)).toEqual(before);
	const lines = linesOf(cfg.paths.score_state);
	expect(lines.filter(l => l.party === "test")).toEqual([
		expect.objectContaining({ episode: ep.id, label: "bad", party: "test", found_by: fix }),
	]);
	const open = openIncidents(cfg);
	expect(open).toHaveLength(1);
	expect(open[0]!.summary).toBe(`test hole: ${fix} changed lines no check caught`);
	expect(open[0]!.fingerprint).toBe(`test-hole:${ep.id}:${fix}`);
	flipAccepted(cfg, ep, fix, 43);
	expect(openIncidents(cfg)).toHaveLength(1);
	expect(linesOf(cfg.paths.score_state).filter(l => l.party === "test")).toHaveLength(1);
});

test("a flip of an episode that was never accepted writes nothing", () => {
	const { cfg } = homeCfg();
	const ep = episode({ acceptedAt: null });
	expect(flipAccepted(cfg, ep, "abc1234", 42)).toEqual({ party: "none", appended: false });
	expect(openIncidents(cfg)).toEqual([]);
});

test("labels assign appends and the effective label follows the last line", () => {
	const { home, cfg } = homeCfg();
	const first = { ts: 1, episode: "e1", label: "good" as const, reason: "accepted", party: "none" as const, evidence: "accept" };
	appendLabel(cfg.paths.score_state, first);
	const before = readFileSync(labelLedgerPath(cfg.paths.score_state));
	const lines: string[] = [];
	const previous = console.log;
	console.log = (line?: unknown) => lines.push(String(line ?? ""));
	let status = 1;
	try {
		status = runLabels(["assign", "e1", "--party", "plan", "--why", "plan named the symbol"], { home });
	} finally {
		console.log = previous;
	}
	expect(status).toBe(0);
	const after = readFileSync(labelLedgerPath(cfg.paths.score_state));
	expect(after.subarray(0, before.length)).toEqual(before);
	expect(readLabels(cfg.paths.score_state)).toEqual([
		expect.objectContaining({ episode: "e1", label: "good", party: "plan", reason: "plan named the symbol" }),
	]);
	expect(linesOf(cfg.paths.score_state)).toHaveLength(2);
});

test("labels assign refuses a party outside plan|implementer|both", () => {
	const { home, cfg } = homeCfg();
	expect(runLabels(["assign", "e1", "--party", "test", "--why", "no"], { home })).toBe(2);
	expect(runLabels(["assign", "e1", "--party", "plan"], { home })).toBe(2);
	expect(() => readFileSync(labelLedgerPath(cfg.paths.score_state), "utf8")).toThrow();
});
