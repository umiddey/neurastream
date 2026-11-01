// queue-trim (plan 20261027_0915 P5e-b): `neurastream queue-trim --help` used to be read as a
// plan file and answered "…/--help is not an indexed plan"; --help/-h must print the usage and
// exit 0, like every other queue command.

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config } from "../src/core/config.ts";
import { queueTrim } from "../src/core/queue-trim.ts";

const TMP = mkdtempSync(join(tmpdir(), "ns-qtrim-help-"));
const cfg: Config = loadConfig({ home: TMP, env: {} });

test("queue-trim --help and -h print the usage and exit 0", () => {
	const logs: string[] = [];
	const orig = console.log;
	console.log = (l: unknown) => logs.push(String(l));
	try {
		expect(queueTrim(["--help"], cfg)).toBe(0);
		expect(queueTrim(["-h"], cfg)).toBe(0);
	} finally {
		console.log = orig;
	}
	expect(logs.filter(l => l.includes("usage: queue-trim")).length).toBe(2);
});

afterAll(() => {
	rmSync(TMP, { recursive: true, force: true });
});
