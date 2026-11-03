// Autonomy tiers (I-20261025-177): one owner setting — strict / opinionated / full — that the
// guards follow. The tier and the one-shot approve phrase (autonomy.go_phrase, default "go push")
// are written only by the owner's own words (the same
// paths as chatUnlock: the terminal input event and collab write-peer messages) or the
// authenticated phone page; never by a tool call (the state dir is protected) and never from
// model text. Every tier keeps the owner-only moves owner-only; no tier loosens them.

import { appendFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { configFile, loadConfig, type Config } from "./config.ts";
import { checkEdited, setConfigKeys, yamlValue } from "./config-edit.ts";
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

// Planner mode (plan 20261102_1515): who writes the plans. "main" is today's behaviour; in
// "delegated" the planner agent plans and Main routes. Same owner-switch family as the tier: a
// state file beside tierFile(), a whole-message chat command behind guards.chat_unlock, and the
// config value as the default when the file is absent or junk.

export type PlannerMode = "main" | "delegated";
const PLANNER_MODES: readonly PlannerMode[] = ["main", "delegated"];

export function plannerFile(): string {
	return path.join(stateDirPath(), "planner-mode");
}

// The effective mode facts are owner-only (P2 d). A guard baseline beside the config file records
// the state file's existence and bytes, the config file's own autonomy.planner and full bytes,
// and its paths.queue_state as the file states it (before any env overlay, which would mask a
// dirty line). A write a subagent slips into either file is caught at the next verify seam and
// reverted; only the owner's stampers (the chat command, a TTY config write of a mode key, a
// clean shutdown) create or refresh it. The baseline sits next to configFile(), a fixed anchor no
// config write can relocate, and it is in the built-in protected set (src/core/queue/lib.ts), so
// no tool can plant or edit it. No baseline = mode main: before the first owner stamp any state
// file is deleted and the config value is forced back to main, so nothing a non-owner wrote can
// take effect.

/** Where the baseline's facts live: the config file and the home its paths expand from. */
export interface PlannerPin {
	file: string;
	home: string;
}

export function plannerPin(cfg: Config): PlannerPin {
	return { file: cfg.file ?? configFile(cfg.paths.home), home: cfg.paths.home };
}

/** The baseline file: beside the config file it describes. */
export function plannerBaselineFile(pin: PlannerPin): string {
	return path.join(path.dirname(pin.file), "guard-baseline");
}

/** The config keys that carry a mode fact: a TTY write of one is a stamp. */
export function isPlannerModeKey(key: string): boolean {
	return key === "autonomy.planner" || key === "paths.queue_state";
}

interface PlannerState {
	exists: boolean;
	bytes: string | null;
}

interface PlannerBaseline {
	version: 1;
	/** The state dir the facts were recorded under: the mode file is always read there. */
	state_dir: string;
	planner: PlannerState;
	config: { planner: string; queue_state: string; bytes: string };
}

export function readPlannerState(file: string): PlannerState {
	try {
		return { exists: true, bytes: readFileSync(file, "utf8") };
	} catch {
		return { exists: false, bytes: null };
	}
}

function readPlannerBaseline(pin: PlannerPin): PlannerBaseline | null {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(plannerBaselineFile(pin), "utf8"));
	} catch {
		return null;
	}
	const b = raw as Record<string, unknown>;
	const planner = b.planner as Record<string, unknown> | undefined;
	const config = b.config as Record<string, unknown> | undefined;
	if (b.version !== 1 || typeof b.state_dir !== "string") return null;
	if (typeof config?.planner !== "string" || typeof config.queue_state !== "string" || typeof config.bytes !== "string") return null;
	return {
		version: 1,
		state_dir: b.state_dir,
		planner: { exists: planner?.exists === true, bytes: typeof planner?.bytes === "string" ? planner.bytes : null },
		config: { planner: config.planner, queue_state: config.queue_state, bytes: config.bytes },
	};
}

/** The mode facts a config FILE states: its own values, before any env overlay (QUEUE_STATE would mask a dirty line). */
function fileFacts(pin: PlannerPin): { planner: PlannerMode; queue_state: string } {
	const cfg = loadConfig({ file: pin.file, home: pin.home, env: {} });
	return { planner: cfg.autonomy.planner, queue_state: cfg.paths.queue_state };
}

/** Writes an edited config only when it still loads; false leaves the file untouched. */
function writeConfig(pin: PlannerPin, text: string): boolean {
	if (!checkEdited(text, pin.home, () => {})) return false;
	mkdirSync(path.dirname(pin.file), { recursive: true });
	writeFileSync(pin.file, text);
	return true;
}

export interface PlannerVerifyResult {
	/** True when a mode fact was dirty and has been restored. */
	reverted: boolean;
	/** The one line to show when something was reverted; null when clean. */
	hint: string | null;
}

const REVERT_HINT = "planner mode changes need your terminal or the chat command `planner <mode>`";

/**
 * Holds the mode facts to the baseline: a config value that differs is restored by value through
 * the one config editor (the baseline's full bytes only when the file no longer loads), and the
 * state file is restored to its recorded bytes or deleted. Runs at every seam — the adapter's
 * events and the guard process's first load — so the guards only ever see baseline-clean facts.
 */
