// P1 (plan 20261109_2335, recall CLI): search, --show and --json over the owner log and its
// backfill. Red until src/cli/recall.ts exists: the import below is what fails. The log is a
// sandbox under a tmp dir; HOME and the clock are pinned, so no real home or queue is read.

import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config } from "../src/core/config.ts";
import { applyQueueEnv } from "../src/core/queue/env.ts";
import { ownerBackfillFile, ownerLogDir, ownerLogFile } from "../src/core/owner-log.ts";
import { recallCli } from "../src/cli/recall.ts";

const TMP = mkdtempSync(join(tmpdir(), "recall-cli-"));
const HOME = join(TMP, "home");
const QUEUE = join(TMP, "queue-state");
const NOW_SEC = 1762000000;
const DAY = 86400;

const homeBefore = process.env.HOME;
const nowBefore = process.env.NEURASTREAM_NOW;
const queueEnvBefore = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("QUEUE_")));
process.env.HOME = HOME;
process.env.NEURASTREAM_NOW = String(NOW_SEC);
for (const k of Object.keys(queueEnvBefore)) delete process.env[k];

afterAll(() => {
	rmSync(TMP, { recursive: true, force: true });
	for (const k of Object.keys(process.env)) if (k.startsWith("QUEUE_")) delete process.env[k];
	Object.assign(process.env, queueEnvBefore);
	if (homeBefore === undefined) delete process.env.HOME;
	else process.env.HOME = homeBefore;
	if (nowBefore === undefined) delete process.env.NEURASTREAM_NOW;
	else process.env.NEURASTREAM_NOW = nowBefore;
});

/** Sandbox config: queue state under TMP, guard logs under TMP, rollover off. */
function sandboxConfig(): Config {
	mkdirSync(QUEUE, { recursive: true });
	mkdirSync(join(HOME, ".config/neurastream"), { recursive: true });
	writeFileSync(
		join(HOME, ".config/neurastream/config.yml"),
		`paths:
  home: "${HOME}"
  queue_index: "${join(TMP, "INDEX.md")}"
  queue_state: "${QUEUE}"
  guard_log: "${join(TMP, "guard.log")}"
  plan_guard_log: "${join(TMP, "plan-guard.log")}"
rollover:
  enabled: false
`,
	);
	const cfg = loadConfig({ home: HOME, env: {} });
	applyQueueEnv(cfg);
	return cfg;
}

const CFG = sandboxConfig();

type Row = { id: string; at: number; role: "owner" | "main"; text: string };

// Oldest first, as the writer appends them. Ids follow the 9 base36 + 8 hex shape.
const LIVE: Row[] = [
	{ id: "00000000a00000001", at: NOW_SEC - 10 * DAY, role: "owner", text: "ship the traces series" },
	{ id: "00000000b00000002", at: NOW_SEC - 3 * DAY, role: "main", text: "Shipped the traces series" },
	{ id: "00000000c00000003", at: NOW_SEC - 2 * DAY, role: "owner", text: "unrelated lunch order" },
	{ id: "00000000d00000004", at: NOW_SEC - DAY, role: "owner", text: "newer traces note" },
	{ id: "00000000e00000005", at: NOW_SEC - 3600, role: "main", text: "answer to the newer note" },
];
const BACKFILL: Row[] = [
	{ id: "00000000f00000006", at: NOW_SEC - 20 * DAY, role: "owner", text: "series traces backfill old" },
];

/** Replace the live log and the backfill with these rows, oldest first. */
function seed(live: Row[], backfill: Row[]): void {
	rmSync(ownerLogDir(), { recursive: true, force: true });
	mkdirSync(ownerLogDir(), { recursive: true });
	writeFileSync(ownerLogFile(), `${live.map(r => JSON.stringify(r)).join("\n")}\n`);
	if (backfill.length > 0) writeFileSync(ownerBackfillFile(), `${backfill.map(r => JSON.stringify(r)).join("\n")}\n`);
}

