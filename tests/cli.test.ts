import { expect, test } from "bun:test";
import { helpText, run } from "../src/cli/dispatch.ts";
import { helpDoc } from "../src/core/help.ts";

test("help exits 0 and names the config command", async () => {
	expect(helpText()).toContain("neurastream config");
	expect(await run("help", [])).toBe(0);
	expect(await run("nope", [])).toBe(2);
});

test("watch --help prints the watch doc and exits 0", async () => {
	// Red half: ENOENT before templates/help/watch.txt exists. The doc must cover
	// what the plan's P7 names: watch on|off, heartbeat --fail, the noisy-detector rule.
	const doc = helpDoc("watch");
	expect(doc).toContain("watch on|off");
	expect(doc).toContain("heartbeat");
	expect(doc).toContain("noisy detector");
	const seen: string[] = [];
	const orig = console.log;
	console.log = (line: unknown) => {
		seen.push(String(line));
	};
	try {
		expect(await run("watch", ["--help"])).toBe(0);
		expect(await run("watch", ["-h"])).toBe(0);
	} finally {
		console.log = orig;
	}
	const out = seen.join("\n");
	expect(out).toContain("watch on|off");
	expect(out).toContain("neurastream heartbeat");
});
