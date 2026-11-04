// Provider out-until state (plan 20261025_1700 P1): who is rate-limited comes from live data,
// recorded by code from the provider's own words, never typed from memory. The state is an
// append-only JSONL file under <paths.queue_state>/provider-out.jsonl, one
// {provider, until, at, source} object per line; the newest record per provider wins. Decisions
// read it (agent-ledger --cap, the guards, the score gate); recordings come from
// `quota-reset --provider`, from task results that quote a reset time, and from rate-limited
// turn ends (the adapter wires those; this file stays harness-free). A harness status list is
// recorded here too, source `harness`, because this file already owns who is out — an adapter
// must not grow a second out-until store. Only a record this feed wrote is cleared when the
// list says that provider is ready again.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { nowSec, strftime } from "./clock.ts";
import { parseWhen, wallToEpoch } from "./reset-time.ts";

/** One recorded out-until: `until`/`at` are epoch seconds. */
export interface OutRecord {
	provider: string;
	until: number;
	at: number;
	source: string;
}

export function outFile(cfg: Config): string {
	return join(cfg.paths.queue_state, "provider-out.jsonl");
}

/** Every parseable record, oldest first; unparseable lines are skipped, never thrown. */
export function readOut(cfg: Config): OutRecord[] {
	let text: string;
	try {
		text = readFileSync(outFile(cfg), "utf8");
	} catch {
		return [];
	}
	const out: OutRecord[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const r = JSON.parse(line) as Partial<OutRecord>;
			if (typeof r.provider === "string" && typeof r.until === "number" && Number.isFinite(r.until)
				&& typeof r.at === "number" && Number.isFinite(r.at) && typeof r.source === "string") {
				out.push({ provider: r.provider, until: r.until, at: r.at, source: r.source });
			}
		} catch {}
	}
	return out;
}

/** Append one record. A failed write is swallowed like the other guard state files. */
export function recordOut(cfg: Config, provider: string, untilEpoch: number, source: string, at: number = Math.floor(Date.now() / 1000)): void {
	try {
		mkdirSync(cfg.paths.queue_state, { recursive: true });
		appendFileSync(outFile(cfg), `${JSON.stringify({ provider, until: untilEpoch, at, source })}\n`);
	} catch {}
}

/**
 * The provider's active out-until (epoch seconds), or null when it is free: the newest record's
 * until while it is still in the future, else null — absence of a record is free too, because
 * this file is the only source that may claim a limit.
 */
export function outUntil(cfg: Config, provider: string, now: number = nowSec()): number | null {
	let until: number | null = null;
	for (const r of readOut(cfg)) {
		if (r.provider !== provider) continue;
		until = r.until;
	}
	return until !== null && until > now ? until : null;
}

export interface ProviderOut {
	provider: string;
	/** Epoch seconds while out, null when free. */
	until: number | null;
}

/** Per recorded provider (configured order first, then the rest as first recorded): free or out. */
export function providerStatus(cfg: Config, now: number = nowSec()): ProviderOut[] {
	const records = readOut(cfg);
	const seen: string[] = [];
	for (const p of cfg.ledger.providers) {
		if (records.some(r => r.provider === p) && !seen.includes(p)) seen.push(p);
	}
	for (const r of records) {
		if (!seen.includes(r.provider)) seen.push(r.provider);
	}
	return seen.map(provider => ({ provider, until: outUntil(cfg, provider, now) }));
}

/**
 * The one `providers:` line for Main's decision points (agent-ledger --cap, main-start): each
 * recorded provider `free` or `out until <local HH:MM>`, configured order first. Null when
 * nothing is recorded — an empty line would invite guessing, the incident's exact mistake.
 */
export function providersLine(cfg: Config, now: number = nowSec()): string | null {
	const status = providerStatus(cfg, now);
	if (status.length === 0) return null;
	const parts = status.map(s => (s.until === null ? `${s.provider} free` : `${s.provider} out until ${strftime(s.until, "%H:%M")}`));
	return `providers: ${parts.join(" · ")}`;
}

/** The provider half of a `provider/model` pin, or null when the model names no provider. */
export function providerOfModel(model: string | null): string | null {
	if (!model || !model.includes("/")) return null;
	const provider = model.split("/")[0] ?? "";
	return provider === "" ? null : provider;
}

/**
 * The `model:` line of an agent's pin frontmatter (the shipped pin template's format, the same
 * one the session reader resolves a run's model from), or null when the pin is missing or silent.
 */
export function pinModel(cfg: Config, agent: string): string | null {
	if (!cfg.adapter?.pins || agent === "") return null;
	let text: string;
	try {
		text = readFileSync(join(cfg.adapter.pins, `${agent}.md`), "utf8");
	} catch {
		return null;
	}
	const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
	return /^model:\s*(\S+)/m.exec(fm?.[1] ?? "")?.[1] ?? null;
}

