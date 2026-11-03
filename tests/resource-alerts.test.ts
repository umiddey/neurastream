import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A critical-urgency notification stays on screen until dismissed; the temperature alert must
// be a normal one with a timeout so it disappears by itself.
test("the CPU overheating alert is a timed, non-critical notification", () => {
	const dir = mkdtempSync(join(tmpdir(), "ra-"));
	const bin = join(dir, "bin");
	mkdirSync(bin);
	const log = join(dir, "notify.log");
	const stub = (name: string, body: string) => {
		writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
		chmodSync(join(bin, name), 0o755);
	};
	stub("sensors", "printf 'Tctl:\\n  temp1_input: 95.000\\n'");
	stub("notify-send", `printf '%s\\n' "$*" >> "${log}"`);
	const r = Bun.spawnSync(["bash", join(import.meta.dir, "../templates/resource-alerts.sh")], {
		env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ALERT_STATE: join(dir, "state"), THRESH_MEM: "1000", THRESH_IO: "1000" },
	});
	expect(r.exitCode).toBe(0);
	const line = readFileSync(log, "utf8");
	expect(line).toContain("CPU overheating: 95");
	expect(line).not.toContain("critical");
	expect(line).toMatch(/-t \d+/);
});
