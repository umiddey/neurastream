// omp provider reader (plan 20261103_0955 P2): a temp agent.db in omp's column layout.
// The secret column is present so a query that selects it fails this file. No real home.

import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { doctorReport } from "../src/adapters/omp/doctor.ts";
import { ompProviders, readOmpProviders } from "../src/adapters/omp/providers.ts";
import { loadConfig } from "../src/core/config.ts";
import type { ProviderStatus } from "../src/core/provider-state.ts";

const roots: string[] = [];
const CANARY = "SECRET-TOKEN-x";
const NOW_MS = 1_700_000_000_000;
const HOUR = 3_600_000;
const LONG = "abcdefghijklmnopqrstuvwxyz0123456789EXTRA";

afterAll(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function sec(ms: number): number {
	return Math.floor(ms / 1000);
}

function freshHome(): string {
	const home = mkdtempSync("/tmp/neurastream-home-ompprov-");
	roots.push(home);
	mkdirSync(join(home, ".omp/agent"), { recursive: true });
	return home;
}

function openDb(home: string): Database {
	const db = new Database(join(home, ".omp/agent/agent.db"));
	db.run(`CREATE TABLE auth_credentials (
		id INTEGER PRIMARY KEY,
		provider TEXT NOT NULL,
		credential_type TEXT NOT NULL,
		data TEXT NOT NULL,
		disabled_cause TEXT,
		identity_key TEXT,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL
	)`);
	db.run(`CREATE TABLE auth_credential_blocks (
		credential_id INTEGER NOT NULL,
		provider_key TEXT NOT NULL,
		block_scope TEXT NOT NULL DEFAULT '',
		blocked_until_ms INTEGER NOT NULL,
		updated_at INTEGER NOT NULL,
		PRIMARY KEY (credential_id, provider_key, block_scope)
	)`);
	return db;
}

function cred(db: Database, id: number, provider: string, updatedAt: number, cause: string | null): void {
	db.run(
		"INSERT INTO auth_credentials (id, provider, credential_type, data, disabled_cause, created_at, updated_at) VALUES (?, ?, 'oauth', ?, ?, 1, ?)",
		[id, provider, CANARY, cause, updatedAt],
	);
}

function block(db: Database, id: number, scope: string, untilMs: number): void {
	db.run(
		"INSERT INTO auth_credential_blocks (credential_id, provider_key, block_scope, blocked_until_ms, updated_at) VALUES (?, 'ignored', ?, ?, 1)",
		[id, scope, untilMs],
	);
}

function shapeHome(): string {
	const home = freshHome();
	const db = openDb(home);
	cred(db, 1, "zai", 10, null);
	cred(db, 2, "zai", 11, null);
	block(db, 1, "credits", NOW_MS + 2 * HOUR);
	block(db, 2, "credits", NOW_MS + 5 * HOUR);
	cred(db, 3, "openai-codex", 12, null);
	block(db, 3, "chat", NOW_MS + 4 * HOUR);
	block(db, 3, "shared", NOW_MS + HOUR);
	cred(db, 4, "cursor", 13, null);
	block(db, 4, "pool:api", NOW_MS + 3 * HOUR);
	cred(db, 5, "anthropic", 14, null);
	block(db, 5, "", NOW_MS + 9 * HOUR);
	block(db, 5, "pool:api", NOW_MS + 9 * HOUR);
	cred(db, 6, "anthropic", 15, null);
	cred(db, 7, "deadprov", 1, "deleted by user");
	cred(db, 8, "deadprov", 2, `oauth refresh failed: {"error":"invalid_grant"}`);
	cred(db, 9, "mcp_oauth:github", 20, null);
	block(db, 9, "credits", NOW_MS + 9 * HOUR);
	cred(db, 10, "openrouter", 16, null);
	block(db, 10, "credits", NOW_MS - 1);
	cred(db, 11, "sparkprov", 17, null);
	block(db, 11, "spark", NOW_MS + 6 * HOUR);
	cred(db, 12, "unknownprov", 18, null);
	block(db, 12, "future-scope", NOW_MS + 6 * HOUR);
	cred(db, 13, "longcause", 3, "stale cause: old");
	cred(db, 14, "longcause", 4, `${LONG}: the rest`);
	db.close();
	writeFileSync(join(home, ".omp/agent/models.yml"), "providers:\n  qwen-local:\n    auth: none\n  zai:\n    auth: oauth\n");
	return home;
}

function byName(list: ProviderStatus[], name: string): ProviderStatus {
	const found = list.find(status => status.provider === name);
	if (!found) throw new Error(`missing ${name}`);
	return found;
}

test("readOmpProviders reports the live store: whole blocks, partial scopes, a free sibling, and no secret", () => {
	expect(LONG.length).toBe(41);
	const home = shapeHome();
	const list = readOmpProviders(home, NOW_MS);
	expect(JSON.stringify(list)).not.toContain(CANARY);
	expect(list.map(status => status.provider)).toEqual([
		"anthropic",
		"cursor",
		"deadprov",
		"longcause",
		"openai-codex",
		"openrouter",
		"qwen-local",
		"sparkprov",
		"unknownprov",
		"zai",
	]);
	expect(list.some(status => status.provider.startsWith("mcp_oauth:"))).toBe(false);
	expect(byName(list, "zai")).toEqual({ provider: "zai", unusable: null, blockedUntil: sec(NOW_MS + 2 * HOUR), partial: [] });
	expect(byName(list, "openai-codex")).toEqual({
		provider: "openai-codex",
		unusable: null,
		blockedUntil: sec(NOW_MS + 4 * HOUR),
		partial: [],
	});
	expect(byName(list, "cursor")).toEqual({
		provider: "cursor",
		unusable: null,
		blockedUntil: null,
		partial: [{ scope: "pool:api", until: sec(NOW_MS + 3 * HOUR) }],
	});
	expect(byName(list, "anthropic")).toEqual({ provider: "anthropic", unusable: null, blockedUntil: null, partial: [] });
	expect(byName(list, "deadprov")).toEqual({ provider: "deadprov", unusable: "oauth refresh failed", blockedUntil: null, partial: [] });
	expect(byName(list, "longcause").unusable).toBe(LONG.slice(0, 40));
	expect(byName(list, "openrouter")).toEqual({ provider: "openrouter", unusable: null, blockedUntil: null, partial: [] });
	expect(byName(list, "sparkprov")).toEqual({
		provider: "sparkprov",
		unusable: null,
		blockedUntil: null,
		partial: [{ scope: "spark", until: sec(NOW_MS + 6 * HOUR) }],
	});
	expect(byName(list, "unknownprov")).toEqual({
		provider: "unknownprov",
		unusable: null,
		blockedUntil: sec(NOW_MS + 6 * HOUR),
		partial: [],
	});
	expect(byName(list, "qwen-local")).toEqual({ provider: "qwen-local", unusable: null, blockedUntil: null, partial: [] });
	expect(ompProviders(loadConfig({ home, env: {} }), NOW_MS)).toEqual(list);
});

test("disabledProviders switches a provider off, including one the models file added", () => {
	const home = shapeHome();
	writeFileSync(join(home, ".omp/agent/config.yml"), "disabledProviders:\n  - zai\n  - switched-off\n  - qwen-local\n");
	const list = readOmpProviders(home, NOW_MS);
	expect(byName(list, "zai")).toEqual({
		provider: "zai",
		unusable: "disabledProviders in config.yml",
		blockedUntil: null,
		partial: [],
	});
	expect(byName(list, "qwen-local").unusable).toBe("disabledProviders in config.yml");
	expect(byName(list, "switched-off")).toEqual({
		provider: "switched-off",
		unusable: "disabledProviders in config.yml",
		blockedUntil: null,
		partial: [],
	});
});

test("a missing store is null and a renamed column makes doctor name the problem", () => {
	const missing = freshHome();
	let missingError = "";
	try {
		readOmpProviders(missing, NOW_MS);
	} catch (err) {
		missingError = err instanceof Error ? err.message : String(err);
	}
	expect(missingError).not.toBe("");
	expect(ompProviders(loadConfig({ home: missing, env: {} }), NOW_MS)).toBeNull();
	const missingReport = doctorReport(missing, { PATH: "/nonexistent" });
	expect(missingReport.ok).toContain("providers: 0 read from ~/.omp/agent/agent.db");
	expect(missingReport.problems.some(p => p.startsWith("providers: cannot read"))).toBe(false);

	const renamed = freshHome();
	const db = new Database(join(renamed, ".omp/agent/agent.db"));
	db.run("CREATE TABLE auth_credentials (id INTEGER PRIMARY KEY, provider TEXT, cause TEXT, updated_at INTEGER)");
	db.run("CREATE TABLE auth_credential_blocks (credential_id INTEGER, block_scope TEXT, blocked_until_ms INTEGER)");
	db.close();
	let renamedError = "";
	try {
		readOmpProviders(renamed, NOW_MS);
	} catch (err) {
		renamedError = err instanceof Error ? err.message : String(err);
	}
	expect(renamedError).not.toBe("");
	expect(ompProviders(loadConfig({ home: renamed, env: {} }), NOW_MS)).toBeNull();
	const renamedReport = doctorReport(renamed, { PATH: "/nonexistent" });
	expect(renamedReport.problems).toContain(
		`providers: cannot read ${join(renamed, ".omp/agent/agent.db")}: ${renamedError} — main-start prints "harness providers: unreadable"`,
	);
});

test("doctor counts a readable store", () => {
	const home = freshHome();
	const db = openDb(home);
	cred(db, 1, "alpha", 1, null);
	db.close();
	const report = doctorReport(home, { PATH: "/nonexistent" });
	expect(report.ok).toContain("providers: 1 read from ~/.omp/agent/agent.db");
	expect(report.problems.join("\n")).not.toContain(CANARY);
});
