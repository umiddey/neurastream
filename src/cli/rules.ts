// `neurastream rules` (plan 20261110_1746 P4b): one line per rule, read-only. The level is what
// levelFor reads, so a pinned, absent, or corrupt rule prints block. The one write is the corrupt
// file's guard line, through the same helper the daily tuner step uses (once per run).
import { ConfigError, loadConfig, type Config } from "../core/config.ts";
import { PINNED, TUNABLE, levelFor, readLevels, type RuleLevels } from "../core/rule-levels.ts";
import { noteCorruptLevels } from "../core/watch.ts";

const USAGE = "usage: neurastream rules";

/** Every rule to print: the pinned and tunable kinds, then any other id the levels file names. */
function ruleIds(levels: RuleLevels): string[] {
	const ids = new Set<string>([...PINNED, ...TUNABLE]);
	for (const id of Object.keys(levels.rules)) ids.add(id);
	return [...ids];
}

/** One line per rule, then the tuner bar (the file's `tuner.bar`, else the config's min_fires it starts at). */
export function rulesLines(cfg: Config): string[] {
	const levels = readLevels(cfg);
	const lines = ruleIds(levels).map(id => {
		// The entry is read by own key for its display fields only; the level comes from levelFor.
		const entry = Object.hasOwn(levels.rules, id) ? levels.rules[id] : undefined;
		const hold = entry?.held_until === undefined ? "" : ` held_until=${entry.held_until}`;
		return `${id} ${levelFor(levels, id)} prev=${entry?.prev ?? "-"} date=${entry?.date ?? "-"}${hold}`;
	});
	lines.push(`tuner bar ${levels.tuner?.bar ?? cfg.tuning.min_fires}`);
	return lines;
}

export function runRules(args: string[], opts: { home?: string } = {}): number {
	if (args.length > 0) {
		console.error(USAGE);
		return 2;
	}
	let cfg: Config;
	try {
		cfg = loadConfig(opts.home === undefined ? undefined : { home: opts.home });
	} catch (err) {
		console.error(err instanceof ConfigError ? err.message : String(err));
		return 1;
	}
	if (noteCorruptLevels(cfg, readLevels(cfg))) console.error("rules: the levels file is corrupt; every rule reads as block");
	for (const line of rulesLines(cfg)) console.log(line);
	return 0;
}
