import { expect, test } from "bun:test";
import { annotateResetTimes } from "../src/core/reset-time.ts";

const rule = { pattern: String.raw`reset at (\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?)\s*(Z|UTC|GMT|[+-]\d{2}:?\d{2}|[A-Z]{2,5}\b)?`, zone: "Asia/Shanghai" };
const input = "Your limit will reset at 2026-10-25 18:56:22";

 test("annotates provider wall clock using configured zone and caller local zone", () => {
	const before = process.env.TZ;
	process.env.TZ = "Europe/Berlin";
	try {
		expect(annotateResetTimes(input, rule)).toBe(`${input} (= 2026-10-25 11:56:22 CET local)`);
	} finally {
		if (before === undefined) delete process.env.TZ;
		else process.env.TZ = before;
	}
});

test("explicit offset overrides the configured zone", () => {
	const text = `${input} +00:00`;
	const before = process.env.TZ;
	process.env.TZ = "Europe/Berlin";
	try {
		expect(annotateResetTimes(text, rule)).toBe(`${text} (= 2026-10-25 19:56:22 CET local)`);
	} finally {
		if (before === undefined) delete process.env.TZ;
		else process.env.TZ = before;
	}
});

test("leaves annotated text unchanged", () => {
	const text = `${input} (= 2026-10-25 11:56:22 CET local)`;
	expect(annotateResetTimes(text, rule)).toBe(text);
});

test("annotates multiple times and leaves text without matches unchanged", () => {
	const before = process.env.TZ;
	process.env.TZ = "Europe/Berlin";
	try {
		const text = `${input}; reset at 2027-07-01 12:00:00`;
		expect(annotateResetTimes(text, rule)).toBe(`${input} (= 2026-10-25 11:56:22 CET local); reset at 2027-07-01 12:00:00 (= 2027-07-01 06:00:00 CEST local)`);
		expect(annotateResetTimes("no reset time", rule)).toBe("no reset time");
	} finally {
		if (before === undefined) delete process.env.TZ;
		else process.env.TZ = before;
	}
});

test("does not guess when an explicit abbreviation cannot be resolved", () => {
	const text = `${input} XYZ`;
	expect(annotateResetTimes(text, rule)).toBe(text);
});
