import type { Config } from "./config.ts";
import { localStamp, parseWhen, wallToEpoch } from "./reset-time.ts";

const USAGE =
	'usage: quota-reset "YYYY-MM-DD HH:MM[:SS]" [--tz <zone>] (reset time from your provider\'s rate-limit message)\n';


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
