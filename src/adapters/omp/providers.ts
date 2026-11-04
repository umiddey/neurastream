// omp's own picture of which providers it can use (plan 20261103_0955 P2). Sessions and traces
// live in session files; this reader is the only one that opens agent.db, and only to read.
// A schema change throws, and the caller turns that into null — never a guess that every
// provider is gone.

import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../../core/config.ts";
import type { ProviderStatus } from "../../core/provider-state.ts";

const DISABLED_REASON = "disabledProviders in config.yml";

interface Cred {
	id: number;
	provider: string;
	disabled_cause: string | null;
	updated_at: number;
}

interface Block {
	credential_id: number;
	block_scope: string;
	blocked_until_ms: number;
}

function requireNumber(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`auth field ${field} has an unexpected type`);
	return value;
}

function requireString(value: unknown, field: string): string {
	if (typeof value !== "string") throw new Error(`auth field ${field} has an unexpected type`);
	return value;
}

function isPartialScope(scope: string): boolean {
	return scope === "spark" || scope.startsWith("tier:") || scope.startsWith("pool:") || scope.startsWith("counter:");
}

function shortCause(cause: string): string {
	const head = (cause.split(":")[0] ?? "").trim();
	return head.length <= 40 ? head : head.slice(0, 40);
}

function readCreds(db: Database): Cred[] {
	const rows = db.query("SELECT id, provider, disabled_cause, updated_at FROM auth_credentials").all();
	const out: Cred[] = [];
	for (const row of rows) {
		if (row === null || typeof row !== "object") throw new Error("auth_credentials: row is not an object");
		const record = row as Record<string, unknown>;
		const provider = requireString(record.provider, "provider");
		if (provider.startsWith("mcp_oauth:")) continue;
		if (record.disabled_cause !== null && typeof record.disabled_cause !== "string") {
			throw new Error("auth field disabled_cause has an unexpected type");
		}
		out.push({
			id: requireNumber(record.id, "id"),
			provider,
			disabled_cause: record.disabled_cause,
			updated_at: requireNumber(record.updated_at, "updated_at"),
		});
	}
	return out;
}

function readBlocks(db: Database, nowMs: number): Block[] {
	const rows = db.query("SELECT credential_id, block_scope, blocked_until_ms FROM auth_credential_blocks WHERE blocked_until_ms > ?").all(nowMs);
	const out: Block[] = [];
	for (const row of rows) {
		if (row === null || typeof row !== "object") throw new Error("auth_credential_blocks: row is not an object");
		const record = row as Record<string, unknown>;
		out.push({
			credential_id: requireNumber(record.credential_id, "credential_id"),
			block_scope: requireString(record.block_scope, "block_scope"),
			blocked_until_ms: requireNumber(record.blocked_until_ms, "blocked_until_ms"),
		});
	}
	return out;
}

function blocksFor(blocks: Block[], id: number): Block[] {
	const out: Block[] = [];
	for (const block of blocks) if (block.credential_id === id) out.push(block);
	return out;
}

function latestEnd(blocks: Block[], want: (scope: string) => boolean): number | null {
	let latest: number | null = null;
	for (const block of blocks) {
		if (!want(block.block_scope)) continue;
		if (latest === null || block.blocked_until_ms > latest) latest = block.blocked_until_ms;
	}
	return latest;
}

