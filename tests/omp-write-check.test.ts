// Write-time checks in the omp adapter: a subagent's write or edit that adds a lint finding or a
// suppression comment is put back and the call returns an error. Main's edits are left alone
// under applies_to "sub"; a new file with a finding is removed. The linter is the fixture stand-in.

import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOmpAdapter, reset as resetAdapter } from "../src/adapters/omp/index.ts";
import { loadConfig, type Config } from "../src/core/config.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

interface FakeHost {
	on(event: string, cb: Handler): void;
	registerCommand(name: string, opts: { description?: string; handler: (args: unknown, ctx: unknown) => unknown }): void;
	sendUserMessage(content: string): void;
	sendMessage(message: unknown, options: unknown): void;
	emit(event: string, payload: unknown, ctx: unknown): Promise<unknown[]>;
	sent: string[];
}

function fakeHost(): FakeHost {
	const handlers = new Map<string, Handler[]>();
	const sent: string[] = [];
	return {
		on(event, cb) {
			handlers.set(event, [...(handlers.get(event) ?? []), cb]);
		},
		registerCommand() {},
		sendUserMessage(content: string) {
			sent.push(content);
		},
		sendMessage() {},
		sent,
		async emit(event, payload, ctx) {
			const out: unknown[] = [];
			for (const cb of handlers.get(event) ?? []) {
				const r = await cb(payload, ctx);
				if (r !== undefined) out.push(r);
			}
			return out;
		},
	};
}

const TMP = mkdtempSync(join(tmpdir(), "write-check-"));
// The caller's shell may export live QUEUE_* (omp's plugin does); save and delete them so every
// path resolves under the sandbox home, as the chat-unlock test does.
const queueEnvBefore = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("QUEUE_")));
for (const k of Object.keys(queueEnvBefore)) delete process.env[k];
afterAll(() => {
	resetAdapter();
	rmSync(TMP, { recursive: true, force: true });
	for (const k of Object.keys(process.env)) if (k.startsWith("QUEUE_")) delete process.env[k];
	Object.assign(process.env, queueEnvBefore);
});

const FAKE = join(import.meta.dir, "fixtures/write-check/fake-linter.ts");
const base = loadConfig({ home: join(TMP, "home") });

function cfgWith(wc: Partial<Config["write_check"]> = {}): Config {
	return {
		...base,
		write_check: {
			...base.write_check,
			enabled: true,
			applies_to: "sub",
			timeout_ms: 5000,
			suppress: "noqa",
			linters: [{ ext: [".txt"], argv: [process.execPath, FAKE, "{file}"], pattern: "^.+?:\\d+:\\d+: (?<rule>\\S+) " }],
			...wc,
		},
	};
}

const SUB = { agent: { kind: "sub", id: "sub-1" }, cwd: TMP };
const MAIN = { agent: { kind: "main", id: "main" }, cwd: TMP };
const MAIN2 = { agent: { kind: "main", id: "main-2" }, cwd: TMP };
let seq = 0;

interface Refusal {
	isError: true;
	content: Array<{ type: string; text: string }>;
}

function isRefusal(r: unknown): r is Refusal {
	return typeof r === "object" && r !== null && "isError" in r && r.isError === true;
}

function isBlock(r: unknown): boolean {
	return typeof r === "object" && r !== null && "block" in r && r.block === true;
}

// One tool call the way the host runs it: the pre-call hook, the write lands, the post-call hook.
async function run(host: FakeHost, ctx: unknown, toolName: string, input: Record<string, unknown>, text: string): Promise<unknown[]> {
	const toolCallId = `call-${++seq}`;
	const pre = await host.emit("tool_call", { toolName, toolCallId, input }, ctx);
	expect(pre.some(isBlock)).toBe(false);
	writeFileSync(String(input.path), text);
	return host.emit("tool_result", { toolName, toolCallId, input, content: [{ type: "text", text: "done" }], isError: false }, ctx);
}

test("a subagent write that adds a lint finding is refused and the file is put back", async () => {
	const file = join(TMP, "refused.txt");
	writeFileSync(file, "ok\n");
	const host = fakeHost();
	createOmpAdapter(host as never, cfgWith());
	const results = await run(host, SUB, "write", { path: file }, "ok\nlint:no-eval\n");
	const refused = results.filter(isRefusal);
	expect(refused.length).toBe(1);
	expect(refused[0]?.content[0]?.text).toContain("write-check: this edit adds lint problems to");
	expect(refused[0]?.content[0]?.text).toContain("no-eval");
	expect(readFileSync(file, "utf8")).toBe("ok\n");
});

test("a clean subagent edit is kept", async () => {
	const file = join(TMP, "clean.txt");
	writeFileSync(file, "ok\n");
	const host = fakeHost();
	createOmpAdapter(host as never, cfgWith());
	const results = await run(host, SUB, "write", { path: file }, "ok\nfine\n");
	expect(results.filter(isRefusal)).toEqual([]);
	expect(readFileSync(file, "utf8")).toBe("ok\nfine\n");
});

test("a subagent edit that adds a suppression comment is refused", async () => {
	const file = join(TMP, "suppress.txt");
	writeFileSync(file, "ok\n");
	const host = fakeHost();
	createOmpAdapter(host as never, cfgWith());
	const results = await run(host, SUB, "write", { path: file }, "ok\nnoqa\n");
	const refused = results.filter(isRefusal);
	expect(refused.length).toBe(1);
	expect(refused[0]?.content[0]?.text).toContain("suppression");
	expect(readFileSync(file, "utf8")).toBe("ok\n");
});

