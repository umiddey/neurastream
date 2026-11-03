import { expect, test } from "bun:test";
import { limitProbeSpawn } from "../src/adapters/omp/index.ts";
import { MAIN_ENV } from "../src/adapters/omp/launch.ts";

test("limit probe never starts a harness session", () => {
	const p = limitProbeSpawn({ [MAIN_ENV]: "1", PATH: "/usr/bin" });
	expect(p.args).toContain("bun");
	expect(p.args).not.toContain(process.execPath);
	expect(p.args.at(-1)).toMatch(/cli\/limit-probe\.ts$/);
	expect(p.env[MAIN_ENV]).toBeUndefined();
	expect(p.env.PATH).toBe("/usr/bin");
});
