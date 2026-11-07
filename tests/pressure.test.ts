import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Config, loadConfig } from "../src/core/config.ts";
import { heavyHolder, parsePsi, type PressureLevel, type PressureSample, type PressureState, pressureLevel, pressureMessage, pressureTransition, readPressure } from "../src/core/pressure.ts";

const home = "/tmp/neurastream-home-pressure";
const cfg: Config = loadConfig({ file: `${home}/missing.yml`, home, env: {} });

const cleanup: string[] = [];
afterAll(() => {
	for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
});

// Real-shaped /proc/pressure text (the kernel prints these exact keys).
const PSI_MEM = "some avg10=34.12 avg60=20.00 avg300=5.00 total=123456\nfull avg10=5.50 avg60=2.00 avg300=1.00 total=65432\n";
const PSI_CPU = "some avg10=71.02 avg60=50.00 avg300=30.00 total=987654\n";
const PSI_IO = "some avg10=1.00 avg60=0.50 avg300=0.20 total=1000\nfull avg10=0.40 avg60=0.10 avg300=0.05 total=500\n";

const calm: PressureSample = { memSome: 1, memFull: 0.2, cpuSome: 8, ioFull: 0, availMb: 10035, swapFreeMb: 2048 };
const NOTHING: PressureSample = { memSome: null, memFull: null, cpuSome: null, ioFull: null, availMb: null, swapFreeMb: null };

// Feeds a timeline of [nowSec, level] through pressureTransition and returns the [nowSec, fire] pairs that fired.
function run(timeline: [number, PressureLevel][]): [number, string][] {
	let state: PressureState | null = null;
	const fired: [number, string][] = [];
	for (const [t, level] of timeline) {
		const r = pressureTransition(state, level, t, cfg);
		state = r.state;
		if (r.fire) fired.push([t, r.fire]);
	}
	return fired;
}

describe("parsePsi", () => {
	test("reads avg10 from the some and full lines", () => {
		expect(parsePsi(PSI_MEM)).toEqual({ someAvg10: 34.12, fullAvg10: 5.5 });
		expect(parsePsi(PSI_CPU)).toEqual({ someAvg10: 71.02, fullAvg10: null });
	});

	test("empty or unrecognised text gives nulls, never a throw", () => {
		expect(parsePsi("")).toEqual({ someAvg10: null, fullAvg10: null });
		expect(parsePsi("nonsense")).toEqual({ someAvg10: null, fullAvg10: null });
	});
});

describe("readPressure", () => {
	test("reads the PSI files and meminfo under a root dir", () => {
		const root = mkdtempSync(join(tmpdir(), "neurastream-pressure-"));
		cleanup.push(root);
		mkdirSync(join(root, "proc/pressure"), { recursive: true });
		writeFileSync(join(root, "proc/pressure/memory"), PSI_MEM);
		writeFileSync(join(root, "proc/pressure/cpu"), PSI_CPU);
		writeFileSync(join(root, "proc/pressure/io"), PSI_IO);
		writeFileSync(join(root, "proc/meminfo"), "MemTotal: 16000000 kB\nMemAvailable: 1258291 kB\nSwapTotal: 2097152 kB\nSwapFree: 1048576 kB\n");
		const s = readPressure(root);
		expect(s.memSome).toBe(34.12);
		expect(s.memFull).toBe(5.5);
		expect(s.cpuSome).toBe(71.02);
		expect(s.ioFull).toBe(0.4);
		expect(s.availMb).toBeCloseTo(1228.8, 1);
		expect(s.swapFreeMb).toBe(1024);
	});

	test("a root with no PSI and no meminfo (macOS) reports nulls, never throws", () => {
		const root = mkdtempSync(join(tmpdir(), "neurastream-pressure-"));
		cleanup.push(root);
		expect(readPressure(root)).toEqual(NOTHING);
	});
});

