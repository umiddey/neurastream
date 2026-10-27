// `neurastream diagram check <html> <plan.md>` (plan 20261026_0930 P10): the diagram a plan page
// shows must cover the plan — every phase, every file or command its phase lines name — and every box
// that drills down must hold at least two kids. Exit 1 lists what is missing, and `pages publish
// --plan` refuses to enable Approve while this fails.
import { checkDiagramFiles, type DiagramReport } from "../core/diagram-check.ts";

export function runDiagram(args: string[] = []): number {
	if (args[0] !== "check" || args.length !== 3) {
		console.error("usage: neurastream diagram check <html> <plan.md>");
		return 2;
	}
	let report: DiagramReport;
	try {
		report = checkDiagramFiles(args[1]!, args[2]!);
	} catch (err) {
		console.error(`diagram check: ${err instanceof Error ? err.message : String(err)}`);
		return 1;
	}
	for (const item of report.missing) console.log(`missing: ${item}`);
	for (const item of report.thin) console.log(`thin: ${item} — a box that drills down holds 2+ kids`);
	if (report.missing.length + report.thin.length > 0) {
		console.error(`diagram check: ${report.missing.length} missing, ${report.thin.length} thin`);
		return 1;
	}
	console.log("diagram check: every phase and path is in a box, and every box with kids has 2+");
	return 0;
}