test("a new file with a lint finding is removed", async () => {
	const file = join(TMP, "new.txt");
	const host = fakeHost();
	createOmpAdapter(host as never, cfgWith());
	const results = await run(host, SUB, "write", { path: file }, "lint:no-eval\n");
	expect(results.filter(isRefusal).length).toBe(1);
	expect(existsSync(file)).toBe(false);
});

test("applies_to sub leaves a Main edit alone", async () => {
	const file = join(TMP, "main.txt");
	writeFileSync(file, "ok\n");
	const host = fakeHost();
	createOmpAdapter(host as never, cfgWith());
	const results = await run(host, MAIN, "write", { path: file }, "lint:no-eval\n");
	expect(results.filter(isRefusal)).toEqual([]);
	expect(readFileSync(file, "utf8")).toBe("lint:no-eval\n");
});

test("enabled false leaves a subagent edit alone", async () => {
	const file = join(TMP, "off.txt");
	writeFileSync(file, "ok\n");
	const host = fakeHost();
	createOmpAdapter(host as never, cfgWith({ enabled: false }));
	const results = await run(host, SUB, "write", { path: file }, "lint:no-eval\n");
	expect(results.filter(isRefusal)).toEqual([]);
	expect(readFileSync(file, "utf8")).toBe("lint:no-eval\n");
});

test("a refused second edit on a file keeps the first allowed edit of the same batch", async () => {
	const file = join(TMP, "parallel.txt");
	writeFileSync(file, "ok\n");
	const host = fakeHost();
	createOmpAdapter(host as never, cfgWith());
	// Two calls issued before either result, as in one parallel batch; both snapshot "ok\n".
	const first = { toolName: "write", toolCallId: `call-${++seq}`, input: { path: file } };
	const second = { toolName: "write", toolCallId: `call-${++seq}`, input: { path: file } };
	expect((await host.emit("tool_call", first, SUB)).some(isBlock)).toBe(false);
	expect((await host.emit("tool_call", second, SUB)).some(isBlock)).toBe(false);
	writeFileSync(file, "ok\nfine\n");
	const r1 = await host.emit("tool_result", { ...first, content: [{ type: "text", text: "done" }], isError: false }, SUB);
	expect(r1.filter(isRefusal)).toEqual([]);
	writeFileSync(file, "ok\nfine\nlint:no-eval\n");
	const r2 = await host.emit("tool_result", { ...second, content: [{ type: "text", text: "done" }], isError: false }, SUB);
	expect(r2.filter(isRefusal).length).toBe(1);
	expect(readFileSync(file, "utf8")).toBe("ok\nfine\n");
});

test("a Main session's turn end steers only its own deferred files (I-20261028-166)", async () => {
	const file1 = join(TMP, "defer-s1.txt");
	const file2 = join(TMP, "defer-s2.txt");
	writeFileSync(file1, "ok\n");
	writeFileSync(file2, "ok\n");
	const host = fakeHost();
	createOmpAdapter(host as never, cfgWith({ applies_to: "all", defer_rules: ["f401"] }));
	await run(host, MAIN, "write", { path: file1 }, "ok\nlint:f401: one\n");
	await run(host, MAIN2, "write", { path: file2 }, "ok\nlint:f401: two\n");
	await host.emit("agent_end", {}, MAIN);
	expect(host.sent.length).toBe(1);
	expect(host.sent[0]).toContain("defer-s1.txt");
	expect(host.sent[0]).not.toContain("defer-s2.txt");
	// The other session's file is still pending: its own turn end steers it, once.
	await host.emit("agent_end", {}, MAIN2);
	expect(host.sent.length).toBe(2);
	expect(host.sent[1]).toContain("defer-s2.txt");
	await host.emit("agent_end", {}, MAIN2);
	expect(host.sent.length).toBe(2);
});

test("a subagent's deferred finding rides the tool result and the turn-end log, never a steer (I-20261028-166)", async () => {
	const file = join(TMP, "defer-sub.txt");
	writeFileSync(file, "ok\n");
	const host = fakeHost();
	createOmpAdapter(host as never, cfgWith({ defer_rules: ["f401"] }));
	const results = await run(host, SUB, "write", { path: file }, "ok\nlint:f401: helper\n");
	expect(results.filter(isRefusal)).toEqual([]);
	expect(readFileSync(file, "utf8")).toBe("ok\nlint:f401: helper\n");
	expect(JSON.stringify(results)).toContain("deferred");
	await host.emit("agent_end", {}, SUB);
	expect(host.sent).toEqual([]);
});

test("a deferred finding fixed by a later edit steers nothing (I-20261028-166)", async () => {
	const file = join(TMP, "defer-fixed.txt");
	writeFileSync(file, "ok\n");
	const host = fakeHost();
	createOmpAdapter(host as never, cfgWith({ applies_to: "all", defer_rules: ["f401"] }));
	await run(host, MAIN, "write", { path: file }, "ok\nlint:f401 helper\n");
	await run(host, MAIN, "write", { path: file }, "ok\nhelper used\n");
	await host.emit("agent_end", {}, MAIN);
	expect(host.sent).toEqual([]);
});