describe("pressureLevel", () => {
	test("a calm machine is green", () => {
		expect(pressureLevel(calm, cfg)).toBe("green");
	});

	test("each red threshold alone trips red", () => {
		expect(pressureLevel({ ...calm, memSome: 20 }, cfg)).toBe("red");
		expect(pressureLevel({ ...calm, memFull: 5 }, cfg)).toBe("red");
		expect(pressureLevel({ ...calm, cpuSome: 60 }, cfg)).toBe("red");
		expect(pressureLevel({ ...calm, availMb: 3071 }, cfg)).toBe("red");
	});

	test("between green and red is amber", () => {
		expect(pressureLevel({ ...calm, memSome: 12 }, cfg)).toBe("amber"); // above half of 20
		expect(pressureLevel({ ...calm, availMb: 4000 }, cfg)).toBe("amber"); // below 1.5 x 3072
	});

	test("no readings at all (macOS) is amber: nothing to act on", () => {
		expect(pressureLevel(NOTHING, cfg)).toBe("amber");
	});
});

describe("pressureTransition", () => {
	test("RED fires once, after red_after_sec, not before", () => {
		expect(run([[0, "red"], [10, "red"], [20, "red"], [30, "red"], [40, "red"]])).toEqual([[30, "red"]]);
	});

	test("red, amber, red does not re-fire within repeat_sec", () => {
		// RED at 30; amber at 40; red again from 50 waits out red_after, but repeat_sec (600) runs from 30.
		expect(run([[0, "red"], [30, "red"], [40, "amber"], [50, "red"], [200, "red"], [700, "red"]])).toEqual([
			[30, "red"],
			[700, "red"],
		]);
	});

	test("GREEN needs a prior RED, then green_after_sec of calm, and fires once", () => {
		expect(run([[0, "green"], [200, "green"]])).toEqual([]);
		expect(run([[0, "red"], [30, "red"], [40, "green"], [159, "green"], [160, "green"], [161, "green"], [300, "green"]])).toEqual([
			[30, "red"],
			[160, "green"],
		]);
	});

	test("amber sends nothing and restarts the green clock", () => {
		expect(run([[0, "amber"], [600, "amber"]])).toEqual([]);
		expect(run([[0, "red"], [30, "red"], [40, "green"], [100, "amber"], [110, "green"], [229, "green"], [230, "green"]])).toEqual([
			[30, "red"],
			[230, "green"],
		]);
	});
});

describe("pressureMessage and heavyHolder", () => {
	test("RED names memory stall, cpu, free memory and the heavy-run holder", () => {
		const hot = { ...calm, memSome: 34.12, cpuSome: 71.02, availMb: 1228.8 };
		expect(pressureMessage("red", hot, "NsX (p1) for 12 min")).toBe(
			"machine: RED — memory stall 34%, cpu 71%, 1.2 GB free; heavy-run lock held by NsX (p1) for 12 min",
		);
	});

	test("RED without a holder leaves the lock clause out", () => {
		expect(pressureMessage("red", { ...calm, memSome: 34.12, cpuSome: 71.02, availMb: 1228.8 }, null)).toBe(
			"machine: RED — memory stall 34%, cpu 71%, 1.2 GB free",
		);
	});

	test("GREEN says room again, and a missing reading reads n/a", () => {
		expect(pressureMessage("green", calm, null)).toBe("machine: GREEN — memory stall 1%, cpu 8%, 9.8 GB free; room again");
		expect(pressureMessage("red", NOTHING, null)).toBe("machine: RED — memory stall n/a, cpu n/a, n/a free");
	});

	test("the holder comes from the owner file: who, what, and minutes since the stamp", () => {
		const now = Date.parse("2026-11-07T18:00:00") / 1000;
		expect(heavyHolder("NsX | p1 | since 2026-11-07 17:48:00 | pid 42\n", now)).toBe("NsX (p1) for 12 min");
		expect(heavyHolder("", now)).toBeNull();
	});
});

describe("machine.pressure config", () => {
	test("defaults match the plan", () => {
		expect(cfg.machine.pressure).toEqual({
			sample_sec: 10,
			mem_some_red: 20,
			mem_full_red: 5,
			cpu_some_red: 60,
			red_after_sec: 30,
			green_after_sec: 120,
			repeat_sec: 600,
		});
	});
});
