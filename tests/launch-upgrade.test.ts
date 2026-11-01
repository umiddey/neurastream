// Rollover across an upgrade (INCIDENT I-20261023-6). `neurastream main` runs from a copy of the
// package (A). The first run writes the handoff note and the relaunch request, then the fake harness
// swaps A on disk to another version (its own version + "-b") whose main-start text carries MAIN-START-B. The launcher must not
// build the handoff with the code it loaded at start: the request goes to a fresh launcher started
// from A's disk, so the second run's handoff comes from the new code. Each launcher is the real bin
// entry (src/cli/main.ts) in a subprocess; a fake `omp` first on PATH stands in for the harness.
// Sandbox HOME; QUEUE_* and NEURASTREAM_* never reach the children.

import { afterAll, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/core/config.ts";
import { mainStateDir } from "../src/core/guards.ts";
import { readMetricEvents } from "../src/core/metrics.ts";
import { notePath, relaunchPath } from "../src/core/rollover.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = mkdtempSync(join(tmpdir(), "nsar-upgrade-"));
afterAll(() => {
	rmSync(TMP, { recursive: true, force: true });
});

const SESSION_ID = "sess-upgrade";
const MAIN_START_LINE = "const out: string[] = [];";
// Written into the copy's main-start.ts: the text the new code generates starts with MAIN-START-B.
const MAIN_START_B_LINE = 'const out: string[] = ["MAIN-START-B\\n"];';

// Run 1 writes the note and the relaunch request, then (FAKE_SWAP=1) swaps the package at
// FAKE_PKG_DIR to another version on disk. Run 2 exits 7. Every run logs its argv and the
// NEURASTREAM_RELAUNCH_SINCE it was started with.
const FAKE_SOURCE = `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const env = process.env;
appendFileSync(env.FAKE_LOG, JSON.stringify({ argv: process.argv.slice(2), since: env.NEURASTREAM_RELAUNCH_SINCE ?? null }) + "\\n");
const second = existsSync(env.FAKE_MARK);
if (!second) {
	writeFileSync(env.FAKE_MARK, "");
	writeFileSync(env.FAKE_NOTE, "Note: continue the rollover work.\\n");
	writeFileSync(env.FAKE_RELAUNCH, JSON.stringify({ previousSessionFile: env.FAKE_PREV, notePath: env.FAKE_NOTE, draft: "" }));
	if (env.FAKE_SWAP === "1") {
		const pkgPath = join(env.FAKE_PKG_DIR, "package.json");
		const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
		pkg.version = pkg.version + "-b";
		writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\\n");
		const mainStart = join(env.FAKE_PKG_DIR, "src/core/main-start.ts");
		const text = readFileSync(mainStart, "utf8");
		writeFileSync(mainStart, text.replace(${JSON.stringify(MAIN_START_LINE)}, ${JSON.stringify(MAIN_START_B_LINE)}));
	}
}
process.exit(second ? 7 : 0);
`;

interface Run {
	argv: string[];
	since: string | null;
}

interface Case {
	dir: string;
	home: string;
	bin: string;
	pkg: string;
	note: string;
	relaunch: string;
	mark: string;
	runsLog: string;
	guardLog: string;
}

let caseNo = 0;

/** A fresh case: sandbox HOME, a fake `omp` on PATH, a copy of the package (A) and its paths. */
function newCase(): Case {
	caseNo++;
	const dir = join(TMP, `case-${caseNo}`);
	const home = join(dir, "home");
	const bin = join(dir, "bin");
	const pkg = join(dir, "pkg-a");
	mkdirSync(bin, { recursive: true });
	mkdirSync(home, { recursive: true });
	cpSync(join(REPO, "package.json"), join(pkg, "package.json"));
	cpSync(join(REPO, "src"), join(pkg, "src"), { recursive: true });
	cpSync(join(REPO, "templates"), join(pkg, "templates"), { recursive: true });
	symlinkSync(join(REPO, "node_modules"), join(pkg, "node_modules"));
	const omp = join(bin, "omp");
	writeFileSync(omp, FAKE_SOURCE);
	chmodSync(omp, 0o755);
	const cfg = loadConfig({ home, env: {} });
	const mainDir = mainStateDir(cfg); // id main: the subprocess runs with no NEURASTREAM_MAIN_ID
	const note = notePath(SESSION_ID, mainDir);
	mkdirSync(dirname(note), { recursive: true });
	return {
		dir,
		home,
		bin,
		pkg,
		note,
		relaunch: relaunchPath(mainDir),
		mark: join(dir, "mark"),
		runsLog: join(dir, "runs.log"),
		guardLog: cfg.paths.guard_log,
	};
}

interface Launch {
	code: number;
	stderr: string;
	runs: Run[];
	guard: string;
}

/** Runs `neurastream main <args>` from the case's package copy as a subprocess; returns its result. */
async function launch(c: Case, args: string[], extra: Record<string, string> = {}): Promise<Launch> {
	const env: Record<string, string> = {
		PATH: `${c.bin}:${process.env.PATH ?? ""}`,
		HOME: c.home,
		FAKE_LOG: c.runsLog,
		FAKE_MARK: c.mark,
		FAKE_NOTE: c.note,
		FAKE_RELAUNCH: c.relaunch,
		FAKE_PREV: join(c.dir, "prev.jsonl"),
		FAKE_PKG_DIR: c.pkg,
		...extra,
	};
	const proc = Bun.spawn([process.execPath, join(c.pkg, "src/cli/main.ts"), "main", ...args], {
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const code = await proc.exited;
	const runsText = existsSync(c.runsLog) ? readFileSync(c.runsLog, "utf8").trim() : "";
	const runs = runsText === "" ? [] : runsText.split("\n").map(line => JSON.parse(line) as Run);
	const guard = existsSync(c.guardLog) ? readFileSync(c.guardLog, "utf8") : "";
	return { code, stderr, runs, guard };
}

test("an upgrade during a run: the second run's handoff comes from the new code, the exit code is the second run's", async () => {
	const c = newCase();
	const r = await launch(c, ["--model", "m", "hi"], { FAKE_SWAP: "1" });
	expect(r.runs.length).toBe(2);
	expect(r.runs[1]?.argv.slice(0, 2)).toEqual(["--model", "m"]);
	const handoff = r.runs[1]?.argv.at(-1) ?? "";
	expect(handoff).toContain("MAIN-START-B");
	expect(handoff).toContain("Note: continue the rollover work.");
	expect(r.code).toBe(7);
	expect(r.stderr).not.toMatch(/^\s+at /m);
	const v = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).version;
	expect(r.guard).toContain(`rollover: relaunch handed to a fresh launcher (${v} → ${v}-b)`);
	// P11: the changed branch records one version-change ledger event, so the release verdict sees a downgrade.
	const ev = readMetricEvents(loadConfig({ home: c.home, env: {} })).filter(e => e.type === "version-change");
	expect(ev).toHaveLength(1);
	expect(ev[0]).toMatchObject({ from: v, to: `${v}-b` });
	// The child launcher took the request; the variable never reaches the harness.
	expect(r.runs[1]?.since).toBe(null);
	expect(existsSync(c.relaunch)).toBe(false);
}, 60_000);

test("same version: one launcher process, no handover, the handoff is the one built in-process", async () => {
	const c = newCase();
	const r = await launch(c, ["--model", "m", "hi"]);
	expect(r.runs.length).toBe(2);
	const handoff = r.runs[1]?.argv.at(-1) ?? "";
	expect(handoff).toContain("Note: continue the rollover work.");
	expect(handoff).not.toContain("MAIN-START-B");
	expect(r.code).toBe(7);
	expect(r.stderr).not.toMatch(/^\s+at /m);
	expect(r.guard).not.toContain("handed to a fresh launcher");
	// No version change, no version-change event.
	expect(readMetricEvents(loadConfig({ home: c.home, env: {} })).filter(e => e.type === "version-change")).toHaveLength(0);
}, 60_000);
