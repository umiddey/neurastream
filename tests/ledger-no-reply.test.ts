// P17: a sub-run that died before its first reply is not "?" and not RUNNING.
// Model comes from the parent task call's agent frontmatter. Older than
// ledger.idle_show_min with no assistant message → DIED: never replied.

import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ompRunSource } from "../src/adapters/omp/sessions.ts";
import { loadConfig } from "../src/core/config.ts";

const TMP = mkdtempSync(join(tmpdir(), "ledger-no-reply-"));
const queueEnvBefore = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("QUEUE_")));
for (const k of Object.keys(queueEnvBefore)) delete process.env[k];
afterAll(() => {
	for (const k of Object.keys(queueEnvBefore)) delete process.env[k];
	Object.assign(process.env, queueEnvBefore);
	rmSync(TMP, { recursive: true, force: true });
});

const cfg = loadConfig({ home: join(TMP, "home") });
const SESSIONS = join(TMP, "sessions");
const PARENT = join(SESSIONS, "-projects", "2026-10-24T23-00-41-557Z_parent.jsonl");
const SUB = join(SESSIONS, "-projects", "2026-10-24T23-00-41-557Z_01a17025-17d5-70f5-90ab-6e3c4ae3b44f", "NsUnlockNoticeSol.jsonl");
const FRESH = join(SESSIONS, "-projects", "2026-10-24T23-00-41-557Z_01a17025-17d5-70f5-90ab-6e3c4ae3b44f", "NsUnlockNoticeFresh.jsonl");

mkdirSync(join(SESSIONS, "-projects", "2026-10-24T23-00-41-557Z_01a17025-17d5-70f5-90ab-6e3c4ae3b44f"), { recursive: true });
mkdirSync(join(TMP, "agents"), { recursive: true });
writeFileSync(
	join(TMP, "agents", "sol.md"),
	"---\nname: sol\nmodel: openai-codex/gpt-6.1-sol\nthinking: high\n---\n\nworker\n",
);
writeFileSync(
	PARENT,
	`${JSON.stringify({
		type: "message",
		timestamp: "2026-10-24T23:13:00.000Z",
		message: {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "t1",
					name: "task",
					arguments: {
						tasks: [
							{ name: "NsUnlockNoticeSol", agent: "sol", task: "cut" },
							{ name: "NsUnlockNoticeFresh", agent: "sol", task: "cut" },
						],
					},
				},
			],
		},
	})}\n`,
);

// Four lines, system prompt cut: title, session, thinking_level_change, session_init.
function transcript(): string {
	const lines = [
		{ type: "title", v: 1, title: "", updatedAt: "2026-10-24T23:13:30.745Z" },
		{ type: "session", version: 1, id: "01a17030", timestamp: "2026-10-24T23:13:30.745Z", cwd: "/tmp", parentSession: PARENT },
		{ type: "thinking_level_change", id: "31583e47", parentId: null, timestamp: "2026-10-24T23:13:31.673Z", thinkingLevel: "medium" },
		{ type: "session_init", id: "b029546a", parentId: "31583e47", timestamp: "2026-10-24T23:13:31.703Z", agent: "other", systemPrompt: [], task: "cut" },
	];
	return lines.map(l => JSON.stringify(l)).join("\n") + "\n";
}
writeFileSync(SUB, transcript());
writeFileSync(FRESH, transcript());
const old = Date.now() / 1000 - (cfg.ledger.idle_show_min + 2) * 60;
utimesSync(SUB, old, old);
const fresh = Date.now() / 1000 - 60;
utimesSync(FRESH, fresh, fresh);

test("a sub-run with no reply takes its model from the parent agent file and is DIED when older than idle_show_min", () => {
	const run = ompRunSource(SESSIONS, cfg).listRuns(0).find(r => r.id === "NsUnlockNoticeSol");
	expect(run?.model).toBe("openai-codex/gpt-6.1-sol");
	expect(run?.scoreModel).toBe("openai-codex/gpt-6.1-sol");
	expect(run?.status).toBe("died");
	expect(run?.statusDetail).toBe("DIED: never replied");
	expect(run?.scoreRunning).toBe(false);
	expect(run?.scoreSurvived).toBe(false);
	expect(run?.model).not.toBe("?");
});

test("the same transcript one minute old is still running", () => {
	const run = ompRunSource(SESSIONS, cfg).listRuns(0).find(r => r.id === "NsUnlockNoticeFresh");
	expect(run?.status).toBe("running");
	expect(run?.model).toBe("openai-codex/gpt-6.1-sol");
	expect(run?.model).not.toBe("?");
});
