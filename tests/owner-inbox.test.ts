// P5 (plan 20261027_1300): owner messages route per Main. A row's `to` field names one Main
// (the page's picker or an `@<id> ` prefix); "" (and a pre-P5 row without the field) is every
// running Main. Each Main keeps its own read cursor for owner-messages/ in its mainStateDir, so
// a read never redelivers and a row for Main A never lands on Main B. `@<id>` naming a Main that
// is not running is refused before anything is stored (ownerMessageTarget — the page's POST
// /message path answers the owner; tests/owner-ui.test.ts covers the POST wiring).

import { afterAll, beforeEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config } from "../src/core/config.ts";
import { nowSec } from "../src/core/clock.ts";
import { tryLock } from "../src/core/file-lock.ts";
import { applyQueueEnv } from "../src/core/queue/env.ts";
import { stateDirPath } from "../src/core/queue/lib.ts";
import { inboxPath, ownerMessageTarget, runningMains } from "../src/core/owner-ui.ts";
import { deliverOwnerInbox, ownerInboxCursorPath, type ExtensionHost } from "../src/adapters/omp/index.ts";

const TMP = mkdtempSync(join(tmpdir(), "owner-inbox-"));
const baseCfg = loadConfig({ home: join(TMP, "home") });
const CFG: Config = { ...baseCfg, paths: { ...baseCfg.paths, queue_state: join(TMP, "state") } };
const savedId = process.env.NEURASTREAM_MAIN_ID;

beforeEach(() => {
	applyQueueEnv(CFG);
	process.env.NEURASTREAM_MAIN_ID = "main";
	rmSync(inboxPath(), { force: true });
	rmSync(join(stateDirPath(), "mains"), { recursive: true, force: true });
	rmSync(join(stateDirPath(), "owner-messages"), { recursive: true, force: true });
});

afterAll(() => {
	if (savedId === undefined) delete process.env.NEURASTREAM_MAIN_ID;
	else process.env.NEURASTREAM_MAIN_ID = savedId;
	rmSync(TMP, { recursive: true, force: true });
});

/** Holds <id>'s running lock for the test's body: runningMains sees it, release() frees it. */
function runMain(id: string): () => void {
	mkdirSync(join(stateDirPath(), "mains", id), { recursive: true });
	return tryLock(join(stateDirPath(), "mains", id, "running.lock"))!.release;
}

function phoneMessage(id: string, text: string): void {
	const dir = join(stateDirPath(), "owner-messages", id);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "message.json"), `${JSON.stringify({ ts: nowSec(), text, login: "owner", images: [] })}\n`);
}

/** One inbox line; `to === undefined` writes a pre-P5 row (no field = broadcast). */
function row(to: string | undefined, id: string): string {
	return `${JSON.stringify({ ts: nowSec(), kind: "message", id, login: "owner", ...(to === undefined ? {} : { to }) })}\n`;
}

/** Deliver the inbox as Main <id>; returns the user messages it sent. */
function deliverMain(id: string): string[] {
	process.env.NEURASTREAM_MAIN_ID = id;
	const sent: unknown[] = [];
	const pi = { sendUserMessage: (m: unknown) => void sent.push(m) } as unknown as ExtensionHost;
	deliverOwnerInbox(pi, CFG);
	// Payloads are text strings or content-part arrays; JSON keeps them comparable.
	return sent.map(m => JSON.stringify(m));
}

test("a row's to field routes it: a targeted row reaches its Main only, plain text reaches every Main", () => {
	const releaseA = runMain("a");
	const releaseB = runMain("b");
	phoneMessage("100-000abc", "old broadcast");
	phoneMessage("101-aaa001", "for a only");
	phoneMessage("102-bbb002", "for everyone");
	appendFileSync(inboxPath(), row(undefined, "100-000abc"));
	appendFileSync(inboxPath(), row("a", "101-aaa001"));
	appendFileSync(inboxPath(), row("", "102-bbb002"));
	expect(deliverMain("a")).toHaveLength(3);
	const b = deliverMain("b");
	expect(b).toHaveLength(2);
	expect(b.join("\n")).toContain("for everyone");
	expect(b.join("\n")).not.toContain("for a only");
	releaseA();
	releaseB();
});

test("each Main keeps its own read cursor in its mainStateDir; nothing redelivers", () => {
	const releaseA = runMain("a");
	phoneMessage("201-ccc003", "first");
	appendFileSync(inboxPath(), row(undefined, "201-ccc003"));
	expect(deliverMain("a")).toHaveLength(1);
	expect(readFileSync(ownerInboxCursorPath(CFG), "utf8")).toBe("1\n");
	expect(deliverMain("a")).toEqual([]);
	phoneMessage("202-ddd004", "second");
	appendFileSync(inboxPath(), row("a", "202-ddd004"));
	expect(deliverMain("a")).toHaveLength(1);
	expect(readFileSync(ownerInboxCursorPath(CFG), "utf8")).toBe("2\n");
	// B skips the row that names A but still hears the broadcast, on its own cursor.
	process.env.NEURASTREAM_MAIN_ID = "b";
	const bGot = deliverMain("b");
	expect(bGot).toHaveLength(1);
	expect(bGot[0]).toContain("first");
	expect(readFileSync(join(stateDirPath(), "mains", "b", "inbox-cursor"), "utf8")).toBe("2\n");
	releaseA();
});

test("@<id> to a Main that is not running is refused before anything is stored", () => {
	const releaseA = runMain("a");
	expect(runningMains(CFG)).toEqual(["a"]);
	expect(ownerMessageTarget("@a check the queue", CFG)).toEqual({ to: "a" });
	expect(ownerMessageTarget("plain words", CFG)).toEqual({ to: "" });
	expect(ownerMessageTarget("@gone hello", CFG)).toEqual({ refuse: "Main gone is not running; running: a" });
	expect(ownerMessageTarget("x", CFG, "b")).toEqual({ refuse: "Main b is not running; running: a" });
	expect(ownerMessageTarget("x", CFG, "a")).toEqual({ to: "a" });
	releaseA();
	expect(runningMains(CFG)).toEqual([]);
	expect(ownerMessageTarget("@a check", CFG)).toEqual({ refuse: "Main a is not running; running: none" });
});
