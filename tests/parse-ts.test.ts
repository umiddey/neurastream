import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const sessions = fileURLToPath(new URL("../src/adapters/omp/sessions.ts", import.meta.url));
const child = String.raw`
import { parseTs } from ${JSON.stringify(sessions)};
const out = {
  summer: parseTs("2026-07-15T10:00:00.000Z"),
  winter: parseTs("2026-01-15T10:00:00Z"),
  offset: parseTs("2026-07-15T12:00:00+02:00"),
  local: parseTs("2026-07-15T10:00:00"),
  expectedLocal: new Date(2026, 6, 15, 10, 0, 0).getTime() / 1000,
  garbage: parseTs("garbage"),
};
console.log(JSON.stringify(out));
`;

for (const TZ of ["Europe/Berlin", "UTC"]) {
	test(`parseTs honors timezone semantics under ${TZ}`, () => {
		const result = spawnSync("bun", ["-e", child], {
			encoding: "utf8",
			env: { ...process.env, TZ },
		});
		expect(result.status).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual({
			summer: 1784109600,
			winter: 1768471200,
			offset: 1784109600,
			local: expect.any(Number),
			expectedLocal: expect.any(Number),
			garbage: null,
		});
		const parsed = JSON.parse(result.stdout) as { local: number; expectedLocal: number };
		expect(parsed.local).toBe(parsed.expectedLocal);
	});
}
