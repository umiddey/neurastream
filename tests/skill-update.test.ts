// P7: `neurastream adapter install omp` records a sha256 per shipped skill file. An update asks
// before it touches a skill whose shipped content changed, says so when the owner edited the file,
// and never overwrites anything on "no" or without a terminal.
import { afterAll, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { installOmp } from "../src/adapters/omp/install.ts";
import { initHome } from "../src/cli/init.ts";

const REPO = dirname(dirname(import.meta.path));
const HOME = "/tmp/neurastream-home-skill-update";
const SKILL = "architecture-drilldown";
const SHIPPED = join(REPO, "templates/skills", SKILL, "SKILL.md");
const LIVE = join(HOME, ".agents/skills", SKILL, "SKILL.md");
const STATE = join(HOME, ".agents/skills/.neurastream-install.json");
const shippedText = readFileSync(SHIPPED, "utf8");

function sha(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function recorded(): Record<string, string> {
	const parsed: unknown = JSON.parse(readFileSync(STATE, "utf8"));
	if (parsed === null || typeof parsed !== "object" || !("files" in parsed)) return {};
	const files = parsed.files;
	if (files === null || typeof files !== "object") return {};
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(files)) if (typeof value === "string") out[key] = value;
	return out;
}

function setRecorded(rel: string, hash: string): void {
	const files = recorded();
	files[`${SKILL}/${rel}`] = hash;
	writeFileSync(STATE, `${JSON.stringify({ files }, null, 2)}\n`);
}

/** A pristine older copy: the live file and its recorded hash agree, the shipped content moved on. */
function older(content: string): void {
	writeFileSync(LIVE, content);
	setRecorded("SKILL.md", sha(content));
}

beforeEach(() => {
	rmSync(HOME, { recursive: true, force: true });
	initHome(HOME, { env: {} });
	installOmp(HOME); // first install copies every shipped skill and records its hashes
});

afterAll(() => {
	rmSync(HOME, { recursive: true, force: true });
});

test("unchanged skill: no prompt, nothing rewritten", () => {
	const asked: string[] = [];
	const result = installOmp(HOME, q => {
		asked.push(q);
		return "y";
	});
	expect(asked).toEqual([]);
	expect(result.skillsKept.length).toBeGreaterThan(0);
	expect(result.skillsPlaced).toEqual([]);
	expect(readFileSync(LIVE, "utf8")).toBe(shippedText);
	expect(recorded()[`${SKILL}/SKILL.md`]).toBe(sha(shippedText));
});

test("changed skill + yes: the shipped files replace the older copy", () => {
	older("older copy\n");
	const asked: string[] = [];
	const result = installOmp(HOME, q => {
		asked.push(q);
		return "y";
	});
	expect(asked.length).toBe(1);
	expect(asked[0]).toContain("architecture-drilldown"); // the CHANGELOG bullet that names it
	expect(asked[0]).toMatch(/^ {2}(Unreleased|\d+\.\d+\.\d+): /m); // with the section it sits under
	expect(asked[0]).toContain("update this skill? [y/N]");
	expect(asked[0]).toContain("- older copy"); // the short diff
	expect(result.skillsPlaced.length).toBe(1);
	expect(readFileSync(LIVE, "utf8")).toBe(shippedText);
	expect(recorded()[`${SKILL}/SKILL.md`]).toBe(sha(shippedText));
});

test("changed skill + no: the file stays byte-identical and the question comes back", () => {
	older("older copy\n");
	const first = installOmp(HOME, () => "n");
	expect(first.skillsSkipped.length).toBe(1);
	expect(readFileSync(LIVE, "utf8")).toBe("older copy\n");
	expect(recorded()[`${SKILL}/SKILL.md`]).toBe(sha("older copy\n")); // not advanced by a no
	const again: string[] = [];
	installOmp(HOME, q => {
		again.push(q);
		return "";
	});
	expect(again.length).toBe(1); // an empty answer is a no, and asks again on the next update
	expect(readFileSync(LIVE, "utf8")).toBe("older copy\n");
});

test("user-edited file: the question says so before it asks", () => {
	older("older copy\n");
	writeFileSync(LIVE, "mine\n");
	const asked: string[] = [];
	installOmp(HOME, q => {
		asked.push(q);
		return "n";
	});
	expect(asked[0]).toContain("you edited SKILL.md — replacing overwrites your version");
	expect(readFileSync(LIVE, "utf8")).toBe("mine\n");
});

test("no terminal: never overwrites, leaves the question for next time", () => {
	older("older copy\n");
	const result = installOmp(HOME, null);
	expect(result.skillsSkipped.length).toBe(1);
	expect(readFileSync(LIVE, "utf8")).toBe("older copy\n");
	expect(recorded()[`${SKILL}/SKILL.md`]).toBe(sha("older copy\n"));
});