function statusFor(provider: string, creds: Cred[], blocks: Block[]): ProviderStatus {
	const active = creds.filter(cred => cred.disabled_cause === null);
	if (active.length === 0) {
		let newest = creds[0];
		if (newest === undefined) throw new Error(`auth_credentials: ${provider} has no rows`);
		for (const cred of creds) {
			if (cred.updated_at > newest.updated_at || (cred.updated_at === newest.updated_at && cred.id > newest.id)) newest = cred;
		}
		if (newest.disabled_cause === null) throw new Error(`auth_credentials: ${provider} has no usable cause`);
		return { provider, unusable: shortCause(newest.disabled_cause), blockedUntil: null, partial: [] };
	}
	let wholeMin: number | null = null;
	for (const cred of active) {
		const end = latestEnd(blocksFor(blocks, cred.id), scope => !isPartialScope(scope));
		if (end === null) {
			wholeMin = null;
			break;
		}
		wholeMin = wholeMin === null ? end : Math.min(wholeMin, end);
	}
	const blockedUntil = wholeMin === null ? null : Math.floor(wholeMin / 1000);
	const partial: { scope: string; until: number }[] = [];
	if (blockedUntil === null) {
		const scopes = new Set<string>();
		for (const cred of active) {
			for (const block of blocksFor(blocks, cred.id)) if (isPartialScope(block.block_scope)) scopes.add(block.block_scope);
		}
		for (const scope of [...scopes].toSorted()) {
			let min: number | null = null;
			let every = true;
			for (const cred of active) {
				const end = latestEnd(blocksFor(blocks, cred.id), candidate => candidate === scope);
				if (end === null) {
					every = false;
					break;
				}
				min = min === null ? end : Math.min(min, end);
			}
			if (every && min !== null) partial.push({ scope, until: Math.floor(min / 1000) });
		}
	}
	return { provider, unusable: null, blockedUntil, partial };
}

function readYaml(path: string): unknown {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw err;
	}
	return Bun.YAML.parse(text);
}

function mapping(value: unknown, where: string): Record<string, unknown> | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== "object" || Array.isArray(value)) throw new Error(`${where}: expected a mapping`);
	return value as Record<string, unknown>;
}

function modelProviderNames(home: string): string[] {
	const parsed = mapping(readYaml(join(home, ".omp/agent/models.yml")), "models.yml");
	if (parsed === null) return [];
	const providers = parsed.providers;
	if (providers === undefined || providers === null) return [];
	const map = mapping(providers, "models.yml providers");
	return map === null ? [] : Object.keys(map);
}

function disabledProviderNames(home: string): string[] {
	const parsed = mapping(readYaml(join(home, ".omp/agent/config.yml")), "config.yml");
	if (parsed === null) return [];
	const list = parsed.disabledProviders;
	if (list === undefined || list === null) return [];
	if (!Array.isArray(list)) throw new Error("disabledProviders: expected a list");
	return list.map(item => {
		if (typeof item !== "string") throw new Error("disabledProviders: expected strings");
		return item;
	});
}

/** Throws on any read or schema error. The secret column is never selected. */
export function readOmpProviders(home: string, nowMs: number): ProviderStatus[] {
	const db = new Database(join(home, ".omp/agent/agent.db"), { readonly: true });
	try {
		const creds = readCreds(db);
		const blocks = readBlocks(db, nowMs);
		const byProvider = new Map<string, Cred[]>();
		for (const cred of creds) {
			const group = byProvider.get(cred.provider) ?? [];
			group.push(cred);
			byProvider.set(cred.provider, group);
		}
		const list: ProviderStatus[] = [];
		for (const [provider, group] of byProvider) list.push(statusFor(provider, group, blocks));
		for (const name of modelProviderNames(home)) {
			if (!list.some(status => status.provider === name)) {
				list.push({ provider: name, unusable: null, blockedUntil: null, partial: [] });
			}
		}
		for (const name of disabledProviderNames(home)) {
			const row: ProviderStatus = { provider: name, unusable: DISABLED_REASON, blockedUntil: null, partial: [] };
			const at = list.findIndex(status => status.provider === name);
			if (at >= 0) list[at] = row;
			else list.push(row);
		}
		return list.toSorted((a, b) => (a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0));
	} finally {
		db.close();
	}
}

/** null when the store cannot be read; doctor names the error. */
export function ompProviders(cfg: Config, nowMs = Date.now()): ProviderStatus[] | null {
	try {
		return readOmpProviders(cfg.paths.home, nowMs);
	} catch {
		return null;
	}
}
