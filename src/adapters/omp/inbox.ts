// Owner inbox delivery (plan 20261024_2230 P3b) and machine pressure tick (plan 20261026_0100 P2).
// The phone page appends answers to <queue_state>/owner-inbox.jsonl — a protected state file, so
// no agent can forge an owner answer (guards refuse the write). Main's session delivers each
// record once as a user message (pi.sendUserMessage, no options: idle → a new turn, streaming →
// the steer queue), at turn end and on a 15 s timer while idle. The consumed-row count lives in
// <queue_state>/mains/<id>/inbox-cursor; subagent sessions never deliver and never move it.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { strftime } from "../../core/clock.ts";
import type { Config } from "../../core/config.ts";
import { mainId, mainStateDir } from "../../core/guards.ts";
import { inboxPath } from "../../core/owner-ui.ts";
import { currentHolder, pressureLevel, pressureMessage, pressureTransition, type PressureSample, type PressureState } from "../../core/pressure.ts";
import type * as q from "../../core/queue/lib.ts";
import { adapterLog } from "./launch.ts";
import { asString, type ExtensionHost } from "./types.ts";

/** Idle-poll interval for the owner inbox. */
export const OWNER_INBOX_POLL_MS = 15_000;
/** How often the adapter heartbeats every claim this Main holds (plan 20261027_1300 P3). */
export const CLAIM_BEAT_MS = 60_000;

/** The delivered cursor: how many owner-inbox rows this Main's session has consumed (P5: one file per Main, under its mainStateDir). */
export function ownerInboxCursorPath(cfg: Config | Pick<q.QueuePaths, "queue_state">): string {
	return `${mainStateDir(cfg)}/inbox-cursor`;
}

/** Rows this Main starts past when it has never delivered (P5): set at adapter creation so a Main that registers late does not replay old rows. null = adopt the file or 0. */
let inboxFloor: number | null = null;

/**
 * Seeds the per-Main inbox cursor floor once at adapter creation so a newly registered Main does
 * not replay historical inbox rows; adopts the legacy cursor file for `main` if present.
 *
 * Args:
 *     cfg (Config): Loaded neurastream configuration
 */
export function seedInboxFloor(cfg: Config): void {
	try {
		if (!existsSync(ownerInboxCursorPath(cfg))) {
			mkdirSync(mainStateDir(cfg), { recursive: true });
			if (mainId() === "main") {
				try {
					renameSync(`${cfg.paths.queue_state}/owner-inbox.cursor`, ownerInboxCursorPath(cfg));
				} catch {}
			}
			if (!existsSync(ownerInboxCursorPath(cfg))) {
				try {
					inboxFloor = pendingInboxRecords(readFileSync(inboxPath(cfg.paths), "utf8"), 0).next;
				} catch {
					inboxFloor = 0;
				}
			}
		}
	} catch {}
}

function readOwnerInboxCursor(cfg: Config): number {
	try {
		const n = Number(readFileSync(ownerInboxCursorPath(cfg), "utf8").trim());
		return Number.isInteger(n) && n >= 0 ? n : inboxFloor ?? 0;
	} catch {
		return inboxFloor ?? 0;
	}
}

function writeOwnerInboxCursor(cfg: Config, n: number): void {
	try {
		mkdirSync(mainStateDir(cfg), { recursive: true });
		writeFileSync(ownerInboxCursorPath(cfg), `${n}\n`);
	} catch {}
}

/** The user message one inbox record becomes, or null when the record is not one Main can act on.
 * Records without `kind` are page answers (the original shape). */
