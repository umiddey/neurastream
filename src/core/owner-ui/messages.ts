// Owner messages (plan P13): inbox path, running-Main target routing, 12h message store, and image serving.

import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { nowSec } from "../clock.ts";
import type { Config } from "../config.ts";
import { isBusy } from "../file-lock.ts";
import { MAIN_ID_RE } from "../guards.ts";
import type { QueuePaths } from "../queue/lib.ts";
import { jsonFail, jsonSent, receiptText, redirect, textRes } from "./auth.ts";

export const MESSAGE_MAX = 4000;
const MESSAGE_IMAGES_MAX = 4;
const MESSAGE_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
/** How long the page keeps an owner message: 12 h, then the sweep removes it (owner, 2026-10-25 19:10). */
export const OWNER_MESSAGE_KEEP_SEC = 43200;

/** The inbox the page appends answers to and the adapter delivers from: under the queue state dir. */
export function inboxPath(paths: Pick<QueuePaths, "queue_state">): string {
	return `${paths.queue_state}/owner-inbox.jsonl`;
}

/** Where the page stores owner messages: under the queue state dir, one dir per message. */
function ownerMessagesDir(paths: Pick<QueuePaths, "queue_state">): string {
	return `${paths.queue_state}/owner-messages`;
}

/** Main ids with a live running.lock in their main state dir (P5 multi-main): the page's picker list and the @-routing target set. */
export function runningMains(cfg: Config): string[] {
	let dirs: string[];
	try {
		dirs = readdirSync(`${cfg.paths.queue_state}/mains`);
	} catch {
		return [];
	}
	return dirs
		.filter(d => MAIN_ID_RE.test(d) && isBusy(`${cfg.paths.queue_state}/mains/${d}/running.lock`))
		.toSorted();
}

/** Resolves where a message goes (P5 multi-main): an `@<id> ` prefix or the picker's `to` field names one running Main; empty is every Main. A stale target is refused before anything is stored. */
export function ownerMessageTarget(text: string, cfg: Config, formTo = ""): { to: string } | { refuse: string } {
	const at = /^@([a-z0-9-]{1,24})(?:\s|$)/.exec(text);
	const target = (at ? at[1] : formTo) ?? "";
	if (!target || !MAIN_ID_RE.test(target)) return { to: "" };
	const running = runningMains(cfg);
	if (running.includes(target)) return { to: target };
	return { refuse: `Main ${target} is not running; running: ${running.length ? running.join(", ") : "none"}` };
}

export interface MessageRow {
	id: string;
	ts: number;
	text: string;
	images: string[];
}

/** The image type from the first bytes — PNG, JPEG, GIF or WEBP — never from the client's name or content type. */
function imageType(bytes: Uint8Array): "png" | "jpeg" | "gif" | "webp" | null {
	if (
		bytes.length >= 8 &&
		bytes[0] === 0x89 &&
		bytes[1] === 0x50 &&
		bytes[2] === 0x4e &&
		bytes[3] === 0x47 &&
		bytes[4] === 0x0d &&
		bytes[5] === 0x0a &&
		bytes[6] === 0x1a &&
		bytes[7] === 0x0a
	)
		return "png";
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
	if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return "gif";
	if (
		bytes.length >= 12 &&
		bytes[0] === 0x52 &&
		bytes[1] === 0x49 &&
		bytes[2] === 0x46 &&
		bytes[3] === 0x46 &&
		bytes[8] === 0x57 &&
		bytes[9] === 0x45 &&
		bytes[10] === 0x42 &&
		bytes[11] === 0x50
	)
		return "webp";
	return null;
}

const IMAGE_EXT: Record<string, string> = { png: "png", jpeg: "jpg", gif: "gif", webp: "webp" };
const IMAGE_MIME: Record<string, string> = { png: "image/png", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

/** Removes every message dir older than the keep window; runs on every GET / and every POST /message. */
export function sweepOwnerMessages(now: number, paths: Pick<QueuePaths, "queue_state">): void {
	const dir = ownerMessagesDir(paths);
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return;
	}
	for (const name of names) {
		const ts = Number(name.slice(0, name.indexOf("-")));
		if (Number.isFinite(ts) && now - ts <= OWNER_MESSAGE_KEEP_SEC) continue;
		rmSync(`${dir}/${name}`, { recursive: true, force: true });
	}
}

/** The messages newer than the keep window for the "Sent today" list, newest first. A torn dir is skipped, not fatal. */
export function recentOwnerMessages(now: number, paths: Pick<QueuePaths, "queue_state">): MessageRow[] {
	const dir = ownerMessagesDir(paths);
	let names: string[] = [];
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	const rows: MessageRow[] = [];
	for (const id of names) {
		const dirTs = Number(id.slice(0, id.indexOf("-")));
		if (!Number.isFinite(dirTs) || now - dirTs >= OWNER_MESSAGE_KEEP_SEC) continue;
		try {
			const meta = JSON.parse(readFileSync(`${dir}/${id}/message.json`, "utf8")) as Record<string, unknown>;
			rows.push({
				id,
				ts: Number(meta.ts) || dirTs,
				text: typeof meta.text === "string" ? meta.text : "",
				images: Array.isArray(meta.images) ? meta.images.filter((n): n is string => typeof n === "string") : [],
			});
		} catch {}
	}
	return rows.sort((a, b) => b.ts - a.ts);
}

