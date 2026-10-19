// @ts-nocheck
// plan-guard: hard rules for every agent session (model: ../queue/lib.ts).
//
// Everyone (Main and subagents):
//   - Guard lock: the guards, their data and the agent model pins (lib.ts PROTECTED) cannot be changed
//     from inside a session. The owner unlocks for 30 minutes with `touch ~/.omp/agent/.guard-unlock`
//     from a terminal.
// Subagents (the implementers):
//   - Phase-0 blockers: on every call that touches an open plan's repo, worktrees or "## Applies to"
//     paths, each blocker script runs; non-zero exit refuses the call.
//   - Plans: a subagent may change an open plan only with write/edit and only inside "## Progress",
//     and never its "Status:" line or any "WAITING on owner:" line (owner 2026-10-15: only Main judges
//     a plan complete, after review); anything else is restored right after the call and reported as
//     an error. Repo INDEX.md and blocker scripts are read-only for subagents.
//   - Call budget: from call SUB_WARN_CALLS the agent is told to write its progress; from SUB_MAX_CALLS
//     every call is refused except reading and editing its plan, so the plan is always updated
//     before the agent runs out.
//   - An invalid plan blocks every subagent call on its repo.

import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	activePlans,
	isOrchestrationPath,
	outsideProgress,
	planAt,
	planCovers,
	protectedHit,
	SUB_MAX_CALLS,
	SUB_WARN_CALLS,
	touchedPaths,
	unlocked,
	UNLOCK,
	writeTargets,
} from "../queue/lib.ts";

const LOG = process.env.PLAN_GUARD_LOG ?? `${os.homedir()}/.local/state/plan-guard.log`;
const SKIP_TOOLS = new Set(["todo", "wait", "ask", "web_search", "job", "cancel_job"]);
const READ_TOOLS = new Set(["read", "grep", "glob", "find"]);

