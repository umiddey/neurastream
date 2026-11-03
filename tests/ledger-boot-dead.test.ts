// A sub session whose transcript was last written before the machine's boot time is dead, not
// RUNNING: the reboot killed it (INCIDENT I-20261103-81). Boot time comes from NEURASTREAM_BOOT
// (pinned here, as NEURASTREAM_NOW is elsewhere), so the rule is deterministic and the test
// never reads the real home.

import { afterAll, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ompRunSource } from "../src/adapters/omp/sessions.ts";
import { agentLedger } from "../src/core/agent-ledger.ts";
import { liveSubagents } from "../src/core/guards.ts";
import { loadConfig } from "../src/core/config.ts";

const TMP = mkdtempSync(join(tmpdir(), "ledger-boot-dead-"));
const queueEnvBefore = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("QUEUE_")));
for (const k of Object.keys(queueEnvBefore)) delete process.env[k];
const savedNow = process.env.NEURASTREAM_NOW;
const savedBoot = process.env.NEURASTREAM_BOOT;

// Both clocks pinned: boot at unix 1700000000, now 1900 s after it. The dead file's mtime is
// 10 minutes before boot (idle 41m), the fresh one's 100 s after boot (idle 30m, the incident's
// tag), so no assertion depends on today's date.
const BOOT = 1700000000;
const NOW = BOOT + 1900;
process.env.NEURASTREAM_NOW = String(NOW);
process.env.NEURASTREAM_BOOT = String(BOOT);

afterAll(() => {
	if (savedNow === undefined) delete process.env.NEURASTREAM_NOW;
	else process.env.NEURASTREAM_NOW = savedNow;
	if (savedBoot === undefined) delete process.env.NEURASTREAM_BOOT;
	else process.env.NEURASTREAM_BOOT = savedBoot;
	for (const k of Object.keys(queueEnvBefore)) delete process.env[k];
	Object.assign(process.env, queueEnvBefore);
	rmSync(TMP, { recursive: true, force: true });
});

const cfg = loadConfig({ home: join(TMP, "home") });

// A sub with a user message and one assistant reply, no session_exit: killed, not exited.
function transcript(): string {
	const user = JSON.stringify({
		type: "message",
		timestamp: "2023-11-14T22:00:00.000Z",
		message: { role: "user", content: [{ type: "text", text: "run the checks" }] },
	});
	const assistant = JSON.stringify({
		type: "message",
		timestamp: "2023-11-14T22:00:30.000Z",
		message: {
			role: "assistant",
			provider: "zai",
			model: "glm-4.5",
			content: [{ type: "text", text: "starting the checks" }],
			stopReason: "toolUse",
			usage: { totalTokens: 1000, cacheRead: 0, cost: { total: 0.1 } },
		},
	});
	return `${user}\n${assistant}\n`;
}

function subRoot(name: string, file: string, mtime: number): string {
	const root = join(TMP, name, "sessions");
	const project = join(root, "-projects");
	mkdirSync(project, { recursive: true });
	writeFileSync(join(project, file), transcript());
	utimesSync(join(project, file), mtime, mtime);
	return root;
}

const DEAD = subRoot("dead", "NsBootDeadSub.jsonl", BOOT - 600);
const FRESH = subRoot("fresh", "NsBootFreshSub.jsonl", BOOT + 100);

// A MAIN session older than boot keeps today's rule: the boot rule skips MAIN rows.
const MAIN_ROOT = (() => {
	const root = join(TMP, "main", "sessions");
	const project = join(root, "-projects");
	mkdirSync(project, { recursive: true });
	const file = join(project, "2023-11-14T22-00-00-000Z_oldmain.jsonl");
	writeFileSync(
		file,
		`${JSON.stringify({
			type: "message",
			timestamp: "2023-11-14T22:00:30.000Z",
			message: {
				role: "assistant",
				provider: "zai",
				model: "glm-4.5",
				content: [{ type: "text", text: "working" }],
				stopReason: "toolUse",
				usage: { totalTokens: 1000, cacheRead: 0, cost: { total: 0.1 } },
			},
		})}\n`,
	);
	utimesSync(file, BOOT - 600, BOOT - 600);
	return root;
})();

// agentLedger writes its report to stdout; capture it (tests/ledger-not-live.test.ts).
function ledger(root: string): string {
	let out = "";
	const spy = spyOn(process.stdout, "write").mockImplementation((chunk) => {
		out += String(chunk);
		return true;
	});
	try {
		expect(agentLedger([], cfg, ompRunSource(root, cfg))).toBe(0);
		return out;
	} finally {
		spy.mockRestore();
	}
}

test("a sub last written before boot is DIED: killed before the last boot and holds no live slot", () => {
	const run = ompRunSource(DEAD, cfg).listRuns(0).find(r => r.id === "NsBootDeadSub");
	expect(run?.status).toBe("died");
	expect(run?.statusDetail).toBe("DIED: killed before the last boot");
	expect(run?.scoreRunning).toBe(false);
	const out = ledger(DEAD);
	expect(out).toContain("DIED: killed before the last boot");
	expect(liveSubagents(out)).toEqual([]);
});

test("the same transcript written after boot stays RUNNING and is counted", () => {
	const run = ompRunSource(FRESH, cfg).listRuns(0).find(r => r.id === "NsBootFreshSub");
	expect(run?.status).toBe("running");
	expect(run?.statusDetail).toBe("RUNNING (idle 30m)");
	expect(run?.scoreRunning).toBe(true);
	expect(liveSubagents(ledger(FRESH))).toEqual(["NsBootFreshSub"]);
});

test("a MAIN session older than boot is not changed", () => {
	const run = ompRunSource(MAIN_ROOT, cfg).listRuns(0).find(r => r.id === "MAIN 22-00-00");
	expect(run?.status).toBe("running");
	expect(run?.statusDetail).toBe("RUNNING (idle 41m)");
	expect(run?.statusDetail).not.toContain("killed before the last boot");
});
