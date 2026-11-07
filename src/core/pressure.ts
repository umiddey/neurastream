import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.ts";

// Pressure core: reads the kernel's pressure (PSI) and memory numbers, classifies them, and decides when
// Main should hear about it. Read and report only; this file never acts on a process.

export type PressureLevel = "red" | "green" | "amber";
export interface PressureSample {
	memSome: number | null;
	memFull: number | null;
	cpuSome: number | null;
	ioFull: number | null;
	availMb: number | null;
	swapFreeMb: number | null;
}
export interface PressureState {
	level: PressureLevel;
	since: number;
	lastRed: number | null;
	redSent: boolean;
}

function avg10(line: string | undefined): number | null {
	const m = line?.match(/avg10=([\d.]+)/);
	return m ? Number(m[1]) : null;
}

/** avg10 of the `some` and `full` lines of a /proc/pressure file; unrecognised text gives nulls. */
export function parsePsi(text: string): { someAvg10: number | null; fullAvg10: number | null } {
	const lines = text.split("\n");
	return {
		someAvg10: avg10(lines.find((l) => l.startsWith("some "))),
		fullAvg10: avg10(lines.find((l) => l.startsWith("full "))),
	};
}

function readText(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

/** Reads the PSI files and /proc/meminfo under root. A missing file is null, never a throw. */
export function readPressure(root = "/"): PressureSample {
	const psi = (name: string) => parsePsi(readText(join(root, "proc/pressure", name)) ?? "");
	const mem = psi("memory");
	const meminfo = readText(join(root, "proc/meminfo")) ?? "";
	const kbToMb = (key: string): number | null => {
		const m = meminfo.match(new RegExp(`^${key}:\\s+(\\d+) kB`, "m"));
		return m ? Number(m[1]) / 1024 : null;
	};
	return {
		memSome: mem.someAvg10,
		memFull: mem.fullAvg10,
		cpuSome: psi("cpu").someAvg10,
		ioFull: psi("io").fullAvg10,
		availMb: kbToMb("MemAvailable"),
		swapFreeMb: kbToMb("SwapFree"),
	};
}

const over = (v: number | null, limit: number) => v !== null && v >= limit;
const under = (v: number | null, limit: number) => v !== null && v < limit;

/** Classifies one sample. Red on any stall or low-memory threshold; green only when every reading is well
 *  below its threshold; otherwise amber (including when nothing could be read). */
export function pressureLevel(s: PressureSample, cfg: Config): PressureLevel {
	const p = cfg.machine.pressure;
	const min = cfg.machine.avail_min_mb;
	if (over(s.memSome, p.mem_some_red) || over(s.memFull, p.mem_full_red) || over(s.cpuSome, p.cpu_some_red) || under(s.availMb, min)) {
		return "red";
	}
	const calm = under(s.memSome, p.mem_some_red / 2) && under(s.memFull, p.mem_full_red / 2) && under(s.cpuSome, p.cpu_some_red / 2) && over(s.availMb, min * 1.5);
	return calm ? "green" : "amber";
}

/** Advances the level state machine. RED fires once the level has been red for red_after_sec, then at most
 *  every repeat_sec. GREEN fires once, after green_after_sec of green, and only after a RED. Amber never fires. */
export function pressureTransition(prev: PressureState | null, level: PressureLevel, nowSec: number, cfg: Config): { state: PressureState; fire: "red" | "green" | null } {
	const p = cfg.machine.pressure;
	const base: PressureState = prev ?? { level: "amber", since: nowSec, lastRed: null, redSent: false };
	const state = base.level === level ? base : { ...base, level, since: nowSec };
	const held = nowSec - state.since;
	if (level === "red") {
		const due = held >= p.red_after_sec && (state.lastRed === null || nowSec - state.lastRed >= p.repeat_sec);
		return due ? { state: { ...state, lastRed: nowSec, redSent: true }, fire: "red" } : { state, fire: null };
	}
	if (level === "green" && state.redSent && held >= p.green_after_sec) {
		return { state: { ...state, redSent: false }, fire: "green" };
	}
	return { state, fire: null };
}

/** The heavy-run holder right now, read from cfg.paths.heavy_owner; null when the file is missing or no lock is held. Shared by the tick and `neurastream pressure`. */
export function currentHolder(cfg: Config, nowSec: number): string | null {
	const text = readText(cfg.paths.heavy_owner);
	return text === null ? null : heavyHolder(text, nowSec);
}

/** The line Main reads. holder is the heavy-run lock holder from heavyHolder, or null. */
export function pressureMessage(level: "red" | "green", s: PressureSample, holder: string | null): string {
	const mem = s.memSome === null ? "n/a" : `${Math.round(s.memSome)}%`;
	const cpu = s.cpuSome === null ? "n/a" : `${Math.round(s.cpuSome)}%`;
	const free = s.availMb === null ? "n/a" : `${(s.availMb / 1024).toFixed(1)} GB`;
	const tail = level === "green" ? "; room again" : holder === null ? "" : `; heavy-run lock held by ${holder}`;
	return `machine: ${level === "red" ? "RED" : "GREEN"} — memory stall ${mem}, cpu ${cpu}, ${free} free${tail}`;
}

/** Turns the heavy-run owner file ("<who> | <what> | since <stamp> | pid N") into "who (what) for N min".
 *  Null when the file is empty. nowSec is in seconds. */
export function heavyHolder(ownerText: string, nowSec: number): string | null {
	const m = ownerText.match(/^(.*?) \| (.*?) \| since (\S+ \S+) \|/);
	if (!m) return null;
	const [, who = "", what = "", stamp = ""] = m;
	const since = Date.parse(stamp.replace(" ", "T"));
	if (Number.isNaN(since)) return `${who} (${what})`;
	return `${who} (${what}) for ${Math.floor((nowSec * 1000 - since) / 60000)} min`;
}
