// omp `complete` (plan 20261109_2335 P7 k). The spawn is always injected: no test runs the real
// `omp auth-gateway stdio`. The fixture is hand-written in the measured shape, not a recording.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { MAIN_ENV, ompComplete } from "../src/adapters/omp/launch.ts";

const FIXTURE = readFileSync(join(import.meta.dir, "fixtures", "recall", "gateway-run.jsonl"), "utf8");
const REQ = { model: "fake/topic-model", system: "SYSTEM TEXT", prompt: "PROMPT TEXT", maxTokens: 1500 };

interface Seen {
	argv: string[];
	cwd: string;
	cwdExisted: boolean;
	cwdEntries: number;
	env: NodeJS.ProcessEnv;
	stdin: string;
}

/** An injected spawn: records the call and answers with the given stdout and exit code. */
function fakeSpawn(stdout: string, exitCode = 0) {
	const seen: Seen[] = [];
	const spawn = async (argv: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; stdin: string }) => {
		const cwdExisted = existsSync(opts.cwd);
		seen.push({
			argv,
			cwd: opts.cwd,
			cwdExisted,
			cwdEntries: cwdExisted ? readdirSync(opts.cwd).length : -1,
			env: opts.env,
			stdin: opts.stdin,
		});
		return { exitCode, stdout, stderr: "" };
	};
	return { spawn, seen };
}

describe("omp complete", () => {
	test("spawns exactly omp auth-gateway stdio in an empty temp cwd, without MAIN_ENV, one stdin line", async () => {
		process.env[MAIN_ENV] = "1";
		try {
			const f = fakeSpawn(FIXTURE);
			await ompComplete(REQ, { spawn: f.spawn });
			expect(f.seen).toHaveLength(1);
			const s = f.seen[0]!;
			expect(s.argv).toEqual(["omp", "auth-gateway", "stdio"]);
			expect(s.cwdExisted).toBe(true);
			expect(s.cwdEntries).toBe(0);
			expect(existsSync(s.cwd)).toBe(false);
			expect(s.env[MAIN_ENV]).toBeUndefined();
			expect(s.stdin.endsWith("\n")).toBe(true);
			expect(s.stdin.slice(0, -1).includes("\n")).toBe(false);
			// Exact body: no `tools` and no `tool_choice` key anywhere.
			expect(JSON.parse(s.stdin)).toEqual({
				id: 1,
				path: "/v1/chat/completions",
				body: {
					model: REQ.model,
					max_tokens: REQ.maxTokens,
					messages: [
						{ role: "system", content: REQ.system },
						{ role: "user", content: REQ.prompt },
					],
				},
			});
		} finally {
			delete process.env[MAIN_ENV];
		}
	});

	test("the synthetic exchange yields the assistant text and usage", async () => {
		const f = fakeSpawn(FIXTURE);
		await expect(ompComplete(REQ, { spawn: f.spawn })).resolves.toMatchObject({
			text: '{"segments":[]}',
			usage: { prompt_tokens: 120, completion_tokens: 40 },
		});
	});

	test.each<[string, string]>([
		[
			"a response with tool_calls",
			FIXTURE.replace(
				'"role":"assistant","content"',
				'"role":"assistant","tool_calls":[{"id":"t1","type":"function","function":{"name":"read","arguments":"{}"}}],"content"',
			),
		],
		["a finish_reason other than stop", FIXTURE.replace('"finish_reason":"stop"', '"finish_reason":"length"')],
		["a status other than 200", FIXTURE.replace('"status":200', '"status":429')],
		["no id 1 line", FIXTURE.split("\n").slice(0, 2).join("\n")],
	])("%s is an error", async (_name, stdout) => {
		await expect(ompComplete(REQ, { spawn: fakeSpawn(stdout).spawn })).rejects.toThrow();
	});

	test("a non-zero exit is an error", async () => {
		await expect(ompComplete(REQ, { spawn: fakeSpawn(FIXTURE, 1).spawn })).rejects.toThrow();
	});
});
