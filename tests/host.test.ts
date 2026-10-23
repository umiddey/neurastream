// The main-start preflight must run on a host without /proc/loadavg (macOS): the load line comes
// from os.loadavg() there. Stub bins stand in for machine-guard, agent-ledger, main-health and
// queue-check; the sandbox HOME is removed afterwards.

import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/core/config.ts";
import { mainStartText } from "../src/core/main-start.ts";

const TMP = mkdtempSync(join(tmpdir(), "nsar-host-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

const MG_LINE = "MG_STUB_LINE";

function stubBins(home: string): void {
	const bindir = join(home, ".local/bin");
	mkdirSync(bindir, { recursive: true });
	const stubs: Record<string, string> = {
		"machine-guard": `#!/bin/sh\necho ${MG_LINE}\n`,
		"agent-ledger": "#!/bin/sh\nexit 0\n",
		"main-health": "#!/bin/sh\nexit 0\n",
		"queue-check": "#!/bin/sh\nexit 0\n",
	};
	for (const [name, body] of Object.entries(stubs)) {
		writeFileSync(join(bindir, name), body);
		chmodSync(join(bindir, name), 0o755);
	}
}

test("main-start prints the load line after the machine-guard line, with no /proc/loadavg needed", async () => {
	const home = join(TMP, "home");
	stubBins(home);
	const cfg = loadConfig({ home, env: {} });
	const text = await mainStartText([], cfg, { inheritStdin: false });
	const lines = text.split("\n");
	const at = lines.indexOf(MG_LINE);
	expect(at).toBeGreaterThan(-1);
	// Darwin: three os.loadavg() values. Linux: the /proc/loadavg text, unchanged (five fields).
	const want =
		process.platform === "linux"
			? /^\d+\.\d\d \d+\.\d\d \d+\.\d\d \d+\/\d+ \d+$/
			: /^\d+\.\d\d \d+\.\d\d \d+\.\d\d$/;
	expect(lines[at + 1]).toMatch(want);
});

test("main-start prints one notice line per config notice, near the top", async () => {
	const home = join(TMP, "home-notice");
	stubBins(home);
	mkdirSync(join(home, ".config/neurastream"), { recursive: true });
	const file = join(home, ".config/neurastream/config.yml");
	writeFileSync(file, 'glm:\n  label: "GLM"\npm:\n  fail_lines: 25\n');
	const cfg = loadConfig({ home, env: {} });
	const text = await mainStartText([], cfg, { inheritStdin: false });
	const lines = text.split("\n");
	const glm = `notice: config "glm:" is now "quota:"; rename it in ${file}`;
	const pm = `notice: config "pm:" was removed; delete it from ${file}`;
	expect(lines).toContain(glm);
	expect(lines).toContain(pm);
	const machine = lines.indexOf("=== machine");
	expect(lines.indexOf(glm)).toBeLessThan(machine);
	expect(lines.indexOf(pm)).toBeLessThan(machine);
});
