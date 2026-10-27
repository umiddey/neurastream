import type { Config } from "./config.ts";
import { recordOut } from "./provider-state.ts";
import { localStamp, parseWhen, wallToEpoch } from "./reset-time.ts";

const USAGE =
	'usage: quota-reset "YYYY-MM-DD HH:MM[:SS]" [--tz <zone>] [--provider <name>] (reset time from your provider\'s rate-limit message; --provider records it)\n';


export function quotaReset(args: string[], cfg: Config): number {
	let zone = cfg.quota.reset_tz;
	let provider: string | null = null;
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
		} else if (arg === "--provider") {
			const value = args[i + 1];
			if (value === undefined) {
				process.stderr.write(USAGE);
				return 2;
			}
			provider = value;
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
	if (provider !== null) {
		if (!cfg.ledger.providers.includes(provider)) {
			process.stderr.write(`quota-reset: unknown provider "${provider}" (ledger.providers: ${cfg.ledger.providers.join(", ")})\n`);
			return 1;
		}
		recordOut(cfg, provider, epoch, "quota-reset");
		console.log(`recorded: ${provider} out until ${local} (local) — agent-ledger --cap and the guards read it back`);
	}
	return 0;
}