function log(line: string) {
	try {
		appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`);
	} catch {}
}

// Reason to refuse the call, or null. `snap` receives plan snapshots to verify after the call.
export function checkCall(
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
	agent: string,
	calls = 0,
	snap?: Map<string, string>,
): string | null {
	if (SKIP_TOOLS.has(toolName)) return null;
	const paths = touchedPaths(toolName, input ?? {}, cwd);
	const writes = writeTargets(toolName, input ?? {}, cwd);
	const hit = protectedHit(writes);
	if (hit && !unlocked())
		return `${hit} is a protected guard file. Only the owner changes it (unlock: \`touch ${UNLOCK}\` in a terminal, valid 30 min).`;
	if (agent === "main") return null;
	// Closing and cancelling are Main's decisions (owner 2026-10-15/16).
	if ((toolName === "bash" || toolName === "eval") && /\bqueue-(?:close|cancel)\b/.test(JSON.stringify(input ?? {})))
		return "queue-close and queue-cancel are Main's; report in your plan's \"## Progress\" instead.";
	const plans = activePlans();
	if (calls >= SUB_MAX_CALLS) {
		const planEdit = (toolName === "write" || toolName === "edit") && writes.length > 0 && writes.every(p => planAt(p, plans));
		const planRead = READ_TOOLS.has(toolName) && paths.length > 0 && paths.every(p => planAt(p, plans));
		if (!planEdit && !planRead)
			return `call budget spent (${calls}/${SUB_MAX_CALLS}). Only reading and editing your plan's "## Progress" is allowed now: write what you did, what is verified, what is next, then end your run.`;
	}
	if (!plans.length || !paths.length) return null;
	for (const p of writes) {
		if (!isOrchestrationPath(p, plans)) continue;
		const plan = planAt(p, plans);
		if (!plan) return `${p} belongs to Main (repo index / blocker script); read it, never change it. Report instead.`;
		if (toolName !== "write" && toolName !== "edit")
			return `${p} is a plan file: change its "## Progress" section only with the edit or write tool.`;
		try {
			snap?.set(p, readFileSync(p, "utf8"));
		} catch {}
	}
	for (const plan of plans) {
		const hit = paths.filter(p => !isOrchestrationPath(p, plans) && planCovers(plan, p));
		if (!hit.length) continue;
		const name = path.basename(plan.file);
		if (plan.errors.length) return `plan ${plan.file} is invalid (${plan.errors.join("; ")}). Stop and report to Main.`;
		for (const b of plan.blockers) {
			try {
				execFileSync(b.script, b.args, {
					input: JSON.stringify({ tool: toolName, input, cwd, agent, repo: plan.repo, plan: plan.file, paths: hit }),
					encoding: "utf8",
					timeout: 10000,
					stdio: ["pipe", "pipe", "pipe"],
				});
			} catch (err) {
				const why = String(err?.stderr ?? "").trim() || `${path.basename(b.script)} failed (${err?.message ?? err})`;
				return `blocked by plan ${name}: ${why}`;
			}
		}
	}
	return null;
}

// Lines only Main may write: the status, owner parking, owner cancellation, cancelled-list clearance.
function mainOnlyLines(text: string): string {
	return text
		.split("\n")
		.filter(l => /^\s*(?:[-*]\s+)?(Status:|WAITING on owner:|Cancelled by owner:|False positive:)/.test(l))
		.join("\n");
}

// After a subagent changed a plan: everything outside "## Progress", the "Status:" line and any
// "WAITING on owner:" line must be unchanged. Returns an error text after restoring the snapshot, or null.
export function verifyPlanEdits(snap: Map<string, string>): string | null {
	const bad: string[] = [];
	for (const [file, before] of snap) {
		let after = before;
		try {
			after = readFileSync(file, "utf8");
		} catch {}
		if (outsideProgress(after) !== outsideProgress(before) || mainOnlyLines(after) !== mainOnlyLines(before)) {
			writeFileSync(file, before);
			bad.push(file);
		}
	}
	return bad.length
		? `plan-guard: you changed ${bad.join(", ")} outside your progress entries (only "## Progress" entries are yours; the "Status:", "WAITING on owner:", "Cancelled by owner:" and "False positive:" lines are Main's, it marks a plan complete after reviewing your work). The file was restored.`
		: null;
}

export default function planGuard(pi) {
	const calls = new Map<string, number>();
	const pending = new Map<string, Map<string, string>>();

	pi.on("tool_call", async (event, ctx) => {
		const agent = ctx.agent?.kind === "sub" ? "sub" : "main";
		const id = ctx.agent?.id ?? "main";
		const n = agent === "sub" && !SKIP_TOOLS.has(event.toolName) ? (calls.get(id) ?? 0) + 1 : 0;
		if (agent === "sub") calls.set(id, n);
		const snap = new Map<string, string>();
		const reason = checkCall(event.toolName, event.input ?? {}, ctx.cwd ?? process.cwd(), agent, n - 1, snap);
		if (reason) {
			log(`BLOCK ${agent}:${id} tool=${event.toolName} ${reason}`);
			return { block: true, reason: `plan-guard: ${reason}` };
		}
		if (snap.size) pending.set(event.toolCallId, snap);
		if (agent === "sub" && n >= SUB_WARN_CALLS && n < SUB_MAX_CALLS)
			return {
				additionalContext: `plan-guard: call ${n}/${SUB_MAX_CALLS}. Update your plan's "## Progress" now (done, verified, next); at ${SUB_MAX_CALLS} only that edit is allowed.`,
			};
	});

	pi.on("tool_result", async event => {
		const snap = pending.get(event.toolCallId);
		if (!snap) return;
		pending.delete(event.toolCallId);
		const err = verifyPlanEdits(snap);
		if (!err) return;
		log(`RESTORE ${[...snap.keys()].join(",")}`);
		return { isError: true, content: [{ type: "text", text: err }] };
	});
}