export function ownerInboxMessage(rec: Record<string, unknown>, queuePaths?: Pick<q.QueuePaths, "queue_state">): string | ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] | null {
	const kind = rec.kind === undefined ? "answer" : asString(rec.kind);
	const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
	switch (kind) {
		case "answer": {
			const plan = asString(rec.plan);
			const question = asString(rec.question);
			const answer = asString(rec.answer);
			if (!plan || !question || !answer) return null;
			return `Owner answered on the phone page — ${basename(plan)}: ${question} → ${answer}`;
		}
		case "unlock": {
			const minutes = num(rec.minutes);
			const until = num(rec.until);
			if (minutes === null || until === null) return null;
			return `Owner unlocked the guards from the phone page for ${minutes} min (until ${strftime(until, "%H:%M")}). Do the step that waited on the unlock now.`;
		}
		case "lock":
			return "Owner locked the guards from the phone page.";
		case "approval": {
			const page = asString(rec.page);
			const plan = asString(rec.plan);
			if (page === "" || plan === "") return null;
			return `Owner approved ${basename(plan)} on page ${page}.`;
		}
		case "reorder": {
			const plan = asString(rec.plan);
			const from = num(rec.from);
			const to = num(rec.to);
			if (!plan || from === null || to === null) return null;
			return `Owner moved ${basename(plan)} from #${from} to #${to} on the phone page; INDEX.md has the new order — work by it.`;
		}
		case "message": {
			const ts = num(rec.ts);
			const id = asString(rec.id);
			if (ts === null || !/^[0-9]+-[0-9a-f]{6}$/.test(id)) return null;
			const at = strftime(ts, "%H:%M");
			if (!queuePaths) return null;
			const dir = join(queuePaths.queue_state, "owner-messages", id);
			let message: Record<string, unknown>;
			try {
				message = JSON.parse(readFileSync(join(dir, "message.json"), "utf8")) as Record<string, unknown>;
			} catch {
				return [{ type: "text", text: `Owner sent a message from the phone page at ${at}; it expired (12 h) before delivery.` }];
			}
			const text = asString(message.text);
			const names = Array.isArray(message.images) ? message.images.filter((name): name is string => typeof name === "string" && /^[1-4]\.(png|jpg|gif|webp)$/.test(name)) : [];
			const parts: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [];
			const paths = names.map(name => join(dir, name));
			parts.push({
				type: "text",
				text: `Owner message from the phone page (${at}): ${text}${paths.length ? `\nImages:\n${paths.map(path => `- ${path}`).join("\n")}` : ""}`,
			});
			for (const name of names) {
				const ext = name.slice(name.lastIndexOf(".") + 1);
				const mimeType = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
				try {
					parts.push({ type: "image", data: readFileSync(join(dir, name)).toString("base64"), mimeType });
				} catch {
					return [{ type: "text", text: `Owner sent a message from the phone page at ${at}; it expired (12 h) before delivery.` }];
				}
			}
			return parts;
		}
		case "page-note": {
			// One row per note the owner left on a published page (plan 20261026 P6).
			const page = asString(rec.page);
			const quote = asString(rec.quote);
			const note = asString(rec.note);
			if (!page || !note) return null;
			const id = asString(rec.id);
			const url = asString(rec.url);
			const where = `Owner note on the page ${page}${id ? ` (${id})` : ""}${url ? ` — ${url}` : ""}: `;
			return quote ? `${where}on "${quote}" → ${note}` : `${where}${note}`;
		}
		default:
			return null;
	}
}

/** The JSONL rows after `cursor` (a row count), as records, plus the new cursor. A torn last row
 * (a page write that has not landed completely) stays unconsumed; a malformed complete row is
 * consumed but skipped, so one bad line cannot wedge delivery. */
export function pendingInboxRecords(text: string, cursor: number): { records: Record<string, unknown>[]; next: number } {
	const endsClean = text === "" || text.endsWith("\n");
	const rows = text.split("\n");
	if (rows.length && rows[rows.length - 1] === "") rows.pop();
	const records: Record<string, unknown>[] = [];
	let next = Math.min(cursor, rows.length);
	for (let i = cursor; i < rows.length; i++) {
		const torn = i === rows.length - 1 && !endsClean;
		try {
			const rec: unknown = JSON.parse((rows[i] ?? "").trim());
			if (rec !== null && typeof rec === "object" && !Array.isArray(rec)) records.push(rec as Record<string, unknown>);
		} catch {}
		if (!torn) next = i + 1;
	}
	return { records, next };
}

/** Deliver every inbox row past the cursor once, as a user message to Main; then store the cursor.
 * Synchronous, so the turn-end path and the idle timer cannot interleave. */
export function deliverOwnerInbox(pi: ExtensionHost, cfg: Config): void {
	let text: string;
	try {
		text = readFileSync(inboxPath(cfg.paths), "utf8");
	} catch {
		return; // no inbox yet: nothing to deliver
	}
	const cursor = readOwnerInboxCursor(cfg);
	const { records, next } = pendingInboxRecords(text, cursor);
	if (next === cursor) return;
	let delivered = 0;
	for (const rec of records) {
		// P5: a row addressed to another Main (`to` set and not this Main's id) is consumed but not delivered here.
		if (typeof rec.to === "string" && rec.to !== "" && rec.to !== mainId()) continue;
		const msg = ownerInboxMessage(rec, cfg.paths);
		if (msg === null) continue;
		pi.sendUserMessage(msg);
		delivered++;
	}
	writeOwnerInboxCursor(cfg, next);
	adapterLog(cfg, `owner inbox: delivered ${delivered} answer(s) (cursor ${cursor} → ${next})`);
}

/** Pressure alert tick (plan 20261026_0100 P2): classifies one sample, runs the transition, and tells Main on a RED or GREEN fire. The state lives in <queue_state>/pressure.json and is rewritten only when it changes, so a reloaded session does not re-fire. */
export function pressureTick(pi: ExtensionHost, cfg: Config, sample: PressureSample, now: number): void {
	const file = join(cfg.paths.queue_state, "pressure.json");
	let prev: PressureState | null = null;
	try {
		prev = JSON.parse(readFileSync(file, "utf8")) as PressureState;
	} catch {}
	const level = pressureLevel(sample, cfg);
	const r = pressureTransition(prev, level, now, cfg);
	const next = JSON.stringify(r.state);
	if (next !== JSON.stringify(prev)) {
		try {
			mkdirSync(cfg.paths.queue_state, { recursive: true });
			writeFileSync(file, next);
		} catch {}
	}
	if (r.fire === "red") {
		pi.sendUserMessage(pressureMessage("red", sample, currentHolder(cfg, now)));
	} else if (r.fire === "green") pi.sendUserMessage(pressureMessage("green", sample, null));
}
