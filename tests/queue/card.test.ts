// P16: a queue card carries a Summary line and a phase status chip.
// parsePlan reads Summary / phases / started; queueRows turns that into the chip.
// A plan with no Summary still passes queue-check (old plans keep passing).

import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config } from "../../src/core/config.ts";
import { queueRows, renderPage, type PageData, type QueueRow } from "../../src/core/owner-ui.ts";
import { parsePlan } from "../../src/core/queue/lib.ts";

const TMP = mkdtempSync(join(tmpdir(), "queue-card-"));
const queueEnvBefore = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("QUEUE_")));
for (const k of Object.keys(queueEnvBefore)) delete process.env[k];
afterAll(() => {
	for (const k of Object.keys(queueEnvBefore)) delete process.env[k];
	Object.assign(process.env, queueEnvBefore);
	rmSync(TMP, { recursive: true, force: true });
});

const base = loadConfig({ home: join(TMP, "home") });
const PLANS = join(TMP, "plans");
mkdirSync(PLANS, { recursive: true });
const INDEX = join(TMP, "INDEX.md");
const CFG: Config = { ...base, paths: { ...base.paths, queue_index: INDEX } };

function body(header: string, phases: string, progress: string, goal = "- Owner (2026-10-25): ship the card"): string {
	return `# Card

${header}Worktree: -
Branch: feat/card

## Goal
${goal}

## Forbidden
- none

## Blockers
- no-push

## Phases
${phases}
## Done check
\`true\`

## Progress
${progress}`;
}

test("parsePlan reads Summary, phase counts and started; a missing Summary is not an error", () => {
	const withSum = parsePlan("/repo", "/repo/docs/plans/a.md", body("Summary: a beautiful line\n", "- [x] P1 a — verify: `true`\n- [ ] P2 b — verify: `true`\n", "Status: open\n"));
	expect(withSum.summary).toBe("a beautiful line");
	expect(withSum.phases).toEqual({ done: 1, total: 2 });
	expect(withSum.started).toBe(true);

	const none = parsePlan("/repo", "/repo/docs/plans/b.md", body("", "- [ ] P1 a — verify: `true`\n", "Status: open\n"));
	expect(none.summary).toBeNull();
	expect(none.phases).toEqual({ done: 0, total: 1 });
	expect(none.started).toBe(false);
	expect(none.errors.some(e => /summary/i.test(e))).toBe(false);

	const fromProgress = parsePlan("/repo", "/repo/docs/plans/c.md", body("", "- [ ] P1 a — verify: `true`\n", "Status: open\n- did a thing\n"));
	expect(fromProgress.started).toBe(true);

	const pointer = parsePlan(
		"/repo",
		"/repo/docs/plans/d.md",
		body("", "- [ ] P1 a — verify: `true`\n", "Status: open\n- Older Progress entries: archive/x.md\nWAITING on owner: hi\n"),
	);
	expect(pointer.started).toBe(false);

	const ticked = parsePlan("/repo", "/repo/docs/plans/e.md", body("", "- [X] P1 a — verify: `true`\n", "Status: open\n"));
	expect(ticked.phases).toEqual({ done: 1, total: 1 });
});

const WAIT = join(PLANS, "wait.md");
const FALL = join(PLANS, "fall.md");
const ZERO = join(PLANS, "zero.md");
const MID = join(PLANS, "mid.md");
const DONE = join(PLANS, "done.md");
const DEP = join(PLANS, "dep.md");
const TARGET = join(PLANS, "target.md");

writeFileSync(WAIT, body("Summary: waiting summary\n", "- [x] P1 a — verify: `true`\n- [ ] P2 b — verify: `true`\n", "Status: open\nWAITING on owner: decide\n"));
writeFileSync(FALL, body("", "- [ ] P1 a — verify: `true`\n", "Status: open\n", "- Owner (2026-10-25 18:06): the fallback line\n- INCIDENT I-1 leftover"));
writeFileSync(ZERO, body("Summary: not yet\n", Array.from({ length: 5 }, (_, i) => `- [ ] P${i + 1} x — verify: \`true\``).join("\n") + "\n", "Status: open\n"));
writeFileSync(MID, body("Summary: in flight\n", "- [x] P1 a — verify: `true`\n- [x] P2 b — verify: `true`\n- [ ] P3 c — verify: `true`\n- [ ] P4 d — verify: `true`\n- [ ] P5 e — verify: `true`\n", "Status: open\n"));
writeFileSync(DONE, body("Summary: checking\n", Array.from({ length: 5 }, (_, i) => `- [x] P${i + 1} x — verify: \`true\``).join("\n") + "\n", "Status: open\n"));
writeFileSync(TARGET, body("Summary: the other plan\n", "- [ ] P1 a — verify: `true`\n", "Status: open\n").replace("# Card", "# Target plan"));
writeFileSync(DEP, body("", "- [x] P1 a — verify: `true`\n- [ ] P2 b — verify: `true`\n", `Status: open\nWaits on: ${TARGET}\n`, "- INCIDENT I-20261025-200. the incident line"));
writeFileSync(INDEX, [WAIT, FALL, ZERO, MID, DONE, DEP, TARGET].join("\n") + "\n");

test("queueRows: Summary, goal fallback, and the status chip (WAITING wins over phase)", () => {
	const rows = queueRows(CFG);
	const by = Object.fromEntries(rows.map(r => [r.file, r]));
	expect(by[WAIT]).toMatchObject({ summary: "waiting summary", state: "waits you" });
	expect(by[FALL]).toMatchObject({ summary: "the fallback line", state: "not started · 0/1" });
	expect(by[ZERO]).toMatchObject({ summary: "not yet", state: "not started · 0/5" });
	expect(by[MID]).toMatchObject({ state: "phase 3 of 5" });
	expect(by[DONE]).toMatchObject({ state: "all 5 done · checking" });
	expect(by[DEP]).toMatchObject({ summary: "the incident line", state: "waits on Target plan" });
});

test("queue card HTML clamps the summary to two lines and keeps the drag controls", () => {
	const rows: QueueRow[] = [
		{ repo: "toy", file: "/plans/a.md", title: "Alpha", status: "open", waiting: false, summary: "one beautiful line", state: "phase 3 of 5", holder: null },
	];
	const data: PageData = {
		questions: [],
		agents: [],
		queue: rows,
		ci: [],
		incidents: [],
		scores: { header: [], rows: [], text: [] },
		machine: null,
		knowledge: null,
		stats: null,
	pages: null,
		messages: [],
		lockMinutesLeft: null,
	};
	const html = renderPage(CFG, data, new URLSearchParams("tab=queue"), "n");
	expect(html).toContain('class="qsum"');
	expect(html).toContain("one beautiful line");
	expect(html).toContain("phase 3 of 5");
	expect(html).toContain("-webkit-line-clamp:2");
	expect(html).toContain('data-plan="/plans/a.md"');
	expect(html).toContain('class="qhandle"');
	expect(html).toContain('class="qrank"');
	expect(html).toContain('data-move="top"');
	expect(html).toContain('data-move="up"');
	expect(html).toContain('data-move="down"');
});
