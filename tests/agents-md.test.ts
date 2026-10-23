// The managed AGENTS.md block: rendered from templates/AGENTS.md with the config's agent dir,
// upserted between two markers so every byte outside them stays the owner's.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BEGIN_MARK, END_MARK, blockState, renderBlock, upsertBlock } from "../src/core/agents-md.ts";
import { loadConfig } from "../src/core/config.ts";

const REPO = join(import.meta.dir, "..");
const HOME = "/tmp/neurastream-home-agentsmd";
const cfg = loadConfig({ home: HOME, env: {} });
const block = renderBlock(cfg);
const PERSONAL = "# my notes\n\nBe kind.\n\n- Pipelines on our local computer: one combined merge request at a time\n";

test("renderBlock fills in the agent dir and wraps the rules in the markers", () => {
	expect(block.startsWith(`${BEGIN_MARK}\n`)).toBe(true);
	expect(block.endsWith(`\n${END_MARK}`)).toBe(true);
	expect(block).toContain(`${HOME}/.config/neurastream/INDEX.md`);
	expect(block).not.toContain("{{AGENT_DIR}}");
});

test("upsertBlock appends to a file without markers and keeps the personal text byte-identical", () => {
	expect(upsertBlock(PERSONAL, block)).toBe(`${PERSONAL}\n${block}\n`);
	expect(upsertBlock("", block)).toBe(`${block}\n`);
});

test("upsertBlock replaces an old block in place and keeps the text above and below it", () => {
	const file = `${PERSONAL}\n${BEGIN_MARK}\nold rules\n${END_MARK}\nmy footer\n`;
	expect(upsertBlock(file, block)).toBe(`${PERSONAL}\n${block}\nmy footer\n`);
});

test("upsertBlock is idempotent: a second run gives the same bytes", () => {
	const once = upsertBlock(PERSONAL, block);
	expect(upsertBlock(once, block)).toBe(once);
});

test("upsertBlock throws on a begin marker without an end, and on two begin markers", () => {
	expect(() => upsertBlock(`${BEGIN_MARK}\nx\n`, block)).toThrow();
	expect(() => upsertBlock(`${BEGIN_MARK}\n${END_MARK}\n${BEGIN_MARK}\n${END_MARK}\n`, block)).toThrow();
});

test("blockState: missing without markers, ok for the rendered block, stale after an edit inside it, ok after an edit outside", () => {
	expect(blockState(PERSONAL, block)).toBe("missing");
	const installed = upsertBlock(PERSONAL, block);
	expect(blockState(installed, block)).toBe("ok");
	expect(blockState(installed.replace("Be kind.", "Be kind, always."), block)).toBe("ok");
	expect(blockState(installed.replace("You are Main", "You are Bob"), block)).toBe("stale");
	expect(blockState(`${BEGIN_MARK}\nno end\n`, block)).toBe("stale");
});

test("the template holds only the neurastream rules: no owner-personal, provider, project or edit-limit text", () => {
	const tpl = readFileSync(join(REPO, "templates/AGENTS.md"), "utf8");
	for (const word of [
		"better person",
		"dumb",
		"one combined merge request",
		"GLM",
		"Grok",
		"Gateforge",
		"/home/ukd",
		"5 times",
		"15-minute",
		"Script changes go to neurastream",
		"pm-fail-facts",
		"glm-reset",
	]) {
		expect(tpl).not.toContain(word);
	}
	expect(/\b(PM|CP)\b/.test(tpl)).toBe(false);
	expect(tpl).toContain("{{AGENT_DIR}}/INDEX.md");
});
