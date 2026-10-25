// Autonomy tiers (I-20261025-177): one owner setting — strict / opinionated / full — that the
// guards follow. The tier and the one-shot approve phrase (autonomy.go_phrase, default "go push")
// are written only by the owner's own words (the same
// paths as chatUnlock: the terminal input event and collab write-peer messages) or the
// authenticated phone page; never by a tool call (the state dir is protected) and never from
// model text. Every tier keeps the owner-only moves owner-only; no tier loosens them.

import { appendFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Config } from "./config.ts";
import { stateDirPath } from "./queue/lib.ts";

export type Tier = "strict" | "opinionated" | "full";
const TIERS: readonly Tier[] = ["strict", "opinionated", "full"];

export function tierFile(): string {
	return path.join(stateDirPath(), "autonomy-tier");
}

export function goFile(): string {
	return path.join(stateDirPath(), "autonomy-go");
}

/** The tier the guards follow: `<state dir>/autonomy-tier` when it names one of the three (one word), else the config value. */
export function currentTier(cfg: Config): Tier {
	try {
		const word = readFileSync(tierFile(), "utf8").trim().toLowerCase();
		if ((TIERS as readonly string[]).includes(word)) return word as Tier;
	} catch {}
	return cfg.autonomy.tier;
}

export interface ChatTierResult {
	/** True when the text was a whole-message `tier <name>` command that took effect. */
	applied: boolean;
	/** The tier now in force. */
	tier?: Tier;
}

const TIER_CMD = /^tier\s+(strict|opinionated|full)$/i;

/**
 * Owner tier switch by chat (guards.chat_unlock, the same flag as chatUnlock): the whole trimmed
 * message — "tier strict", "tier opinionated" or "tier full", case-insensitive — writes
 * `<state dir>/autonomy-tier`. Only the adapter and the owner page call this, with text the owner
 * really typed or tapped; a model, a tool result or a machine prompt must never reach it. Every
 * applied switch is logged to the plan-guard log with `word` naming the entry point ("chat" or "ui").
 */
export function chatTier(text: string, cfg: Config, source: string, word: "chat" | "ui" = "chat"): ChatTierResult {
	if (!cfg.guards.chat_unlock) return { applied: false };
	const m = TIER_CMD.exec(text.trim());
	if (!m) return { applied: false };
	const tier = (m[1] ?? "").toLowerCase() as Tier;
	mkdirSync(stateDirPath(), { recursive: true });
	writeFileSync(tierFile(), `${tier}\n`);
	try {
		appendFileSync(cfg.paths.plan_guard_log, `${new Date().toISOString()} TIER ${tier} ${word} source=${source}\n`);
	} catch {}
	return { applied: true, tier };
}

export interface ChatGoResult {
	/** True when the text was a whole-message approve phrase that took effect. */
	applied: boolean;
	/** The minutes this `go` stays valid (autonomy.go_minutes), for the owner notice. */
	minutes?: number;
}

/** The shape a phrase is matched in: trimmed, lowercased, inner whitespace collapsed. */
const goWords = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * The strict tier's one-shot landing approval by chat (guards.chat_unlock): the whole trimmed
 * message matching `autonomy.go_phrase` (default "go push") — case-insensitive, inner spaces
 * collapsed — touches `<state dir>/autonomy-go`; the next strict push/merge consumes it
 * (takeGo). Same trust rules as chatTier. A bare "go" is an ordinary message (I-20261025-201):
 * it approves nothing.
 */
export function chatGo(text: string, cfg: Config, source: string, word: "chat" | "ui" = "chat"): ChatGoResult {
	if (!cfg.guards.chat_unlock) return { applied: false };
	if (goWords(text) !== goWords(cfg.autonomy.go_phrase)) return { applied: false };
	mkdirSync(stateDirPath(), { recursive: true });
	writeFileSync(goFile(), "");
	try {
		appendFileSync(cfg.paths.plan_guard_log, `${new Date().toISOString()} GO ${word} source=${source} minutes=${cfg.autonomy.go_minutes}\n`);
	} catch {}
	return { applied: true, minutes: cfg.autonomy.go_minutes };
}

/**
 * Consume a standing `go`: true once — the file is deleted — when it is younger than
 * autonomy.go_minutes; a stale or missing file is false (a stale one is removed).
 */
export function takeGo(cfg: Config, now = Date.now()): boolean {
	let mtimeMs: number;
	try {
		mtimeMs = statSync(goFile()).mtimeMs;
	} catch {
		return false;
	}
	rmSync(goFile(), { force: true });
	return now - mtimeMs < cfg.autonomy.go_minutes * 60_000;
}
