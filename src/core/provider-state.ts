// Provider out-until state (plan 20261025_1700 P1): who is rate-limited comes from live data,
// recorded by code from the provider's own words, never typed from memory. The state is an
// append-only JSONL file under <paths.queue_state>/provider-out.jsonl, one
// {provider, until, at, source} object per line; the newest record per provider wins. Decisions
// read it (agent-ledger --cap, the guards, the score gate); recordings come from
// `quota-reset --provider`, from task results that quote a reset time, and from rate-limited
// turn ends (the adapter wires those; this file stays harness-free).

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
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
