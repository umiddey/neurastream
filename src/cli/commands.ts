import { agentLedger } from "../core/agent-ledger.ts";
import { agentScore } from "../core/agent-score.ts";
import { briefLint } from "../core/brief-lint.ts";
import { mainHealth } from "../core/main-health.ts";
import { ocRun } from "../core/oc-run.ts";
import { pmFailFacts } from "../core/pm-fail-facts.ts";
import { wipBackup } from "../core/wip-backup.ts";
import { wipCheck } from "../core/wip-check.ts";
import { wipSnapshot } from "../core/wip-snapshot.ts";
import { runtime } from "./runtime.ts";

export const PORTED = [
	"agent-score",
	"agent-ledger",
	"brief-lint",
	"oc-run",
	"wip-check",
	"wip-backup",
	"wip-snapshot",
	"pm-fail-facts",
	"main-health",
] as const;

export async function runPorted(cmd: string, args: string[]): Promise<number> {
	const rt = runtime();
	switch (cmd) {
		case "agent-score":
			return agentScore(args, rt.cfg, rt.source);
		case "agent-ledger":
			return agentLedger(args, rt.cfg, rt.source);
		case "brief-lint":
			return briefLint(args, rt.cfg);
		case "oc-run":
			return ocRun(args, rt.cfg);
		case "wip-check":
			return wipCheck(args, rt.cfg);
		case "wip-backup":
			return wipBackup(args, rt.cfg);
		case "wip-snapshot":
			return wipSnapshot(args, rt.cfg);
		case "pm-fail-facts":
			return pmFailFacts(args, rt.cfg);
		case "main-health":
			return mainHealth(args, rt.cfg, rt.source);
		default:
			return 2;
	}
}
