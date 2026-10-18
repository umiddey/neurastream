import { expect, test } from "bun:test";
import { helpText, run } from "../src/cli/dispatch.ts";

test("help exits 0 and names the config command", async () => {
	expect(helpText()).toContain("neurastream config");
	expect(await run("help", [])).toBe(0);
	expect(await run("nope", [])).toBe(2);
});
