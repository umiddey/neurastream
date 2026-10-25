// INCIDENT I-20261025-98: the adapter overlay must extend guards.protected in every shape a
// config can hold it, and never write list items without their `protected:` key.
import { afterAll, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installOmp, writeOverlay } from "../src/adapters/omp/install.ts";
import { initHome } from "../src/cli/init.ts";
import { loadConfig } from "../src/core/config.ts";

const HOME = "/tmp/neurastream-home-overlay";
const CFG = join(HOME, ".config/neurastream/config.yml");
const ADAPTER = [".omp/agent/agents/", ".omp/agent/extensions/", ".omp/plugins/"].map(p => join(HOME, p));
// init writes guards.protected as a block list right above ledger_command.
const BLOCK = /^ {2}protected:\n(?: {4}- .*\n)*/m;
let initText = "";
let initItems: string[] = [];

beforeEach(() => {
	rmSync(HOME, { recursive: true, force: true });
	initHome(HOME, { env: {} });
	initText = readFileSync(CFG, "utf8");
	expect(initText).toMatch(BLOCK);
	initItems = loadConfig({ home: HOME, env: {} }).guards.protected;
	expect(initItems.length).toBeGreaterThan(0);
});

afterAll(() => {
	rmSync(HOME, { recursive: true, force: true });
});

function overlaid(text: string): { protectedPaths: string[]; ledger: string; text: string } {
	writeFileSync(CFG, text);
	expect(writeOverlay(CFG)).toBe("written");
	const cfg = loadConfig({ home: HOME, env: {} });
	return { protectedPaths: cfg.guards.protected, ledger: cfg.guards.ledger_command, text: readFileSync(CFG, "utf8") };
}

test("a guards section without a protected key gets the key and the adapter paths", () => {
	const r = overlaid(initText.replace(BLOCK, ""));
	expect(r.protectedPaths).toEqual(ADAPTER);
	expect(r.ledger).toBe("agent-ledger --hours 12");
	expect(r.text.match(/^ {2}protected:/gm)?.length).toBe(1);
});

test("a block list keeps its items and gains the missing adapter paths", () => {
	const r = overlaid(initText);
	expect([...r.protectedPaths].sort()).toEqual([...initItems, ...ADAPTER].sort());
	expect(r.ledger).toBe("agent-ledger --hours 12");
});

test("an empty list becomes the three adapter paths, and a second run changes nothing", () => {
	const r = overlaid(initText.replace(BLOCK, "  protected: []\n"));
	expect(r.protectedPaths).toEqual(ADAPTER);
	expect(writeOverlay(CFG)).toBe("unchanged");
	expect(readFileSync(CFG, "utf8")).toBe(r.text);
});

test("a flow list with items is refused instead of getting a second protected key", () => {
	writeFileSync(CFG, initText.replace(BLOCK, '  protected: ["~/owner/keep/"]\n'));
	expect(() => writeOverlay(CFG)).toThrow(/protected/);
	expect(readFileSync(CFG, "utf8").match(/^ {2}protected:/gm)?.length).toBe(1);
});

test("installOmp copies the shipped skills once, then keeps an owner-edited skill", () => {
	const dir = join(HOME, ".agents/skills/architecture-drilldown");
	const first = installOmp(HOME);
	expect(first.skillsCopied).toContain(dir);
	expect(existsSync(join(dir, "SKILL.md"))).toBe(true);
	expect(existsSync(join(dir, "template.html"))).toBe(true);
	writeFileSync(join(dir, "SKILL.md"), "owner edit\n");
	const second = installOmp(HOME);
	expect(second.skillsKept).toContain(dir);
	expect(second.skillsCopied).toEqual([]);
	expect(readFileSync(join(dir, "SKILL.md"), "utf8")).toBe("owner edit\n");
}, 60_000);
