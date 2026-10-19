// herdr pane reporter parity: with HERDR_ENV=1 the port reports the same socket protocol and
// state machine as the original (session report, working/blocked/idle over the herdr socket,
// duplicate agent_end suppressed during the retry hold); without the env (or in a nested
// OMPCODE=1 session) it registers nothing. The extension runs in a `bun -e` child (deliberate
// runtime-selected import: the env vars must exist before the module loads, exactly as herdr
// installs it), and its own setTimeout transitions are the code under test — so the waits are
// real-clock integration waits with the debounce/grace shortened through the documented env
// overrides; deterministic fake timers cannot reach into the child process.
//
// Child envs are built from scratch (PATH, HOME plus what the case sets), never spread from
// process.env: the caller may itself run inside a herdr session (HERDR_ENV=1, a live
// HERDR_SOCKET_PATH, OMPCODE=1) and the reporter reads its env at import time. The socket
// server answers every request line, like herdr's real endpoint: the reporter resolves a send
// on the first socket data, so without a reply each attempt burns its 500 ms then 1500 ms
// timeout and the short-lived scenario outlives the reporter's request queue.

import { expect, test } from "bun:test";
import { spawn as cpSpawn } from "node:child_process";
import net from "node:net";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";

// The port under test is the checkout these tests ship in (worktree-safe: never a hardcoded path).
const REPO = dirname(dirname(import.meta.path));
const HERDR = join(REPO, "src/adapters/omp/herdr-agent-state.ts");

const REGISTER = `
const h = {};
const events = {};
const mod = await import(${JSON.stringify(HERDR)});
mod.default({ on: (ev, cb) => { h[ev] = cb; }, events: { on: (ev, cb) => { events[ev] = cb; } } });
`;

// From-scratch env for a child that must not see the caller's herdr context.
function baseEnv(): NodeJS.ProcessEnv {
	return { PATH: process.env.PATH, HOME: process.env.HOME };
}

function childEnv(socket: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	return {
		...baseEnv(),
		// The test harness itself runs nested (OMPCODE=1), so the child simulates a root pane.
		OMPCODE: "",
		HERDR_ENV: "1",
		HERDR_SOCKET_PATH: socket,
		HERDR_PANE_ID: "p1",
		HERDR_OMP_IDLE_DEBOUNCE_MS: "50",
		HERDR_OMP_RETRY_GRACE_MS: "100",
		...extra,
	};
}

interface Report {
	id: string;
	method: string;
	params: Record<string, unknown>;
}

// One unix-socket server per scenario; the child's reporter is the only client.
function withSocketServer(run: (socket: string) => Promise<void>): Promise<Report[]> {
	const socket = `/tmp/neurastream-herdr-${process.pid}-${Math.random().toString(36).slice(2)}.sock`;
	rmSync(socket, { force: true });
	const reports: Report[] = [];
	const { promise, resolve, reject } = Promise.withResolvers<Report[]>();
	const server = net.createServer(conn => {
		let buf = "";
		conn.on("data", d => {
			conn.write('{"ok":1}\n'); // ack like herdr: the reporter resolves a send on first data
			buf += String(d);
			let at = buf.indexOf("\n");
			while (at >= 0) {
				const line = buf.slice(0, at).trim();
				buf = buf.slice(at + 1);
				if (line) reports.push(JSON.parse(line) as Report);
				at = buf.indexOf("\n");
			}
		});
	});
	server.on("error", reject);
	server.listen(socket, () => {
		run(socket)
			.then(() =>
				server.close(() => {
					rmSync(socket, { force: true });
					resolve(reports);
				}),
			)
			.catch((err: unknown) =>
				server.close(() => {
					rmSync(socket, { force: true });
					reject(err);
				}),
			);
	});
	return promise;
}

