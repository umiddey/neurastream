import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOmpAdapter, reset as resetAdapter } from "../src/adapters/omp/index.ts";
import { loadConfig } from "../src/core/config.ts";
import { applyQueueEnv } from "../src/core/queue/env.ts";

const TMP = mkdtempSync(join(tmpdir(), "reset-time-omp-"));
const HOME = join(TMP, "home");
const QUEUE_STATE = join(TMP, "queue-state");
const INDEX = join(TMP, "INDEX.md");
const GUARD_LOG = join(TMP, "guard.log");

type Handler = (event: unknown, ctx: unknown) => unknown;
const handlers = new Map<string, Handler[]>();
const host = {
	on(event: string, cb: Handler) { handlers.set(event, [...(handlers.get(event) ?? []), cb]); },
	registerCommand() {},
	sendUserMessage() {},
	sendMessage() {},
};
// applyQueueEnv below points QUEUE_* env at the sandbox; restore the caller's at the end.
const queueEnvBefore = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("QUEUE_")));
const cfg = loadConfig({ home: HOME, env: { ...process.env, HOME } });
applyQueueEnv({ ...cfg, paths: { ...cfg.paths, home: HOME, queue_index: INDEX, queue_state: QUEUE_STATE, guard_log: GUARD_LOG } });
createOmpAdapter(host, cfg);
const mainCtx = { agent: { kind: "main", id: "main" }, cwd: TMP };
const subCtx = { agent: { kind: "subagent", id: "sub" }, cwd: TMP };

async function context(messages: unknown[], ctx = mainCtx): Promise<unknown[]> {
	const result: unknown[] = [];
	for (const handler of handlers.get("context") ?? []) {
		const value = await handler({ messages }, ctx);
		if (value !== undefined) result.push(value);
	}
	return result;
}

afterAll(() => {
	resetAdapter();
	rmSync(TMP, { recursive: true, force: true });
	for (const k of Object.keys(process.env)) if (k.startsWith("QUEUE_")) delete process.env[k];
	Object.assign(process.env, queueEnvBefore);
});

test("annotates reset times in message text before Main sees context", async () => {
	const before = process.env.TZ;
	process.env.TZ = "Europe/Berlin";
	try {
		const messages = [
			{ role: "toolResult", content: "Your limit will reset at 2026-10-25 18:56:22" },
			{ role: "user", content: [{ type: "text", text: "reset at 2027-07-01 12:00:00" }] },
		];
		const result = await context(messages);
		expect(result).toHaveLength(1);
		expect(result[0]).toEqual({ messages: [
			{ role: "toolResult", content: "Your limit will reset at 2026-10-25 18:56:22 (= 2026-10-25 11:56:22 CET local)" },
			{ role: "user", content: [{ type: "text", text: "reset at 2027-07-01 12:00:00 (= 2027-07-01 06:00:00 CEST local)" }] },
		] });
	} finally {
		if (before === undefined) delete process.env.TZ;
		else process.env.TZ = before;
	}
});

test("returns undefined when context text is unchanged or belongs to a subagent", async () => {
	expect(await context([{ role: "user", content: "ordinary message" }])).toEqual([]);
	expect(await context([{ role: "toolResult", content: "Your limit will reset at 2026-10-25 18:56:22" }], subCtx)).toEqual([]);
});