/**
 * The first reset time a text names, as epoch seconds, or null when it names none we can trust.
 * Reuses parseWhen/wallToEpoch: the wall time comes from capture group 1, the zone from group 2
 * when the text names one (Z/UTC/GMT, ±HH:MM) and `rule.zone` otherwise. reset-time.ts cannot
 * grow an export for this (the plan freezes that file), so the ±HH:MM arithmetic sits here.
 */
export function resetEpochFromText(text: string, rule: { pattern: string; zone: string }): number | null {
	let pattern: RegExp;
	try {
		pattern = new RegExp(rule.pattern);
	} catch {
		return null;
	}
	const m = pattern.exec(text);
	if (!m) return null;
	const wall = m[1] ? parseWhen(m[1]) : null;
	if (!wall) return null;
	const zone = (m[2] ?? "").trim();
	try {
		if (!zone || zone === rule.zone) return wallToEpoch(wall, rule.zone);
		if (zone === "Z" || zone === "UTC" || zone === "GMT") return wallToEpoch(wall, "UTC");
		const offset = /^([+-])(\d{2}):?(\d{2})$/.exec(zone);
		if (offset) {
			const minutes = (Number(offset[2]) * 60 + Number(offset[3])) * (offset[1] === "+" ? 1 : -1);
			return Math.floor((Date.UTC(wall.y, wall.mo - 1, wall.d, wall.h, wall.mi, wall.s) - minutes * 60_000) / 1000);
		}
		return wallToEpoch(wall, zone);
	} catch {
		return null;
	}
}

/** What a harness reports for one provider. `partial` is display-only and never an out-until. */
export interface ProviderStatus {
	provider: string;
	/** null = the harness can use it; otherwise a short reason it cannot. */
	unusable: string | null;
	/** Epoch seconds nothing is routed here until; null = not blocked. */
	blockedUntil: number | null;
	partial: { scope: string; until: number }[];
}

interface HarnessSnapshot {
	at: number;
	providers: ProviderStatus[];
}

function harnessSnapshotFile(cfg: Config): string {
	return join(cfg.paths.queue_state, "harness-providers.json");
}

/**
 * Record harness blocks into provider-out, and clear only the blocks this feed wrote once the
 * harness says the provider is ready. null does nothing. A failed write is swallowed by recordOut.
 */
export function syncHarnessOut(cfg: Config, list: ProviderStatus[] | null, now = nowSec()): void {
	if (list === null) return;
	for (const status of list) {
		if (status.blockedUntil !== null && status.blockedUntil > now) {
			const current = outUntil(cfg, status.provider, now);
			if (current === null || current < status.blockedUntil) {
				recordOut(cfg, status.provider, status.blockedUntil, "harness", now);
			}
			continue;
		}
		if (status.unusable !== null || status.blockedUntil !== null) continue;
		let newest: OutRecord | null = null;
		for (const row of readOut(cfg)) if (row.provider === status.provider) newest = row;
		if (newest !== null && newest.source === "harness" && newest.until > now) {
			recordOut(cfg, status.provider, now, "harness", now);
		}
	}
}