function wait(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

test("herdr reporter: disabled without HERDR_ENV and in a nested OMPCODE=1 session", async () => {
	const keys = (env: NodeJS.ProcessEnv) => {
		const { promise, resolve, reject } = Promise.withResolvers<string[]>();
		const child = cpSpawn("bun", ["-e", `${REGISTER}\nconsole.log(JSON.stringify(Object.keys(h)))`], {
			env,
			cwd: "/tmp",
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		let err = "";
		child.stdout?.on("data", d => (out += String(d)));
		child.stderr?.on("data", d => (err += String(d)));
		child.on("exit", code => (code === 0 ? resolve(JSON.parse(out.trim()) as string[]) : reject(new Error(err))));
		return promise;
	};
	// A bare root shell: no herdr env of its own, and none leaks in from the caller.
	expect(await keys(baseEnv())).toEqual([]);
	// Full herdr env, but nested: the pane's root agent is the parent, not this child.
	expect(await keys(childEnv("/tmp/neurastream-herdr-unused.sock", { OMPCODE: "1" }))).toEqual([]);
});

test("herdr reporter: session, working/blocked/idle transitions and duplicate agent_end over the socket", async () => {
	const reports = await withSocketServer(async socket => {
		const body = `${REGISTER}
const ctx = { hasUI: true, sessionManager: { getSessionFile: () => "/tmp/s/20261019_main.jsonl", getSessionId: () => "s1" } };
const flush = () => new Promise(r => setTimeout(r, 50)); // let the queued state reach the socket
await h["session_start"]({}, ctx); // forced first publish: the reporter opens Idle
await flush();
await h["agent_start"]({}, ctx);
await flush();
await h["tool_approval_requested"]({ reason: "run bun test?" }, ctx);
await flush();
await h["tool_approval_resolved"]({}, ctx); // agent still active: back to working
await flush();
await h["agent_end"]({}, ctx); // settle: idle after the debounce (50 < 120)
await new Promise(r => setTimeout(r, 120));
await h["agent_start"]({}, ctx);
await flush();
await h["agent_end"]({ messages: [{ role: "assistant", stopReason: "error", errorMessage: "429 too many requests" }] }, ctx); // the retry hold keeps it working (dedup: no send)
await new Promise(r => setTimeout(r, 200)); // grace (100) expires: blocked
await h["agent_end"]({ messages: [] }, ctx); // duplicate end during the hold: suppressed
await new Promise(r => setTimeout(r, 150)); // would go idle if the duplicate misbehaved
// The reporter's socket keeps the loop alive (the original lives inside omp's process); end the
// scenario explicitly.
process.exit(0);
`;
		// Async spawn: the socket server lives in this process and needs a free event loop while
		// the child reports.
		const child = cpSpawn("bun", ["-e", body], { env: childEnv(socket), cwd: "/tmp", stdio: ["ignore", "ignore", "pipe"] });
		let err = "";
		child.stderr?.on("data", d => (err += String(d)));
		const done = Promise.withResolvers<void>();
		child.on("exit", code => (code === 0 ? done.resolve() : done.reject(new Error(`herdr child failed: ${err}`))));
		child.on("error", done.reject);
		await done.promise;
		await wait(50); // let the last socket data land
	});
	const states = reports.filter(x => x.method === "pane.report_agent").map(x => x.params.state);
	// Sequence verified against the original extension (herdr integration v10) replaying this
	// exact scenario: session_start's forced publish opens with Idle, and the retry hold's
	// Working deduplicates against the agent_start Working, so no second Working is sent there.
	expect(states).toEqual(["idle", "working", "blocked", "working", "idle", "working", "blocked"]);
	const sessions = reports.filter(x => x.method === "pane.report_agent_session");
	expect(sessions).toHaveLength(3); // startup + the two agent_start reports
	expect(sessions[0]?.params).toMatchObject({
		pane_id: "p1",
		source: "herdr:omp",
		agent: "omp",
		agent_session_path: "/tmp/s/20261019_main.jsonl",
		session_start_source: "startup",
	});
	expect(
		reports
			.filter(x => x.method === "pane.report_agent" && x.params.state === "blocked")
			.map(x => x.params.message),
	).toEqual(["run bun test?", "429 too many requests"]);
	// every report carries a strictly increasing seq
	const seqs = reports.map(x => x.params.seq as number);
	expect(seqs.every((s, i) => i === 0 || s > (seqs[i - 1] as number))).toBe(true);
});
