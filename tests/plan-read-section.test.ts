import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePlan } from "../src/core/queue/lib.ts";

// Plans stamped at or after this get the "## Code read by Main" requirement; older ones are grandfathered.
const CUTOVER = "20261021_0100";
const BLOCKERS = mkdtempSync(join(tmpdir(), "plan-read-section-"));
writeFileSync(join(BLOCKERS, "ok.sh"), "#!/bin/sh\nexit 0\n");
chmodSync(join(BLOCKERS, "ok.sh"), 0o755);

function plan(extra: string): string {
	return `# Plan

## Goal
- Do the thing.

## Forbidden
- Nothing else.

## Blockers
- ok.sh

## Phases
- [ ] P1 the thing; verify: \`true\`

## Done check
\`true\`

${extra}## Progress
Status: open
`;
}

const READ_SECTION = "## Code read by Main\n- `src/a.ts`\n\n";

function errorsFor(file: string, text: string): string[] {
	return parsePlan("/repo", join("/repo/docs/plans", file), text, BLOCKERS).errors ?? [];
}

test("a plan stamped at the cutover without the Code read by Main section is refused", () => {
	const errs = errorsFor(`${CUTOVER}_new.md`, plan(""));
	expect(errs.some(e => /Code read by Main/i.test(e))).toBe(true);
});

test("a plan stamped before the cutover without the section still parses", () => {
	const errs = errorsFor("20261019_0900_old.md", plan(""));
	expect(errs.some(e => /Code read by Main/i.test(e))).toBe(false);
	expect(errs).toEqual([]);
});

test("a plan stamped after the cutover with the section has no section error", () => {
	const errs = errorsFor("20261021_0200_new.md", plan(READ_SECTION));
	expect(errs).toEqual([]);
});