function sameLocalDay(t: number, now: number): boolean {
	const a = new Date(t * 1000);
	const b = new Date(now * 1000);
	return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function fmtWhen(t: number, now: number): string {
	return strftime(t, sameLocalDay(t, now) ? "%H:%M" : "%m-%d %H:%M");
}

type ListedKind = "ready" | "blocked" | "unusable";

function listedKind(status: ProviderStatus): ListedKind {
	if (status.unusable !== null) return "unusable";
	if (status.blockedUntil !== null) return "blocked";
	return "ready";
}

function byProvider(a: ProviderStatus, b: ProviderStatus): number {
	if (a.provider < b.provider) return -1;
	if (a.provider > b.provider) return 1;
	return 0;
}

function statusLine(list: ProviderStatus[], now: number): string | null {
	if (list.length === 0) return null;
	const sorted = list.toSorted(byProvider);
	const ready = sorted.filter(s => listedKind(s) === "ready");
	const blocked = sorted.filter(s => listedKind(s) === "blocked");
	const unusable = sorted.filter(s => listedKind(s) === "unusable");
	const partials: { provider: string; scope: string; until: number }[] = [];
	for (const status of sorted) {
		const scopes = status.partial.toSorted((a, b) => (a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : 0));
		for (const part of scopes) partials.push({ provider: status.provider, scope: part.scope, until: part.until });
	}
	const parts: string[] = [];
	if (ready.length > 0) parts.push(`ready ${ready.length}: ${ready.map(s => s.provider).join(", ")}`);
	if (blocked.length > 0) {
		parts.push(`blocked: ${blocked.map(s => `${s.provider} until ${fmtWhen(s.blockedUntil ?? 0, now)}`).join(", ")}`);
	}
	if (partials.length > 0) {
		parts.push(`partly blocked: ${partials.map(p => `${p.provider} ${p.scope} until ${fmtWhen(p.until, now)}`).join(", ")}`);
	}
	if (unusable.length > 0) parts.push(`unusable: ${unusable.map(s => `${s.provider} (${s.unusable})`).join(", ")}`);
	return `harness providers: ${parts.join(" · ")}`;
}

function changePhrase(name: string, from: ListedKind | "absent", to: ListedKind | "absent", next: ProviderStatus | undefined, now: number): string | null {
	if (from === "absent" && to === "ready") return `${name} new`;
	if (from === "absent" && to === "blocked" && next?.blockedUntil != null) return `${name} new, blocked until ${fmtWhen(next.blockedUntil, now)}`;
	if (from === "ready" && to === "blocked" && next?.blockedUntil != null) return `${name} blocked until ${fmtWhen(next.blockedUntil, now)}`;
	if ((from === "blocked" || from === "unusable") && to === "ready") return `${name} BACK`;
	if (from === "unusable" && to === "blocked" && next?.blockedUntil != null) return `${name} BACK, blocked until ${fmtWhen(next.blockedUntil, now)}`;
	if ((from === "ready" || from === "blocked") && to === "unusable") return `${name} unusable (${next?.unusable ?? ""})`;
	if (from !== "absent" && to === "absent") return `${name} gone`;
	if (to === "unusable") return `${name} unusable (${next?.unusable ?? ""})`;
	return null;
}

function changeLine(prev: ProviderStatus[], next: ProviderStatus[], prevAt: number, now: number): string | null {
	const before = new Map<string, ProviderStatus>();
	const after = new Map<string, ProviderStatus>();
	for (const status of prev) before.set(status.provider, status);
	for (const status of next) after.set(status.provider, status);
	const names = [...new Set([...before.keys(), ...after.keys()])].toSorted();
	const parts: string[] = [];
	for (const name of names) {
		const from = before.has(name) ? listedKind(before.get(name)!) : "absent";
		const to = after.has(name) ? listedKind(after.get(name)!) : "absent";
		if (from === to) continue;
		const phrase = changePhrase(name, from, to, after.get(name), now);
		if (phrase !== null) parts.push(phrase);
	}
	if (parts.length === 0) return null;
	return `provider changes since ${fmtWhen(prevAt, now)}: ${parts.join(" · ")}`;
}

function isProviderStatus(v: unknown): v is ProviderStatus {
	if (v === null || typeof v !== "object") return false;
	const row = v as Record<string, unknown>;
	if (typeof row.provider !== "string") return false;
	if (row.unusable !== null && typeof row.unusable !== "string") return false;
	if (row.blockedUntil !== null && (typeof row.blockedUntil !== "number" || !Number.isFinite(row.blockedUntil))) return false;
	if (!Array.isArray(row.partial)) return false;
	for (const part of row.partial) {
		if (part === null || typeof part !== "object") return false;
		const scope = (part as Record<string, unknown>).scope;
		const until = (part as Record<string, unknown>).until;
		if (typeof scope !== "string" || typeof until !== "number" || !Number.isFinite(until)) return false;
	}
	return true;
}

function readHarnessSnapshot(cfg: Config): HarnessSnapshot | null {
	let text: string;
	try {
		text = readFileSync(harnessSnapshotFile(cfg), "utf8");
	} catch {
		return null;
	}
	try {
		const parsed = JSON.parse(text) as Record<string, unknown>;
		if (typeof parsed.at !== "number" || !Number.isFinite(parsed.at) || !Array.isArray(parsed.providers)) return null;
		const providers: ProviderStatus[] = [];
		for (const item of parsed.providers) {
			if (!isProviderStatus(item)) return null;
			providers.push({
				provider: item.provider,
				unusable: item.unusable,
				blockedUntil: item.blockedUntil,
				partial: item.partial.map(part => ({ scope: part.scope, until: part.until })),
			});
		}
		return { at: parsed.at, providers };
	} catch {
		return null;
	}
}

function writeHarnessSnapshot(cfg: Config, snap: HarnessSnapshot): void {
	try {
		mkdirSync(cfg.paths.queue_state, { recursive: true });
		writeFileSync(harnessSnapshotFile(cfg), `${JSON.stringify(snap)}\n`);
	} catch {}
}

/**
 * The harness lines for a start: the current picture, then what moved since the last snapshot.
 * null means the harness store could not be read — the snapshot and provider-out stay untouched.
 * Never throws.
 */
export function harnessProviderLines(cfg: Config, list: ProviderStatus[] | null, now = nowSec()): string[] {
	try {
		if (list === null) return ["harness providers: unreadable — run neurastream doctor"];
		const prev = readHarnessSnapshot(cfg);
		writeHarnessSnapshot(cfg, { at: now, providers: list });
		const lines: string[] = [];
		const picture = statusLine(list, now);
		if (picture !== null) lines.push(picture);
		if (prev !== null) {
			const changes = changeLine(prev.providers, list, prev.at, now);
			if (changes !== null) lines.push(changes);
		}
		return lines;
	} catch {
		return [];
	}
}
