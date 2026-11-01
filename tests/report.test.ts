// Weekly report self-grading (src/core/report.ts, plan 20261027_1430 P6): silent failures, suspected
// false blocks, per-kind dismiss rates and the noisy-detector rule. All counts are per window.

import { expect, test } from "bun:test";
import type { IncidentView } from "../src/core/incidents.ts";
import { kindStats, m7, noisyDetectors, silentFailures } from "../src/core/report.ts";

const W = { from: 1000, to: 2000 };
const NOISY = { noisy_min: 5, noisy_ratio: 0.5 };

function inc(id: string, kind: string, ts: number, resolution: IncidentView["resolution"] = null, source: IncidentView["source"] = "realtime"): IncidentView {
	return { id, fingerprint: id, source, kind, summary: id, evidence: "", ts, count: 1, lastSeen: ts, resolution, proposal: null };
}

/** `n` incidents of `kind` inside the window, each dismissed with reason "reason <i>". */
function dismissed(n: number, kind: string): IncidentView[] {
	return Array.from({ length: n }, (_, i) => inc(`${kind}${i}`, kind, 1100 + i, { type: "dismiss", id: `${kind}${i}`, why: `reason ${i}` }));
}

/** `n` incidents of `kind` inside the window, still open. */
function open(n: number, kind: string): IncidentView[] {
	return Array.from({ length: n }, (_, i) => inc(`${kind}o${i}`, kind, 1500 + i));
}

test("silent failures count only watch-source incidents opened in the window", () => {
	const incidents = [
		inc("w1", "job-stale", 1100, null, "watch"),
		inc("w2", "unit-failed", 1900, null, "watch"),
		inc("w0", "job-stale", 900, null, "watch"),
		inc("r1", "owner-correction", 1100),
	];
	expect(silentFailures(incidents, W)).toBe(2);
	expect(silentFailures(incidents, { from: 0, to: 1000 })).toBe(1);
});

test("M7 suspected false blocks = D8 incidents in the window + false-alarm events in the window", () => {
	const incidents = [inc("b1", "block-then-bypass", 1100), inc("b2", "block-then-bypass", 1900), inc("b0", "block-then-bypass", 900), inc("x", "owner-correction", 1100)];
	expect(m7(incidents, 2, W)).toBe(4);
	expect(m7(incidents, 0, { from: 0, to: 1000 })).toBe(1);
});

test("per-kind rates count opened, planned and dismissed inside the window only", () => {
	const incidents = [
		inc("a", "owner-correction", 1100, { type: "dismiss", id: "a", why: "not a bug" }),
		inc("b", "owner-correction", 1200, { type: "dismiss", id: "b", why: "fine" }),
		inc("c", "owner-correction", 1300, { type: "plan", id: "c", plan: "p" }),
		inc("d", "owner-correction", 1400),
		inc("old", "owner-correction", 500, { type: "dismiss", id: "old", why: "x" }),
	];
	const [s] = kindStats(incidents, W);
	expect(s).toMatchObject({ kind: "owner-correction", opened: 4, planned: 1, dismissed: 2, dismissRate: 0.5 });
});

test("noisy detector fires at the threshold and stays off below it", () => {
	// 5 opened, 3 dismissed: at noisy_min and at noisy_ratio (0.6 >= 0.5) -> fires
	const on = noisyDetectors([...dismissed(3, "d4"), ...open(2, "d4")], W, NOISY);
	expect(on).toHaveLength(1);
	expect(on[0]!.kind).toBe("noisy-detector");
	expect(on[0]!.summary).toBe("noisy detector: d4 (3/5 dismissed)");

	// 4 opened: below noisy_min -> off, however high the rate
	expect(noisyDetectors([...dismissed(3, "d4"), ...open(1, "d4")], W, NOISY)).toEqual([]);

	// 5 opened, 2 dismissed: rate 0.4 < 0.5 -> off
	expect(noisyDetectors([...dismissed(2, "d4"), ...open(3, "d4")], W, NOISY)).toEqual([]);
});

test("noisy detector evidence carries the 3 latest dismiss reasons", () => {
	const incidents = [
		...Array.from({ length: 4 }, (_, i) => inc(`d${i}`, "d4", 1100 + i * 100, { type: "dismiss", id: `d${i}`, why: `reason ${i}` })),
		inc("open", "d4", 1500),
	];
	const [f] = noisyDetectors(incidents, W, NOISY);
	expect(f!.summary).toBe("noisy detector: d4 (4/5 dismissed)");
	expect(f!.evidence).toContain("reason 3");
	expect(f!.evidence).toContain("reason 2");
	expect(f!.evidence).toContain("reason 1");
	expect(f!.evidence).not.toContain("reason 0");
});
