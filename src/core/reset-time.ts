import { spawnSync } from "node:child_process";

export interface WallTime {
	y: number;
	mo: number;
	d: number;
	h: number;
	mi: number;
	s: number;
}

// Offset in ms of `zone` from UTC at the instant `epochMs` (local wall clock minus UTC).
function zoneOffsetMs(epochMs: number, zone: string): number {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: zone,
		hourCycle: "h23",
		year: "numeric",
		month: "numeric",
		day: "numeric",
		hour: "numeric",
		minute: "numeric",
		second: "numeric",
	}).formatToParts(new Date(epochMs));
	const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
	const wallAsUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
	return wallAsUtc - Math.floor(epochMs / 1000) * 1000;
}

// Epoch seconds for a wall-clock time in `zone`; two passes settle the DST edge.
export function wallToEpoch(wall: WallTime, zone: string): number {
	const wallUtc = Date.UTC(wall.y, wall.mo - 1, wall.d, wall.h, wall.mi, wall.s);
	const first = wallUtc - zoneOffsetMs(wallUtc, zone);
	const second = wallUtc - zoneOffsetMs(first, zone);
	return Math.floor(second / 1000);
}

const WHEN = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/;

export function parseWhen(text: string): WallTime | null {
	const m = WHEN.exec(text.trim());
	if (!m) return null;
	const [, ys = "", mos = "", ds = "", hs = "", mis = "", ss = ""] = m;
	const wall = { y: +ys, mo: +mos, d: +ds, h: +hs, mi: +mis, s: ss ? +ss : 0 };
	const check = new Date(Date.UTC(wall.y, wall.mo - 1, wall.d, wall.h, wall.mi, wall.s));
	return check.getUTCFullYear() === wall.y && check.getUTCMonth() === wall.mo - 1 && check.getUTCDate() === wall.d &&
		check.getUTCHours() === wall.h && check.getUTCMinutes() === wall.mi && check.getUTCSeconds() === wall.s ? wall : null;
}

function zoneAbbrev(epoch: number): string {
	// Pass the zone Intl actually uses: Bun neither forwards a TZ set after startup by default
	// nor enumerates it in process.env, so `date` would label the local time with the wrong zone.
	const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
	const opts = { encoding: "utf8" as const, env: { ...process.env, TZ: zone } };
	const probe = process.platform === "darwin"
		? spawnSync("date", ["-r", String(epoch), "+%Z"], opts)
		: spawnSync("date", ["-d", `@${epoch}`, "+%Z"], opts);
	if (probe.status === 0 && probe.stdout?.trim()) return probe.stdout.trim();
	const parts = new Intl.DateTimeFormat("en-US", { timeZoneName: "short" }).formatToParts(new Date(epoch * 1000));
	return parts.find(p => p.type === "timeZoneName")?.value ?? "";
}

export function localStamp(epoch: number): string {
	const parts = new Intl.DateTimeFormat("en-US", {
		hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
		hour: "2-digit", minute: "2-digit", second: "2-digit",
	}).formatToParts(new Date(epoch * 1000));
	const get = (type: string): string => parts.find(p => p.type === type)?.value ?? "";
	return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")} ${zoneAbbrev(epoch)}`;
}

function explicitZoneEpoch(wall: WallTime, zone: string): number {
	if (zone === "Z" || zone === "UTC" || zone === "GMT") return wallToEpoch(wall, "UTC");
	const offset = /^([+-])(\d{2}):?(\d{2})$/.exec(zone);
	if (offset) {
		const minutes = (Number(offset[2]) * 60 + Number(offset[3])) * (offset[1] === "+" ? 1 : -1);
		return Math.floor((Date.UTC(wall.y, wall.mo - 1, wall.d, wall.h, wall.mi, wall.s) - minutes * 60_000) / 1000);
	}
	return wallToEpoch(wall, zone);
}

export function annotateResetTimes(text: string, rule: { pattern: string; zone: string }): string {
	let pattern: RegExp;
	try {
		pattern = new RegExp(rule.pattern, "g");
	} catch {
		return text;
	}
	const matches = [...text.matchAll(pattern)];
	if (matches.length === 0) return text;
	let result = "";
	let position = 0;
	for (const match of matches) {
		const full = match[0] ?? "";
		const index = match.index ?? 0;
		const wallText = match[1];
		const explicitZone = match[2]?.trim();
		const end = index + full.length;
		const timestampEnd = index + full.trimEnd().length;
		if (text.slice(timestampEnd).startsWith("(= ") || text.slice(timestampEnd).startsWith(" (= ")) {
			result += text.slice(position, end);
			position = end;
			continue;
		}
		result += text.slice(position, timestampEnd);
		position = timestampEnd;
		if (!wallText) continue;
		const wall = parseWhen(wallText);
		if (!wall) continue;
		try {
			const epoch = explicitZone ? explicitZoneEpoch(wall, explicitZone) : wallToEpoch(wall, rule.zone);
			result += ` (= ${localStamp(epoch)} local)`;
		} catch {
			// A zone we cannot resolve is not a basis for guessing.
		}
	}
	return result + text.slice(position);
}
