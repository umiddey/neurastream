// Brief-lint's incident rule (plan 20261022_2330 P5): a plan citing INCIDENT <id> must have a
// phase whose text says "fail-before" — its regression test has to fail on the old code. Every
// other rule of lint() must still pass for the positive cases, so the briefs below satisfy the
// full template (method read, acceptance, never push, find note, call budget).

import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { briefLint } from "../src/core/brief-lint.ts";
import { loadConfig, type Config } from "../src/core/config.ts";

const TMP = mkdtempSync(join(tmpdir(), "nsar-brieflint-"));

afterAll(() => {
	rmSync(TMP, { recursive: true, force: true });
});

// The paths rule requires every $HOME/... path a brief names to exist; the briefs below name
// method_read, so the sandbox home carries a stub of it.
mkdirSync(join(TMP, "home/projects"), { recursive: true });
writeFileSync(join(TMP, "home/projects/opus-implementer-method.md"), "method text\n");

const cfg: Config = loadConfig({ home: join(TMP, "home"), env: {} });

function brief(name: string, incidentId: string | null, failBefore: boolean): string {
	const p = join(TMP, name);
	mkdirSync(TMP, { recursive: true });
	writeFileSync(
		p,
		[
			`# ${name.replace(/\.md$/, "")}`,
			"",
			`Read ${cfg.brief.method_read} first.`,
			"",
			"## Goal",
			incidentId ? `Close the loop on ${incidentId}. INCIDENT ${incidentId}` : "Tighten a guard message.",
			"",
			"## Phases",
			incidentId && failBefore
				? `- [x] P1 detector gate, fail-before: the regression test fails on the old code — verify: \`true\``
				: `- [x] P1 detector gate — verify: \`true\``,
			"",
			"## Acceptance",
			"- bun run typecheck && bun test exit 0",
			"",
			"## Forbidden",
			"- never push, never open a PR",
			"",
			"## Notes",
			"`find` is broken: use grep/glob/read. Every test run goes through heavy-run.sh. Stop and report within ~100 tool calls.",
			"",
		].join("\n"),
	);
	return p;
}

test("a plan citing INCIDENT <id> with no fail-before phase is refused", () => {
	const rc = briefLint([brief("20261023_1200_nofailbefore.md", "I-20261023-1", false)], cfg);
	expect(rc).toBe(1);
});

test("the same plan with a fail-before phase passes; a plan without an INCIDENT id needs no fail-before", () => {
	expect(briefLint([brief("20261023_1300_withfailbefore.md", "I-20261023-1", true)], cfg)).toBe(0);
	expect(briefLint([brief("20261023_1400_noincident.md", null, false)], cfg)).toBe(0);
});
