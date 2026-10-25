// `neurastream guard <event> --json`: one guard decision over stdin/stdout, for any harness that
// can run a hook command. Stdin is the event JSON, stdout one Decision JSON, exit 0 when allowed
// and 2 when refused (same code a blocker uses).

import type { Decision, InjectEvent, PlanEditEvent, SpawnEvent, StopEvent, ToolEvent } from "../core/adapter.ts";
import { ConfigError, loadConfig } from "../core/config.ts";
import { checkPlanEdit, checkSpawn, checkStop, checkTool, checkInject } from "../core/guards.ts";
import { applyQueueEnv } from "../core/queue/env.ts";
import type { Config } from "../core/config.ts";

export const GUARD_EVENTS = ["pre-tool", "prompt", "inject", "spawn", "plan-edit", "stop"] as const;

export const GUARD_USAGE =
	`usage: neurastream guard <event> --json  (events: ${GUARD_EVENTS.join(", ")}; event JSON on stdin)`;

function asObject(v: unknown): Record<string, unknown> {
	return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function asString(v: unknown, fallback = ""): string {
	return typeof v === "string" ? v : fallback;
}

function asNumber(v: unknown, fallback = 0): number {
	return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function asAgent(v: unknown): "main" | "sub" {
	return v === "sub" ? "sub" : "main";
}

function asStringList(v: unknown): string[] {
	return Array.isArray(v) ? v.map(x => String(x)) : [];
}

function toolEvent(p: Record<string, unknown>): ToolEvent {
	return {
		tool: asString(p.tool),
		input: asObject(p.input),
		cwd: asString(p.cwd),
		agent: asAgent(p.agent),
		agentId: asString(p.agentId, "main"),
		calls: asNumber(p.calls),
		paths: asStringList(p.paths),
		writes: asStringList(p.writes),
		command: asString(p.command),
		...(p.runningJobs === undefined ? {} : { runningJobs: asStringList(p.runningJobs) }),
	};
}

function decide(event: string, p: Record<string, unknown>, cfg: Config): Decision {
	switch (event) {
		case "pre-tool":
			return checkTool(toolEvent(p), cfg);
		case "prompt":
		case "inject": {
			// Core calls the message text "inject" (the protocol word "prompt" is a reserved token
			// in src/core); the CLI accepts both field names.
			const e: InjectEvent = { inject: asString(p.prompt ?? p.inject), agent: asAgent(p.agent) };
			return checkInject(e, cfg);
		}
		case "spawn": {
			const e: SpawnEvent = {
				agent: asString(p.agent),
				invocationKind: asString(p.invocationKind, "task"),
				brief: asString(p.brief ?? p.context ?? p.task),
				...(p.runningJobs === undefined ? {} : { runningJobs: asStringList(p.runningJobs) }),
			};
			return checkSpawn(e, cfg);
		}
		case "plan-edit": {
			const e: PlanEditEvent = { path: asString(p.path), before: asString(p.before), after: asString(p.after), agent: asAgent(p.agent) };
			return checkPlanEdit(e, cfg);
		}
		case "stop": {
			const e: StopEvent = {
				agent: asAgent(p.agent),
				callsSinceStop: asNumber(p.callsSinceStop),
				idleStops: asNumber(p.idleStops),
				ledgerText: asString(p.ledgerText),
			};
			return checkStop(e, cfg);
		}
		default:
			return { allow: false, reason: `unknown guard event: ${event}` };
	}
}

export async function runGuard(event: string): Promise<number> {
	if (!(GUARD_EVENTS as readonly string[]).includes(event)) {
		console.error(`unknown guard event: ${event}\n${GUARD_USAGE}`);
		return 2;
	}
	let cfg: Config;
	try {
		cfg = loadConfig();
		applyQueueEnv(cfg);
	} catch (err) {
		console.error(err instanceof ConfigError ? err.message : String(err));
		return 1;
	}
	let raw = "";
	try {
		raw = await Bun.stdin.text();
	} catch {}
	let payload: unknown;
	try {
		payload = JSON.parse(raw);
	} catch {
		console.error("guard: stdin must be one JSON event object");
		return 2;
	}
	const d = decide(event, asObject(payload), cfg);
	console.log(JSON.stringify(d));
	return d.allow ? 0 : 2;
}
