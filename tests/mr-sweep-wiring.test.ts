// PATH-injected glab/gh shims. queue-check is the gate; main-start only prints.
// fail-before baseline (2026-10-26, pre-P2 commit edb28bc, heavy-run "p2 fail-before"):
// planted untracked MR, queueCheck in-process exit 0 and bin/queue-check exit 0. Not a failure until the wire.

import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig, type Config } from "../src/core/config.ts";
import { mainStart, mainStartText } from "../src/core/main-start.ts";
import { queueCheck } from "../src/core/queue-check.ts";

const TMP = mkdtempSync(path.join(tmpdir(), "mr-sweep-wire-"));
const REPO = path.join(import.meta.dir, "..");
const BLOCKERS = path.join(REPO, "blockers");
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

function plan(extra = ""): string {
	return `# fixture
Worktree: -
Branch: feat/other

## Goal
- keep open MRs visible

## Forbidden
- never push

## Blockers
- no-push

## Phases
- [ ] P1 fixture — difficulty: 1 — verify: \`true\`

## Done check
\`true\`

## Code read by Main
- \`src/core/mr-sweep.ts\`

## Progress
Status: open
${extra}
`;
}

// A PATH with git and without glab/gh. /usr/bin has the real forge CLIs, so /usr/bin:/bin is not "CLI missing".
function gitOnlyPath(): string {
	const dir = path.join(TMP, "bin-git-only");
	mkdirSync(dir, { recursive: true });
	const link = path.join(dir, "git");
	if (!existsSync(link)) {
		const found = (process.env.PATH ?? "").split(":").map(d => path.join(d, "git")).find(p => existsSync(p));
		if (!found) throw new Error("git not found for the CLI-missing fixture");
		symlinkSync(found, link);
	}
	return dir;
}

function shim(dir: string, name: string, body: string): void {
	mkdirSync(dir, { recursive: true });
	const file = path.join(dir, name);
	writeFileSync(file, body);
	chmodSync(file, 0o755);
}

const JSON_SHIM = "#!/bin/sh\nprintf '%s\\n' \"$MR_SWEEP_JSON\"\n";
const AUTH_SHIM = "#!/bin/sh\necho '401 Unauthorized' >&2\nexit 1\n";

// queue-check now needs an allowed review agent (P4d): the default review.agents is ["reviewer"].
function allowSubagents(home: string): void {
	mkdirSync(path.join(home, ".config/neurastream/notes"), { recursive: true });
	writeFileSync(path.join(home, ".config/neurastream/notes/subagents.md"), "## Allowed\n\n- `reviewer`\n");
}

function plant(name: string, extra = "", origin: string | null = "https://gitlab.example/group/pm.git"): { cfg: Config; repo: string; home: string } {
	const home = path.join(TMP, name);
	const repo = path.join(home, "pm");
	mkdirSync(path.join(repo, "docs/plans"), { recursive: true });
	const init = spawnSync("git", ["init", "-q", "-b", "main"], { cwd: repo, encoding: "utf8" });
	if (init.status !== 0) throw new Error(init.stderr || "git init");
	if (origin) {
		const add = spawnSync("git", ["remote", "add", "origin", origin], { cwd: repo, encoding: "utf8" });
		if (add.status !== 0) throw new Error(add.stderr || "git remote");
	}
	const file = path.join(repo, "docs/plans/20261026_1530_fixture.md");
	writeFileSync(file, plan(extra));
	const index = path.join(home, "INDEX.md");
	writeFileSync(index, `${file}\n`);
	mkdirSync(path.join(home, ".config/neurastream"), { recursive: true });
	allowSubagents(home);
	const cfgFile = path.join(home, ".config/neurastream/config.yml");
	writeFileSync(cfgFile, `paths:\n  queue_index: "${index}"\n  blockers: "${BLOCKERS}"\n`);
	return { cfg: loadConfig({ home, file: cfgFile, env: {} }), repo, home };
}

