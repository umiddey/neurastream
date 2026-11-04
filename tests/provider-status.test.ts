// Harness provider status (plan 20261103_0955 P1): the harness feed into provider-out, and the
// two lines main-start prints from a ProviderStatus list. No harness files, no real home.

import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { strftime } from "../src/core/clock.ts";
import type { Config } from "../src/core/config.ts";
import { loadConfig } from "../src/core/config.ts";
import {
	harnessProviderLines,
	outUntil,
	readOut,
	recordOut,
	syncHarnessOut,
	type ProviderStatus,
} from "../src/core/provider-state.ts";

const roots: string[] = [];

afterAll(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function sandbox(): Config {
	const home = mkdtempSync("/tmp/neurastream-home-pstatus-");
	roots.push(home);
	const agents = join(home, ".omp/agent/agents");
	mkdirSync(join(home, ".config/neurastream"), { recursive: true });
	mkdirSync(agents, { recursive: true });
	writeFileSync(
		join(home, ".config/neurastream/config.yml"),
		`adapter:\n  name: omp\n  sessions: "${join(home, ".omp/agent/sessions")}"\n  pins: "${agents}"\n  extensions: "${join(home, ".omp/agent/extensions")}"\n`,
	);
	return loadConfig({ home, env: {} });
}

function status(
	provider: string,
	opts: { unusable?: string | null; blockedUntil?: number | null; partial?: { scope: string; until: number }[] } = {},
): ProviderStatus {
	return {
		provider,
		unusable: opts.unusable ?? null,
		blockedUntil: opts.blockedUntil ?? null,
		partial: opts.partial ?? [],
	};
}

function snapPath(cfg: Config): string {
	return join(cfg.paths.queue_state, "harness-providers.json");
}

function lastFor(cfg: Config, provider: string) {
	const rows = readOut(cfg);
	let found: (typeof rows)[number] | undefined;
	for (const row of rows) if (row.provider === provider) found = row;
	return found;
}

/** Local wall time as epoch seconds, so T assertions match strftime on this machine. */
function localEpoch(y: number, mo: number, d: number, h: number, mi: number): number {
	return Math.floor(new Date(y, mo - 1, d, h, mi, 0).getTime() / 1000);
}

const NOW = localEpoch(2026, 11, 4, 9, 27);
const SAME_DAY = localEpoch(2026, 11, 4, 10, 2);
const OTHER_DAY = localEpoch(2026, 11, 22, 23, 59);

test("syncHarnessOut records a block only when it is new or later, and appends nothing when unchanged", () => {
	const cfg = sandbox();
	syncHarnessOut(cfg, null, NOW);
	expect(readOut(cfg)).toEqual([]);

	syncHarnessOut(cfg, [status("alpha", { blockedUntil: NOW })], NOW);
	syncHarnessOut(cfg, [status("alpha", { blockedUntil: NOW - 1 })], NOW);
	expect(readOut(cfg)).toEqual([]);

	syncHarnessOut(cfg, [status("alpha", { blockedUntil: NOW + 3600 })], NOW);
	expect(readOut(cfg)).toEqual([{ provider: "alpha", until: NOW + 3600, at: NOW, source: "harness" }]);
	const once = readFileSync(join(cfg.paths.queue_state, "provider-out.jsonl"), "utf8");

	syncHarnessOut(cfg, [status("alpha", { blockedUntil: NOW + 3600 })], NOW);
	expect(readFileSync(join(cfg.paths.queue_state, "provider-out.jsonl"), "utf8")).toBe(once);

	recordOut(cfg, "bravo", NOW + 9000, "quota-reset", NOW - 5);
	syncHarnessOut(cfg, [status("bravo", { blockedUntil: NOW + 1000 })], NOW);
	expect(lastFor(cfg, "bravo")).toEqual({ provider: "bravo", until: NOW + 9000, at: NOW - 5, source: "quota-reset" });

	syncHarnessOut(cfg, [status("bravo", { blockedUntil: NOW + 10000 })], NOW);
	expect(lastFor(cfg, "bravo")).toEqual({ provider: "bravo", until: NOW + 10000, at: NOW, source: "harness" });
	expect(outUntil(cfg, "alpha", NOW)).toBe(NOW + 3600);
});

test("syncHarnessOut clears only a live harness record, never quota-reset, rate-limit or task-result", () => {
	const cfg = sandbox();
	recordOut(cfg, "alpha", NOW + 5000, "quota-reset", NOW - 10);
	recordOut(cfg, "bravo", NOW + 5000, "rate-limit", NOW - 10);
	recordOut(cfg, "charlie", NOW + 5000, "task-result", NOW - 10);
	recordOut(cfg, "delta", NOW + 5000, "harness", NOW - 10);
	recordOut(cfg, "echo", NOW + 5000, "harness", NOW - 10);
	recordOut(cfg, "foxtrot", NOW, "harness", NOW - 10);

	syncHarnessOut(
		cfg,
		[
			status("alpha"),
			status("bravo"),
			status("charlie"),
			status("delta"),
			status("echo", { unusable: "logged out" }),
			status("foxtrot"),
		],
		NOW,
	);

	expect(lastFor(cfg, "alpha")?.source).toBe("quota-reset");
	expect(lastFor(cfg, "bravo")?.source).toBe("rate-limit");
	expect(lastFor(cfg, "charlie")?.source).toBe("task-result");
	expect(readOut(cfg).filter(r => r.provider === "alpha")).toHaveLength(1);
	expect(readOut(cfg).filter(r => r.provider === "bravo")).toHaveLength(1);
	expect(readOut(cfg).filter(r => r.provider === "charlie")).toHaveLength(1);
	expect(lastFor(cfg, "delta")).toEqual({ provider: "delta", until: NOW, at: NOW, source: "harness" });
	expect(outUntil(cfg, "delta", NOW)).toBeNull();
	expect(outUntil(cfg, "alpha", NOW)).toBe(NOW + 5000);
	expect(readOut(cfg).filter(r => r.provider === "echo")).toHaveLength(1);
	expect(readOut(cfg).filter(r => r.provider === "foxtrot")).toHaveLength(1);

	const after = readFileSync(join(cfg.paths.queue_state, "provider-out.jsonl"), "utf8");
	syncHarnessOut(cfg, [status("delta")], NOW);
	expect(readFileSync(join(cfg.paths.queue_state, "provider-out.jsonl"), "utf8")).toBe(after);
});

test("first harnessProviderLines writes the snapshot and prints no change line", () => {
	const cfg = sandbox();
	expect(strftime(SAME_DAY, "%H:%M")).toBe("10:02");
	expect(strftime(OTHER_DAY, "%m-%d %H:%M")).toBe("11-22 23:59");
	const list = [
		status("delta", { unusable: "refresh failed" }),
		status("yankee", { blockedUntil: OTHER_DAY }),
		status("charlie", { partial: [{ scope: "pool:api", until: SAME_DAY }] }),
		status("bravo"),
		status("xray", { blockedUntil: SAME_DAY }),
		status("alpha"),
	];
	const lines = harnessProviderLines(cfg, list, NOW);
	expect(lines).toEqual([
		"harness providers: ready 3: alpha, bravo, charlie · blocked: xray until 10:02, yankee until 11-22 23:59 · partly blocked: charlie pool:api until 10:02 · unusable: delta (refresh failed)",
	]);
	expect(lines.join("\n")).not.toContain("provider changes");
	const snap = JSON.parse(readFileSync(snapPath(cfg), "utf8")) as { at: number; providers: ProviderStatus[] };
	expect(snap.at).toBe(NOW);
	expect(snap.providers).toEqual(list);
});

test("harnessProviderLines reports each provider-state change, and partial never counts", () => {
	const cfg = sandbox();
	expect(harnessProviderLines(cfg, [status("alpha"), status("bravo", { blockedUntil: SAME_DAY }), status("charlie", { unusable: "logged out" })], NOW)).toEqual([
		"harness providers: ready 1: alpha · blocked: bravo until 10:02 · unusable: charlie (logged out)",
	]);

	expect(harnessProviderLines(cfg, [status("alpha"), status("bravo", { blockedUntil: SAME_DAY }), status("charlie", { unusable: "logged out" }), status("delta")], NOW + 60)).toEqual([
		"harness providers: ready 2: alpha, delta · blocked: bravo until 10:02 · unusable: charlie (logged out)",
		"provider changes since 09:27: delta new",
	]);

	const fresh = sandbox();
	expect(harnessProviderLines(fresh, [], NOW)).toEqual([]);
	expect(harnessProviderLines(fresh, [status("echo", { blockedUntil: OTHER_DAY })], NOW + 60)).toEqual([
		"harness providers: blocked: echo until 11-22 23:59",
		"provider changes since 09:27: echo new, blocked until 11-22 23:59",
	]);

	expect(harnessProviderLines(cfg, [status("alpha", { blockedUntil: OTHER_DAY }), status("bravo"), status("charlie", { unusable: "logged out" })], NOW + 120)).toEqual([
		"harness providers: ready 1: bravo · blocked: alpha until 11-22 23:59 · unusable: charlie (logged out)",
		"provider changes since 09:28: alpha blocked until 11-22 23:59 · bravo BACK · delta gone",
	]);

	expect(harnessProviderLines(cfg, [status("alpha"), status("charlie", { blockedUntil: SAME_DAY })], NOW + 180)).toEqual([
		"harness providers: ready 1: alpha · blocked: charlie until 10:02",
		"provider changes since 09:29: alpha BACK · bravo gone · charlie BACK, blocked until 10:02",
	]);

	expect(harnessProviderLines(cfg, [status("alpha", { unusable: "logged out" }), status("charlie", { unusable: "refresh failed" })], NOW + 240)).toEqual([
		"harness providers: unusable: alpha (logged out), charlie (refresh failed)",
		"provider changes since 09:30: alpha unusable (logged out) · charlie unusable (refresh failed)",
	]);

	expect(harnessProviderLines(cfg, [status("alpha")], NOW + 300)).toEqual([
		"harness providers: ready 1: alpha",
		"provider changes since 09:31: alpha BACK · charlie gone",
	]);

	const partialOnly = sandbox();
	harnessProviderLines(partialOnly, [status("charlie")], NOW);
	expect(harnessProviderLines(partialOnly, [status("charlie", { partial: [{ scope: "pool:api", until: SAME_DAY }] })], NOW + 60)).toEqual([
		"harness providers: ready 1: charlie · partly blocked: charlie pool:api until 10:02",
	]);
});

test("a null list prints unreadable and leaves the snapshot untouched", () => {
	const cfg = sandbox();
	harnessProviderLines(cfg, [status("alpha")], NOW);
	const before = readFileSync(snapPath(cfg), "utf8");
	expect(harnessProviderLines(cfg, null, NOW + 60)).toEqual(["harness providers: unreadable — run neurastream doctor"]);
	expect(readFileSync(snapPath(cfg), "utf8")).toBe(before);
	expect(existsSync(snapPath(cfg))).toBe(true);
});
