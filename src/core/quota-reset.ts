import { spawnSync } from "node:child_process";
import type { Config } from "./config.ts";

// Converts a provider's rate-limit reset time (wall clock in the provider's zone) into the caller's
// local time. Intl does the zone math; date(1) supplies the local zone abbreviation, because Intl's
// short timeZoneName is a tzdata abbreviation only for US zones (Europe/Berlin prints "GMT+2" where
// date +%Z prints "CEST"). macOS's BSD date is used there, so no GNU date is needed.

const USAGE =
	'usage: quota-reset "YYYY-MM-DD HH:MM[:SS]" [--tz <zone>] (reset time from your provider\'s rate-limit message)\n';

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
function wallToEpoch(wall: { y: number; mo: number; d: number; h: number; mi: number; s: number }, zone: string): number {
	const wallUtc = Date.UTC(wall.y, wall.mo - 1, wall.d, wall.h, wall.mi, wall.s);
	const first = wallUtc - zoneOffsetMs(wallUtc, zone);
	const second = wallUtc - zoneOffsetMs(first, zone);
	return Math.floor(second / 1000);
}

const WHEN = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/;

function parseWhen(text: string): { y: number; mo: number; d: number; h: number; mi: number; s: number } | null {
	const m = WHEN.exec(text.trim());
	if (!m) return null;
	const [, ys = "", mos = "", ds = "", hs = "", mis = "", ss = ""] = m;
	const wall = { y: +ys, mo: +mos, d: +ds, h: +hs, mi: +mis, s: ss ? +ss : 0 };
	const check = new Date(Date.UTC(wall.y, wall.mo - 1, wall.d, wall.h, wall.mi, wall.s));
	const valid =
		check.getUTCFullYear() === wall.y &&
		check.getUTCMonth() === wall.mo - 1 &&
		check.getUTCDate() === wall.d &&
		check.getUTCHours() === wall.h &&
		check.getUTCMinutes() === wall.mi &&
		check.getUTCSeconds() === wall.s;
	return valid ? wall : null;
}

// The tzdata abbreviation for this instant (CEST, CET, CST, +05) as date(1) prints it in the zone
// env this process runs in (the child inherits it, so the abbreviation always matches the wall
// clock next to it). Falls back to the Intl short name only when date fails.
function zoneAbbrev(epoch: number): string {
	const probe =
		process.platform === "darwin"
			? spawnSync("date", ["-r", String(epoch), "+%Z"], { encoding: "utf8" })
			: spawnSync("date", ["-d", `@${epoch}`, "+%Z"], { encoding: "utf8" });
	if (probe.status === 0 && probe.stdout?.trim()) return probe.stdout.trim();
	const parts = new Intl.DateTimeFormat("en-US", { timeZoneName: "short" }).formatToParts(new Date(epoch * 1000));
	return parts.find(p => p.type === "timeZoneName")?.value ?? "";
}

// Local wall clock of the process, "YYYY-MM-DD HH:MM:SS ZONE".
function localStamp(epoch: number): string {
	const parts = new Intl.DateTimeFormat("en-US", {
		hourCycle: "h23",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	}).formatToParts(new Date(epoch * 1000));
	const get = (type: string): string => parts.find(p => p.type === type)?.value ?? "";
	return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")} ${zoneAbbrev(epoch)}`;
}

export function quotaReset(args: string[], cfg: Config): number {
	let zone = cfg.quota.reset_tz;
	const words: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] ?? "";
		if (arg === "--tz") {
			const value = args[i + 1];
			if (value === undefined) {
				process.stderr.write(USAGE);
				return 2;
			}
			zone = value;
			i++;
		} else {
			words.push(arg);
		}
	}
	if (words.length < 1) {
		process.stderr.write(USAGE);
		return 2;
	}
	const when = words.join(" ");
	const wall = parseWhen(when);
	if (!wall) {
		process.stderr.write(`quota-reset: cannot parse "${when}" as YYYY-MM-DD HH:MM[:SS]\n`);
		return 1;
	}
	let epoch: number;
	try {
		epoch = wallToEpoch(wall, zone);
	} catch {
		process.stderr.write(`quota-reset: unknown time zone "${zone}"\n`);
		return 1;
	}
	const now = Math.floor(Date.now() / 1000);
	const local = localStamp(epoch);
	const label = cfg.quota.label;
	if (epoch <= now) {
		console.log(`${label} reset (local): ${local} — ALREADY BACK (${Math.floor((now - epoch) / 60)} min ago). Use ${label} now.`);
	} else {
		const d = epoch - now;
		console.log(`${label} reset (local): ${local} — in ${Math.floor(d / 3600)}h ${Math.floor((d % 3600) / 60)}m`);
	}
	return 0;
}