function withEnv(extra: NodeJS.ProcessEnv, fn: () => void): void {
	const saved: Record<string, string | undefined> = {};
	for (const key of Object.keys(extra)) saved[key] = process.env[key];
	Object.assign(process.env, extra);
	try {
		fn();
	} finally {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

function runCheck(cfg: Config, args: string[] = []): { code: number; out: string } {
	const lines: string[] = [];
	const orig = console.log;
	console.log = (...a: unknown[]) => {
		lines.push(a.map(String).join(" "));
	};
	try {
		return { code: queueCheck(args, cfg), out: lines.join("\n") };
	} finally {
		console.log = orig;
	}
}

function jsonEnv(dir: string, body: string): NodeJS.ProcessEnv {
	return { PATH: `${dir}:${process.env.PATH ?? "/usr/bin:/bin"}`, MR_SWEEP_JSON: body };
}

const GL = (iid: number, branch: string) => JSON.stringify([{ iid, source_branch: branch, title: "t", state: "opened" }]);

test("untracked MR from a reachable forge fails queue-check", () => {
	// fail-before (heavy-run "p2 fail-before"): this assertion received 0. Post-wire contract is exit 1.
	const shims = path.join(TMP, "bin-untracked");
	shim(shims, "glab", JSON_SHIM);
	const { cfg, repo } = plant("untracked");
	let got = { code: -1, out: "" };
	withEnv(jsonEnv(shims, GL(206, "feat/lost")), () => {
		got = runCheck(cfg);
	});
	expect(got.code).toBe(1);
	expect(got.out).toContain(`UNTRACKED MR !206 pm ${repo} (feat/lost) — no open plan mentions it`);
});

test("tracked via !N, via branch name, and via MR !N: ignored does not fail", () => {
	const shims = path.join(TMP, "bin-tracked");
	shim(shims, "glab", JSON_SHIM);
	const cases = [
		["token", "opened as !206", "feat/lost"],
		["branch", "work is on feat/lost", "feat/lost"],
		["ignored", "MR !206: ignored (stale stray)", "feat/stray"],
	] as const;
	for (const [name, extra, branch] of cases) {
		const { cfg } = plant(name, extra);
		let got = { code: -1, out: "" };
		withEnv(jsonEnv(shims, GL(206, branch)), () => {
			got = runCheck(cfg);
		});
		expect(got.code).toBe(0);
		expect(got.out).toContain("tracked MR !206");
		expect(got.out).not.toContain("UNTRACKED");
	}
});

test("CLI missing and auth failure skip and exit 0", () => {
	const { cfg: missingCfg } = plant("missing");
	let missing = { code: -1, out: "" };
	withEnv({ PATH: gitOnlyPath() }, () => {
		missing = runCheck(missingCfg);
	});
	expect(missing.code).toBe(0);
	expect(missing.out).toContain("mr-sweep: skipped (no forge CLI)");
	expect(missing.out).not.toContain("UNTRACKED");

	const shims = path.join(TMP, "bin-auth");
	shim(shims, "glab", AUTH_SHIM);
	const { cfg: authCfg, repo } = plant("auth");
	let auth = { code: -1, out: "" };
	withEnv({ PATH: `${shims}:${process.env.PATH ?? "/usr/bin:/bin"}` }, () => {
		auth = runCheck(authCfg);
	});
	expect(auth.code).toBe(0);
	expect(auth.out).toContain(`mr-sweep: skipped ${repo} (forge unreachable)`);
	expect(auth.out).not.toContain("UNTRACKED");
	expect(auth.out).not.toContain("no forge CLI");
});

test("an empty index exits 0", () => {
	const home = path.join(TMP, "empty");
	const index = path.join(home, "INDEX.md");
	mkdirSync(home, { recursive: true });
	writeFileSync(index, "");
	mkdirSync(path.join(home, ".config/neurastream"), { recursive: true });
	allowSubagents(home);
	const cfgFile = path.join(home, ".config/neurastream/config.yml");
	writeFileSync(cfgFile, `paths:\n  queue_index: "${index}"\n  blockers: "${BLOCKERS}"\n`);
	const cfg = loadConfig({ home, file: cfgFile, env: {} });
	const got = runCheck(cfg);
	expect(got.code).toBe(0);
	expect(got.out).not.toContain("UNTRACKED");
});

test("priority ids stay a clean list and do not run the sweep", () => {
	const shims = path.join(TMP, "bin-ids");
	const { cfg } = plant("ids", "PRIORITY-ID: PR77");

	let got = { code: -1, out: "" };
	withEnv(jsonEnv(shims, GL(206, "feat/lost")), () => {
		got = runCheck(cfg, ["--priority-ids"]);
	});
	expect(got.code).toBe(0);
	expect(got.out).toBe("PR77");
});

test("the queue-check bin sees a PATH-injected glab and fails only when the MR is untracked", () => {
	const shims = path.join(TMP, "bin-cli");
	shim(shims, "glab", JSON_SHIM);
	const { home } = plant("cli");
	const run = spawnSync("bun", [path.join(REPO, "bin/queue-check")], {
		encoding: "utf8",
		env: {
			...process.env,
			HOME: home,
			PATH: `${shims}:${process.env.PATH ?? "/usr/bin:/bin"}`,
			MR_SWEEP_JSON: GL(206, "feat/lost"),
		},
	});
	expect(run.status).toBe(1);
	expect(run.stdout).toContain("UNTRACKED MR !206 pm");
});

function stubBins(home: string): void {
	const bindir = path.join(home, ".local/bin");
	mkdirSync(bindir, { recursive: true });
	for (const name of ["machine-guard", "agent-ledger", "main-health", "queue-check"]) {
		const file = path.join(bindir, name);
		writeFileSync(file, "#!/bin/sh\nexit 0\n");
		chmodSync(file, 0o755);
	}
}

test("main-start prints the sweep and still exits 0", async () => {
	const shims = path.join(TMP, "bin-start");
	shim(shims, "glab", JSON_SHIM);
	const { cfg, repo } = plant("start");
	stubBins(cfg.paths.home);
	let text = "";
	let code = -1;
	await withEnvAsync(jsonEnv(shims, GL(206, "feat/lost")), async () => {
		text = await mainStartText([], cfg, { inheritStdin: false });
		code = await mainStart([], cfg);
	});
	expect(code).toBe(0);
	expect(text).toContain(`UNTRACKED MR !206 pm ${repo} (feat/lost) — no open plan mentions it`);
	expect(text).toContain("=== mr-sweep");
}, 60_000);

async function withEnvAsync(extra: NodeJS.ProcessEnv, fn: () => Promise<void>): Promise<void> {
	const saved: Record<string, string | undefined> = {};
	for (const key of Object.keys(extra)) saved[key] = process.env[key];
	Object.assign(process.env, extra);
	try {
		await fn();
	} finally {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}