/** Stores an owner message (text and images) under a new id and inboxes it for Main (P13/P14). */
export function storeOwnerMessage(text: string, login: string, images: { bytes: Uint8Array; kind: string }[], to: string, paths: Pick<QueuePaths, "queue_state">): void {
	const ts = nowSec();
	// The dir name starts with a whole-second ts: the sweep and the image route both parse it.
	const id = `${Math.floor(ts)}-${randomUUID().slice(0, 6)}`;
	const dir = `${ownerMessagesDir(paths)}/${id}`;
	mkdirSync(dir, { recursive: true });
	const names: string[] = [];
	for (let i = 0; i < images.length; i++) {
		const name = `${i + 1}.${IMAGE_EXT[images[i]!.kind]}`;
		writeFileSync(`${dir}/${name}`, images[i]!.bytes);
		names.push(name);
	}
	writeFileSync(`${dir}/message.json`, `${JSON.stringify({ ts, text, login, to, images: names })}\n`);
	mkdirSync(paths.queue_state, { recursive: true });
	// The text stays out of owner-inbox.jsonl; Main reads message.json through the id (P14).
	appendFileSync(inboxPath(paths), `${JSON.stringify({ ts, kind: "message", id, login, to })}\n`);
}

// ---- POST /message (plan P13): the owner's one-way note plus images, inboxed by id ----

export async function handleMessage(req: Request, cfg: Config, login: string, wantsJson: boolean): Promise<Response> {
	sweepOwnerMessages(nowSec(), cfg.paths);
	const form = await req.formData();
	let text = "";
	let toField = "";
	const files: File[] = [];
	for (const [key, value] of form.entries()) {
		if (key === "text" && typeof value === "string") text = value.trim();
		else if (key === "to" && typeof value === "string") toField = value;
		// A form sent with no file chosen still carries one empty, nameless file part (Bun parses it as a nameless Blob).
		else if (key === "images" && (value as unknown) instanceof Blob) {
			const part = value as unknown as File;
			if (part.size > 0 || Boolean(part.name)) files.push(part);
		}
	}
	const fail = (error: string): Response => (wantsJson ? jsonFail(error, 400) : textRes(error, 400));
	if (!text && !files.length) return fail("write a text or attach an image");
	if (text.length > MESSAGE_MAX) return fail(`text is longer than ${MESSAGE_MAX} chars`);
	if (files.length > MESSAGE_IMAGES_MAX) return fail(`at most ${MESSAGE_IMAGES_MAX} images per message`);
	const images: { bytes: Uint8Array; kind: string }[] = [];
	for (const file of files) {
		if (file.size > MESSAGE_IMAGE_MAX_BYTES) return fail("an image is larger than 10 MB");
		const data = new Uint8Array(await file.arrayBuffer());
		const kind = imageType(data);
		if (!kind) return fail("attachments must be PNG, JPEG, GIF or WEBP images — the type is read from the file itself");
		images.push({ bytes: data, kind });
	}
	// P5: an `@<id>` prefix or the picker's to field names one Main; a stale name is refused before anything is stored.
	const pick = ownerMessageTarget(text, cfg, toField);
	if ("refuse" in pick) return fail(pick.refuse);
	storeOwnerMessage(text, login, images, pick.to, cfg.paths);
	if (wantsJson) return jsonSent("message", receiptText("message", new URLSearchParams()));
	return redirect("/?sent=message");
}

/** Serves one stored message image. Both path pieces are shape-checked and the name must be in message.json — raw input never reaches a path join. */
export function handleMessageImage(id: string, file: string, paths: Pick<QueuePaths, "queue_state">): Response {
	if (!/^[0-9]+-[0-9a-f]{6}$/.test(id) || !/^[0-9]+\.(png|jpg|gif|webp)$/.test(file)) return textRes("not found", 404);
	const dir = ownerMessagesDir(paths);
	let meta: Record<string, unknown>;
	try {
		meta = JSON.parse(readFileSync(`${dir}/${id}/message.json`, "utf8")) as Record<string, unknown>;
	} catch {
		return textRes("not found", 404);
	}
	const names = Array.isArray(meta.images) ? meta.images.filter((n): n is string => typeof n === "string") : [];
	if (!names.includes(file)) return textRes("not found", 404);
	try {
		return new Response(readFileSync(`${dir}/${id}/${file}`), {
			headers: { "content-type": IMAGE_MIME[file.slice(file.lastIndexOf(".") + 1)] ?? "application/octet-stream" },
		});
	} catch {
		return textRes("not found", 404);
	}
}
