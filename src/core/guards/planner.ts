// Planner mode (plan 20261102_1515 P2): named planner spawn tracking and delegated plan-body checks.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { withFileLock, writeAtomicSync } from "../file-lock.ts";
import { MAIN_ONLY_LINE } from "../plan-approval.ts";
import * as q from "../queue/lib.ts";

/** The plan path a brief's `Planner role for <plan path>` line names (its first word, trailing `.,;:` dropped, so text after the path never joins it), or null. */
export function plannerRolePlan(text: string): string | null {
	const p = (/^[ \t]*Planner role for[ \t]+(\S+)/im.exec(text)?.[1] ?? "").replace(/[.,;:]+$/, "");
	return p || null;
}

/** Spawn-time check of a bound planner plan path: absolute, `.md`, under a `docs/plans` dir that exists (the planner may create a subfolder). Returns the refusal text, or null when fine. */
export function plannerPlanProblem(plan: string): string | null {
	const cut = plan.indexOf("/docs/plans/");
	const ok = path.isAbsolute(plan) && plan.endsWith(".md") && cut >= 0 && existsSync(plan.slice(0, cut + "/docs/plans".length));
	return ok
		? null
		: `the \`Planner role for\` path "${plan}" must be an absolute .md path in an existing docs/plans dir, alone as the first word after "for" (e.g. \`Planner role for /path/to/repo/docs/plans/20261103_1015_x.md\`).`;
}

/** P2(b): the named planner spawns, spawn name → the one plan path its brief may create and edit (planner-spawns.json in the state dir). Recorded only on an approved spawn: in main mode the spawn gate refused the brief, so a binding exists only for a delegated planner. */
function plannerSpawnsFile(paths: Pick<q.QueuePaths, "queue_state">): string {
	return path.join(paths.queue_state, "planner-spawns.json");
}

export function readPlannerSpawns(paths: Pick<q.QueuePaths, "queue_state">): Record<string, string> {
	try {
		const parsed: unknown = JSON.parse(readFileSync(plannerSpawnsFile(paths), "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {};
	} catch {
		return {};
	}
}

export function recordPlannerSpawn(name: string, plan: string, paths: Pick<q.QueuePaths, "queue_state">): void {
	const file = plannerSpawnsFile(paths);
	withFileLock(`${file}.lock`, () => {
		const spawns = readPlannerSpawns(paths);
		spawns[name] = plan;
		writeAtomicSync(file, `${JSON.stringify(spawns, null, 2)}\n`);
	});
}

/** The plan path the agent's brief named in its `Planner role for` line: its spawn name, or the name without a -<digits> suffix (the P4f id rule); null when no planner role is bound. */
export function plannerSpawnPlan(agentId: string, paths: Pick<q.QueuePaths, "queue_state">): string | null {
	const spawns = readPlannerSpawns(paths);
	for (const name of [agentId, agentId.replace(/-\d+$/, "")]) {
		const plan = Object.hasOwn(spawns, name) ? spawns[name] : undefined;
		if (typeof plan === "string" && plan) return plan;
	}
	return null;
}

/** The plan text a planner agent owns: everything outside "## Progress" and the Main-only lines (planner mode P2a, plan 20261102_1515) — minus the two zones Main may still correct (punch list, plan 20261102_2315): a "## Done check" section's body, and the backticked `verify:` span on a "## Phases" checkbox line. */
export function plannerBody(text: string): string {
	const body = q.outsideProgress(text).split("\n");
	let section = "";
	// Dropped lines are removed, not blanked: adding or deleting a Main-only line must not change the body.
	return body
		.flatMap((l) => {
			if (l.startsWith("## ")) section = l;
			if (/^## +Done check\b/i.test(section) || MAIN_ONLY_LINE.test(l)) return [];
			if (/^## +Phases\b/i.test(section) && /^- \[[ x]\]/.test(l)) return [l.replace(/`verify:[^`]*`/g, "`verify:`")];
			return [l];
		})
		.join("\n");
}
