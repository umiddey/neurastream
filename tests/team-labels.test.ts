import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runTeam } from "../src/cli/team.ts";
import { fileClaimStore } from "../src/core/claims.ts";
import { nowSec } from "../src/core/clock.ts";
import { loadConfig, type Config } from "../src/core/config.ts";
import type { CommandRunner } from "../src/core/mr-sweep.ts";
import { parsePlan } from "../src/core/queue/lib.ts";
import { planShare, repoListError, repoTeam } from "../src/core/team-labels.ts";

const TMP = mkdtempSync(path.join(tmpdir(), "team-labels-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

function cfgWith(yaml: string): Config {
	const home = mkdtempSync(path.join(TMP, "home-"));
	const file = path.join(home, "config.yml");
	writeFileSync(file, yaml);
	return loadConfig({ file, home, env: {} });
}

const ONE = `teams:
  - name: acme
    server: http://acme
    repos: ["gitlab.com/acme/*"]
`;

function origin(url: string): CommandRunner {
	return () => ({ code: 0, stdout: `${url}\n`, stderr: "" });
}

test("ssh and https of the same repo map to the same team", () => {
	const cfg = cfgWith(ONE);
	for (const url of ["git@gitlab.com:acme/pm.git", "https://gitlab.com/acme/pm.git", "ssh://git@gitlab.com/acme/pm.git"]) {
		expect(repoTeam("/repo", cfg, origin(url))).toBe("acme");
	}
});

test("no origin is personal", () => {
	const cfg = cfgWith(ONE);
	expect(repoTeam("/repo", cfg, () => ({ code: 2, stdout: "", stderr: "No such remote 'origin'" }))).toBeNull();
	expect(repoTeam("/repo", cfg, () => ({ code: 0, stdout: "\n", stderr: "" }))).toBeNull();
});

test("two teams matching the same remote is a config error at load", () => {
	expect(() =>
		cfgWith(`teams:
  - name: acme
    server: http://acme
    repos: ["gitlab.com/acme/*"]
  - name: other
    server: http://other
    repos: ["gitlab.com/acme/pm"]
`),
	).toThrow(/both match/);
	const ok = cfgWith(`teams:
  - name: acme
    server: http://acme
    repos: ["gitlab.com/acme/*"]
  - name: mine
    server: http://mine
    repos: ["github.com/me/*"]
`);
	expect(ok.teams.map(t => t.name)).toEqual(["acme", "mine"]);
});

test("a team repo without Queue: team stays personal and is never looked up to send", () => {
	const cfg = cfgWith(ONE);
	const calls: string[][] = [];
	const run: CommandRunner = args => {
		calls.push(args);
		return { code: 0, stdout: "https://gitlab.com/acme/pm.git\n", stderr: "" };
	};
	const text = "# t\n\n## Goal\n- g\n";
	expect(planShare(parsePlan("/repo", "/repo/p.md", text), cfg, run)).toBeNull();
	expect(calls).toEqual([]);
	const marked = parsePlan("/repo", "/repo/p.md", `Queue: team\n${text}`);
	expect(planShare(marked, cfg, run)).toBe("acme");
	expect(calls[0]).toEqual(["git", "-C", "/repo", "remote", "get-url", "origin"]);
});

function capture(fn: () => number): { rc: number; out: string; err: string } {
	const out: string[] = [];
	const err: string[] = [];
	const log = console.log;
	const error = console.error;
	console.log = (...a: unknown[]) => void out.push(a.map(String).join(" "));
	console.error = (...a: unknown[]) => void err.push(a.map(String).join(" "));
	try {
		return { rc: fn(), out: out.join("\n"), err: err.join("\n") };
	} finally {
		console.log = log;
		console.error = error;
	}
}

test("share on a personal repo is refused and writes nothing", () => {
	const cfg = cfgWith(ONE);
	const file = path.join(TMP, "personal.md");
	const before = "# t\n\n## Goal\n- g\n";
	writeFileSync(file, before);
	const got = capture(() => runTeam(["share", file], { cfg, run: () => ({ code: 2, stdout: "", stderr: "no origin" }) }));
	expect(got.rc).toBe(1);
	expect(got.err).toContain("personal");
	expect(readFileSync(file, "utf8")).toBe(before);
});

test("share writes Queue: team; unshare while another Main holds the claim is refused", () => {
	const cfg = cfgWith(ONE);
	const file = path.join(TMP, "shared.md");
	writeFileSync(file, "# t\nBranch: feat/x\n\n## Goal\n- g\n");
	const shared = capture(() => runTeam(["share", file], { cfg, run: origin("https://gitlab.com/acme/pm.git") }));
	expect(shared.rc).toBe(0);
	expect(readFileSync(file, "utf8")).toBe("# t\nBranch: feat/x\nQueue: team\n\n## Goal\n- g\n");
	fileClaimStore(cfg.paths.queue_state, nowSec, cfg.queue.claim_ttl_min).claim(file, "other");
	const refused = capture(() => runTeam(["unshare", file], { cfg }));
	expect(refused.rc).toBe(1);
	expect(refused.err).toContain("held by Main other");
	expect(readFileSync(file, "utf8")).toContain("Queue: team");
});

test("unshare while this Main holds the claim, or the plan is free, removes the marker and keeps the file", () => {
	const cfg = cfgWith(ONE);
	const free = path.join(TMP, "free.md");
	writeFileSync(free, "# t\nQueue: team\n\n## Goal\n- g\n");
	expect(capture(() => runTeam(["unshare", free], { cfg })).rc).toBe(0);
	expect(readFileSync(free, "utf8")).toBe("# t\n\n## Goal\n- g\n");
	const mine = path.join(TMP, "mine.md");
	writeFileSync(mine, "# t\nQueue: team\n\n## Goal\n- stay\n");
	const prev = process.env.NEURASTREAM_MAIN_ID;
	process.env.NEURASTREAM_MAIN_ID = "self";
	try {
		fileClaimStore(cfg.paths.queue_state, nowSec, cfg.queue.claim_ttl_min).claim(mine, "self");
		expect(capture(() => runTeam(["unshare", mine], { cfg })).rc).toBe(0);
	} finally {
		if (prev === undefined) delete process.env.NEURASTREAM_MAIN_ID;
		else process.env.NEURASTREAM_MAIN_ID = prev;
	}
	expect(readFileSync(mine, "utf8")).toBe("# t\n\n## Goal\n- stay\n");
});

test("a bare * or ** repo glob is refused: it would claim every remote (iii-6)", () => {
	expect(repoListError(["*"])).not.toBeNull();
	expect(repoListError(["**"])).not.toBeNull();
	expect(repoListError([" * ", "gitlab.com/acme/*"])).not.toBeNull();
	expect(repoListError(["gitlab.com/acme/*"])).toBeNull();
});