export function verifyPlannerMode(pin: PlannerPin): PlannerVerifyResult {
	try {
		const base = readPlannerBaseline(pin);
		let text: string | null = null;
		try {
			text = readFileSync(pin.file, "utf8");
		} catch {
			text = null;
		}
		let facts: { planner: PlannerMode; queue_state: string } | null = null;
		try {
			facts = fileFacts(pin);
		} catch {
			facts = null;
		}
		let reverted = false;
		const values: Record<string, string> = {};
		if (facts === null) {
			// The file no longer parses: only the baseline's own bytes can restore it (a rare
			// dirty case; losing post-stamp sibling keys is accepted over leaving dirt in place).
			if (base !== null && text !== base.config.bytes) reverted = writeConfig(pin, base.config.bytes) || reverted;
		} else {
			const wantPlanner = base?.config.planner ?? "main";
			if (facts.planner !== wantPlanner && (PLANNER_MODES as readonly string[]).includes(wantPlanner)) values["autonomy.planner"] = yamlValue(wantPlanner);
			if (base !== null && facts.queue_state !== base.config.queue_state) values["paths.queue_state"] = yamlValue(base.config.queue_state);
		}
		if (Object.keys(values).length > 0) {
			let edited: string | null = null;
			try {
				edited = setConfigKeys(text, values);
			} catch {
				edited = null;
			}
			if (edited !== null && writeConfig(pin, edited)) reverted = true;
			else if (base !== null) reverted = writeConfig(pin, base.config.bytes) || reverted;
		}
		// The state file: pinned by the baseline; with no baseline it may not exist at all.
		const pinnedDir = base?.state_dir ?? stateDirPath();
		const pinnedFile = path.join(pinnedDir, "planner-mode");
		const want = base?.planner ?? { exists: false, bytes: null };
		const cur = readPlannerState(pinnedFile);
		if (want.exists) {
			if (cur.exists !== true || cur.bytes !== want.bytes) {
				mkdirSync(pinnedDir, { recursive: true });
				writeFileSync(pinnedFile, want.bytes ?? "");
				reverted = true;
			}
		} else if (cur.exists) {
			rmSync(pinnedFile, { force: true });
			reverted = true;
		}
		// A mode file beside the freshly configured state dir is foreign: the baseline pins the dir.
		const live = plannerFile();
		if (live !== pinnedFile && readPlannerState(live).exists) {
			rmSync(live, { force: true });
			reverted = true;
		}
		return { reverted, hint: reverted ? REVERT_HINT : null };
	} catch {
		// A guard never fails open on a broken read, and never crashes a running session.
		return { reverted: false, hint: null };
	}
}

/** Records the current mode facts as the baseline. Only a stamper calls this, after a clean verify. */
export function stampPlannerMode(pin: PlannerPin): void {
	try {
		const text = readFileSync(pin.file, "utf8");
		const facts = fileFacts(pin);
		const dir = stateDirPath();
		const base: PlannerBaseline = {
			version: 1,
			state_dir: dir,
			planner: readPlannerState(path.join(dir, "planner-mode")),
			config: { planner: facts.planner, queue_state: facts.queue_state, bytes: text },
		};
		mkdirSync(path.dirname(plannerBaselineFile(pin)), { recursive: true });
		writeFileSync(plannerBaselineFile(pin), `${JSON.stringify(base, null, 2)}\n`);
	} catch {}
}

/** The planner mode in force: the file twin of tierFile() when it names one of the two (one word), else the config value. */
export function currentPlanner(cfg: Config): PlannerMode {
	try {
		const word = readFileSync(plannerFile(), "utf8").trim().toLowerCase();
		if ((PLANNER_MODES as readonly string[]).includes(word)) return word as PlannerMode;
	} catch {}
	return cfg.autonomy.planner;
}

export interface ChatPlannerResult {
	/** True when the text was a whole-message `planner <mode>` command that took effect. */
	applied: boolean;
	/** The planner mode now in force. */
	planner?: PlannerMode;
}

const PLANNER_CMD = /^planner\s+(main|delegated)$/i;

/**
 * Owner planner switch by chat (guards.chat_unlock, the same flag as chatTier): the whole trimmed
 * message — "planner main" or "planner delegated", case-insensitive — writes the file twin of
 * tierFile(). Only the adapter and the owner page call this, with text the owner really typed or
 * tapped; a model, a tool result or a machine prompt must never reach it. Every applied switch is
 * logged to the plan-guard log with `word` naming the entry point ("chat" or "ui").
 */
export function chatPlanner(text: string, cfg: Config, source: string, word: "chat" | "ui" = "chat"): ChatPlannerResult {
	if (!cfg.guards.chat_unlock) return { applied: false };
	const m = PLANNER_CMD.exec(text.trim());
	if (!m) return { applied: false };
	const planner = (m[1] ?? "").toLowerCase() as PlannerMode;
	const pin = plannerPin(cfg);
	// The owner's own switch: revert any dirt first, write, then record the new state. The mode
	// file is written in-process, so no tool call sees it.
	verifyPlannerMode(pin);
	mkdirSync(stateDirPath(), { recursive: true });
	writeFileSync(plannerFile(), `${planner}\n`);
	stampPlannerMode(pin);
	try {
		appendFileSync(cfg.paths.plan_guard_log, `${new Date().toISOString()} PLANNER ${planner} ${word} source=${source}\n`);
	} catch {}
	return { applied: true, planner };
}
