// P2 (plan 20261025_1700): live provider state is SHOWN where Main decides. `agent-ledger --cap`
// and main-start print one `providers:` line built from provider-out.jsonl, and the rollover note
// request stops Main from stating rate-limit state from memory — INCIDENT I-20261025-164: Main
// typed "glm out until 18:56" from a Shanghai-time 429 and skipped a free GLM all day.

import { afterAll, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentLedger } from "../src/core/agent-ledger.ts";
import type { RunSource } from "../src/core/adapter.ts";
import { nowSec, strftime } from "../src/core/clock.ts";
import { loadConfig, type Config } from "../src/core/config.ts";
import { mainStartText } from "../src/core/main-start.ts";
import { noteRequest } from "../src/core/rollover.ts";
import { recordOut } from "../src/core/provider-state.ts";

const TMP = mkdtempSync(join(tmpdir(), "pstate-show-"));
// Inherited QUEUE_* (the caller's live session, or an in-process adapter in an earlier test
// file) beats the sandbox config in loadConfig; save, delete and restore them. No test here may
// touch the live state dir (INCIDENT I-20261027-129).
const queueEnvBefore = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("QUEUE_")));
for (const k of Object.keys(queueEnvBefore)) delete process.env[k];

afterAll(() => {
	for (const k of Object.keys(queueEnvBefore)) delete process.env[k];
	Object.assign(process.env, queueEnvBefore);
	rmSync(TMP, { recursive: true, force: true });
});

const STUBS: Record<string, string> = {
	"machine-guard": "#!/bin/sh\necho MG_STUB_LINE\n",
	"agent-ledger": "#!/bin/sh\nexit 0\n",
	"main-health": "#!/bin/sh\nexit 0\n",
	"queue-check": "#!/bin/sh\nexit 0\n",
};

function sandbox(stubMainStart = false): Config {
	const home = join(TMP, `home-${Math.random().toString(36).slice(2)}`);
	mkdirSync(join(home, ".config/neurastream"), { recursive: true });
	const bindir = join(home, ".local/bin");
	mkdirSync(bindir, { recursive: true });
	const stubs = stubMainStart ? STUBS : { "queue-check": STUBS["queue-check"]! };
	for (const [name, body] of Object.entries(stubs)) {
		writeFileSync(join(bindir, name), body);
		chmodSync(join(bindir, name), 0o755);
	}
	return loadConfig({ home });
}

const emptySource: RunSource = { listRuns: () => [], mainSession: () => null };

// agentLedger writes its report to stdout; capture it (tests/ledger-not-live.test.ts).
function ledger(args: string[], cfg: Config): { code: number; out: string } {
	let out = "";
	const spy = spyOn(process.stdout, "write").mockImplementation((chunk) => {
		out += String(chunk);
		return true;
	});
	try {
		const code = agentLedger(args, cfg, emptySource);
		return { code, out };
	} finally {
		spy.mockRestore();
	}
}

test("with a recorded zai out-until in the past, agent-ledger --cap prints 'providers: zai free' (I-20261025-164)", () => {
	const cfg = sandbox();
	recordOut(cfg, "zai", nowSec() - 60, "quota-reset");
	const { out } = ledger(["--cap"], cfg);
	expect(out).toContain("providers: zai free");
});

test("the providers line shows each provider free or out until its local HH:MM, configured order first", () => {
	const cfg = sandbox();
	const until = nowSec() + 3600;
	// openrouter is recorded first; the configured provider order (zai first) still leads the line.
	recordOut(cfg, "openrouter", until + 60, "task-result");
	recordOut(cfg, "zai", until, "quota-reset");
	const { out } = ledger(["--cap"], cfg);
	expect(out).toContain(
		`providers: zai out until ${strftime(until, "%H:%M")} · openrouter out until ${strftime(until + 60, "%H:%M")}`,
	);
});

test("main-start prints the providers line", async () => {
	const cfg = sandbox(true);
	recordOut(cfg, "zai", nowSec() - 60, "quota-reset");
	const text = await mainStartText([], cfg, { inheritStdin: false });
	expect(text).toContain("providers: zai free");
});

test("the rollover note request points rate-limit state at agent-ledger --cap", () => {
	expect(noteRequest("/s/n.md")).toContain(
		"Do not state which agents or providers are rate-limited or free; that comes from agent-ledger --cap.",
	);
});
