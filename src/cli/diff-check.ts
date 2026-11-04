// `neurastream diff-check [--staged | <rev>]` (P6, plan 20261024_1915): the removal check
// (src/core/diff-check.ts) as a CLI. --staged scans the staged diff (no commit, so no subject
// match); <rev> scans that commit's patch with its subject applied. Prints flagged
// `file:line: text` lines, exit 1 on hits, 0 clean, 2 on usage.

import { ConfigError, loadConfig } from "../core/config.ts";
import { commitDiff, removalFlags, stagedDiff } from "../core/diff-check.ts";

const USAGE = "usage: neurastream diff-check [--staged | <rev>]   flag added removal comments (labels.removal_*); exit 1 on hits";

export function runDiffCheck(args: string[]): number {
	const rev = args.length === 1 && args[0] !== "--staged" && !args[0]!.startsWith("-") ? args[0]! : null;
	if (args.length !== 1 || (rev === null && args[0] !== "--staged")) {
		console.error(USAGE);
		return 2;
	}
	try {
		const cfg = loadConfig();
		const { diff, subject } = rev === null
			? { diff: stagedDiff(process.cwd()), subject: "" }
			: commitDiff(process.cwd(), rev);
		const flags = removalFlags(diff, subject, cfg);
		for (const f of flags) console.log(`${f.file}:${f.line}: ${f.text}`);
		return flags.length > 0 ? 1 : 0;
	} catch (err) {
		// A git failure (no repo, bad rev) must never read as clean: report and exit 1.
		console.error(err instanceof ConfigError ? err.message : String(err));
		return 1;
	}
}