/** Run the CLI and capture what it prints to stdout and stderr. */
function run(args: string[]): { code: number; out: string } {
	const seen: string[] = [];
	const sink = (...parts: unknown[]): void => {
		seen.push(parts.map(String).join(" "));
	};
	const log = console.log;
	const err = console.error;
	console.log = sink;
	console.error = sink;
	try {
		const code = recallCli(args, CFG);
		return { code, out: seen.join("\n") };
	} finally {
		console.log = log;
		console.error = err;
	}
}

// ---- (f) search ----

test("(f) search matches every word, case-insensitive, in any order, across live and backfill", () => {
	seed(LIVE, BACKFILL);
	const found = run(["Series", "TRACES"]);
	expect(found.code).toBe(0);
	expect(found.out).toContain("ship the traces series");
	expect(found.out).toContain("Shipped the traces series");
	expect(found.out).toContain("series traces backfill old");
	expect(found.out).not.toContain("unrelated lunch order");
	expect(found.out).not.toContain("answer to the newer note");
});

test("(f) a search where no entry has every word prints no match and exits 1", () => {
	seed(LIVE, BACKFILL);
	const missed = run(["traces", "lunch"]);
	expect(missed.code).toBe(1);
	expect(missed.out).toContain("no match");
});

test("(f) --since 7d keeps only entries from the last 7 days", () => {
	seed(LIVE, BACKFILL);
	const recent = run(["traces", "--since", "7d"]);
	expect(recent.out).toContain("newer traces note");
	expect(recent.out).not.toContain("ship the traces series");
	expect(recent.out).not.toContain("series traces backfill old");
});

test("(f) --limit 1 shows only the newest match", () => {
	seed(LIVE, BACKFILL);
	const one = run(["traces", "--limit", "1"]);
	expect(one.out).toContain("newer traces note");
	expect(one.out).not.toContain("Shipped the traces series");
});

test("(f) matches print newest first, live before backfill", () => {
	seed(LIVE, BACKFILL);
	const all = run(["traces"]).out;
	const newest = all.indexOf("newer traces note");
	const middle = all.indexOf("Shipped the traces series");
	const oldest = all.indexOf("series traces backfill old");
	expect(newest).toBeGreaterThanOrEqual(0);
	expect(middle).toBeGreaterThan(newest);
	expect(oldest).toBeGreaterThan(middle);
});

// ---- (g) --show ----

test("(g) --show on an owner entry prints it and the next Main entry, not the owner entry after", () => {
	seed(LIVE, BACKFILL);
	const shown = run(["--show", "00000000a00000001"]).out;
	expect(shown).toContain("ship the traces series");
	expect(shown).toContain("Shipped the traces series");
	expect(shown).not.toContain("unrelated lunch order");
	expect(shown.indexOf("ship the traces series")).toBeLessThan(shown.indexOf("Shipped the traces series"));
});

test("(g) --show on a Main entry prints the owner entry before it, then the answer", () => {
	seed(LIVE, BACKFILL);
	const shown = run(["--show", "00000000b00000002"]).out;
	expect(shown).toContain("ship the traces series");
	expect(shown).toContain("Shipped the traces series");
	expect(shown).not.toContain("unrelated lunch order");
	expect(shown.indexOf("ship the traces series")).toBeLessThan(shown.indexOf("Shipped the traces series"));
});

test("(g) --show with an unknown id exits 2", () => {
	seed(LIVE, BACKFILL);
	expect(run(["--show", "zzzzzzzzzzzzzzzzz"]).code).toBe(2);
});

// ---- (h) --json ----

test("(h) --json prints the same rows as objects with id, at, role and text", () => {
	seed(LIVE, BACKFILL);
	const human = run(["traces"]).out;
	const json = run(["traces", "--json"]).out;
	const rows = json
		.split("\n")
		.filter(line => line !== "")
		.map(line => JSON.parse(line) as Record<string, unknown>);
	expect(rows.map(row => row.text)).toEqual([
		"newer traces note",
		"Shipped the traces series",
		"ship the traces series",
		"series traces backfill old",
	]);
	for (const row of rows) {
		expect(Object.keys(row).toSorted()).toEqual(["at", "id", "role", "text"]);
		expect(human).toContain(String(row.text));
	}
});
