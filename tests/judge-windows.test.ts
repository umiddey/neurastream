// P5a golden pair (plan 20261110_1746): judgeWindows computes the verdict and the post from two
// windows with no side effect; releaseVerdicts (judgeRelease) runs the same judgment and opens an
// incident only on WORSE. Both doors must agree on verdict and post.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config } from "../src/core/config.ts";
import type { Run, RunSource } from "../src/core/adapter.ts";
import { openIncidents } from "../src/core/incidents.ts";
import { appendMetric } from "../src/core/metrics.ts";
import type { ReleaseTag } from "../src/core/results.ts";
import { judgeWindows, releaseVerdicts } from "../src/core/watch.ts";

const DIRS: string[] = [];
afterAll(() => { for (const d of DIRS) rmSync(d, { recursive: true, force: true }); });

function tempCfg(label: string): Config {
	const dir = mkdtempSync(join(tmpdir(), `judge-${label}-`));
	DIRS.push(dir);
	return loadConfig({ home: dir, env: {} });
}

// The tag v1.0.0 at VT, the next tag two hours on: its windows are the two hours either side.
const VT = 2_000_000;
const VTAGS: ReleaseTag[] = [{ name: "v1.0.0", ts: VT }, { name: "v1.1.0", ts: VT + 7200 }];
const VNOW = VT + 7260;
const BEFORE = { from: VT - 7200, to: VT };
const AFTER = { from: VT, to: VT + 7200 };

let runNo = 0;
function mainRun(calls: number, at: number, texts: [string, string][] = []): Run {
	runNo++;
	return {
		id: `jw${runNo}`, kind: "main", model: "test", calls, tokens: 0, cacheRead: 0, cost: 0,
		inputTokens: 0, prefillTokens: 0, status: "done", statusDetail: "", startedAt: null,
		lastWriteAt: at, endedAt: null,
		messages: texts.map(([role, text]) => ({ role, cost: 0, text, ts: null })),
		scoreModel: "", scoreCost: 0, scoreHours: 0, scoreRunning: false, scoreSurvived: false, scoreEnd: "",
	};
}
const source = (runs: Run[]): RunSource => ({ listRuns: () => runs, mainSession: () => null });
const questions = (n: number): [string, string][] => Array.from({ length: n }, () => ["assistant", "shall I proceed?"] as [string, string]);

/** The windowed door: verdict and post for the two windows, nothing written. */
function viaWindows(cfg: Config, runs: Run[]): { verdict: string; post: string | null } | null {
	const r = judgeWindows(cfg, "v1.0.0", BEFORE, AFTER, { source: source(runs) });
	return r === null ? null : { verdict: r.verdict, post: r.post };
}

/** The release door: the same judgment through the tag list, with its side effects. */
function viaReleaseVerdicts(cfg: Config, runs: Run[]): { verdict: string; post: string | null } | null {
	const posts: string[] = [];
	const out = releaseVerdicts(cfg, { now: VNOW, tags: VTAGS, source: source(runs), notify: t => posts.push(t) });
	const first = out[0];
	return first === undefined ? null : { verdict: first.verdict, post: posts[0] ?? null };
}

test("golden pair: a downgrade reads WORSE the same through both doors; only the release door opens the incident", () => {
	const cfg = tempCfg("downgrade");
	appendMetric(cfg, { type: "version-change", from: "1.0.1", to: "1.0.0", ts: VT + 3600 });
	const runs = [mainRun(400, VT - 3600), mainRun(400, VT + 3600)];
	const direct = viaWindows(cfg, runs);
	expect(direct?.verdict).toBe("WORSE");
	expect(direct?.post).toContain("v1.0.0: WORSE");
	expect(openIncidents(cfg)).toHaveLength(0);
	expect(viaReleaseVerdicts(cfg, runs)).toEqual(direct);
	const open = openIncidents(cfg);
	expect(open).toHaveLength(1);
	expect(open[0]!.kind).toBe("release-regression");
	expect(open[0]!.fingerprint).toBe("release:v1.0.0:downgrade");
});

test("golden pair: thin before-side reads MIXED through both doors; no incident from either", () => {
	const cfg = tempCfg("thin");
	const runs = [mainRun(400, VT - 3600, questions(2)), mainRun(400, VT + 3600, questions(6))];
	const direct = viaWindows(cfg, runs);
	expect(direct?.verdict).toBe("MIXED");
	expect(direct?.post).toContain("questions thin, not compared");
	expect(viaReleaseVerdicts(cfg, runs)).toEqual(direct);
	expect(openIncidents(cfg)).toHaveLength(0);
});
