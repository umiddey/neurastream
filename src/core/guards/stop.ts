// Prompt injection, cancel-word flagging, and keep-working stop rules.

import type { Decision, InjectEvent, StopEvent } from "../adapter.ts";
import { currentTier } from "../autonomy.ts";
import type { Config } from "../config.ts";
import { withFileLock, writeAtomicSync } from "../file-lock.ts";
import * as q from "../queue/lib.ts";
import { summaryHolder, teamSummaryLines, teamViews } from "../team-client.ts";
import {
	ALLOW,
	CANCEL_TODO,
	incidentLine,
	isOwnerProse,
	log,
	mainCallsExpired,
	openIncidentList,
	readStaffing,
	readWindow,
	recordOwnerMessage,
	staffedPlans,
	unlockLine,
	writeWindow,
} from "./state.ts";

// Owner message that may call work off: flag it; until Main records it with queue-cancel, no
// spawn and no stop. Returns the text appended to the injected summary.
export function flagCancel(text: string, cfg: Config): string {
	const m = text.match(q.CANCEL_WORDS);
	if (!m) return "";
	const at = m.index ?? 0;
	const words = text.slice(Math.max(0, at - 60), at + 80).replace(/\s+/g, " ").trim();
	const pendingFile = q.cancelPendingPath(cfg.paths);
	try {
		withFileLock(`${pendingFile}.lock`, () => {
			const prev = q.cancelPending(cfg.paths);
			writeAtomicSync(pendingFile, JSON.stringify({ at: new Date().toISOString(), words: prev ? `${prev.words} … ${words}` : words }));
		});
	} catch (err) {
		log(cfg.paths.guard_log, `cannot write ${pendingFile}: ${err}`);
	}
	log(cfg.paths.guard_log, `cancel flagged: ${words}`);
	return `\nmain-guard: ${CANCEL_TODO} Flagged: "${words}"`;
}

/**
 * prompt/owner message: inject the queue summary, flag cancel wording, list open incidents, reset
 * Main's edit window and the stop counters (the original resets them at every user message). A
 * turn the harness
 * starts from this guard's own stop continuation ("main-guard: …") is not an owner message: it
 * keeps the counters and the edit window, else every continuation reset the idle streak and a
 * model that only answers text was nudged again forever (2026-10-21 OOM: ~205 agent starts in one
 * non-interactive session).
 */
export function checkInject(e: InjectEvent, cfg: Config): Decision {
	if (e.agent !== "main") return ALLOW;
	const continuation = e.inject.trimStart().startsWith("main-guard:");
	if (!continuation) writeWindow({ used: [], windowStart: 0, mainCalls: 0 }, cfg.paths);
	recordOwnerMessage(e.inject, cfg);
	let summary: string;
	try {
		// P4 (20261027_1305): one GET /view per team, read once and handed to the holder and the
		// team lines, so the summary costs one request per team and never a second GET /claims.
		const views = teamViews(cfg);
		summary = q.queueSummary(cfg.paths, cfg.review.agents, summaryHolder(cfg, {}, views));
		const teamLines = teamSummaryLines(cfg, views, q.SUMMARY_CAP);
		if (teamLines.length) summary += `\n${teamLines.join("\n")}`;
	} catch (err) {
		summary = `Queue unreadable (${cfg.paths.queue_index}): ${err}`;
	}
	// P3 (plan 20261031_1207): only owner prose flags cancel, and incident lines pasted into a
	// prompt (guard output quoting "stop …") never do — their words are not the owner's.
	const cancel = continuation || !isOwnerProse(e.inject)
		? ""
		: flagCancel(e.inject.split("\n").filter(l => !l.startsWith("INCIDENT I-")).join("\n"), cfg);
	const incidents = openIncidentList(cfg);
	const incidentText = incidents.length ? `\n${incidents.map(incidentLine).join("\n")}` : "";
	// 20261025_1940 P2: the injected line names the autonomy tier and what Main does without asking in it.
	const tier = currentTier(cfg);
	const tierNote =
		tier === "strict"
			? `Main changes at most ${cfg.autonomy.strict_edit_limit} project files per ${cfg.guards.main_window_min} min, and every git push / glab mr merge / gh pr merge waits for your "${cfg.autonomy.go_phrase}" (one landing, valid ${cfg.autonomy.go_minutes} min).`
			: tier === "full"
				? `Main works unattended: no edit cap, its own "Priority skip: <plan> — Main: \\"<reason>\\"" skips pass, pushes and merges go through. Owner-only moves (guard files, the phone page, notify secrets, the unlock) stay locked.`
				: `Main changes at most ${cfg.guards.main_edit_limit} project files per ${cfg.guards.main_window_min} min; pushes and merges go through.`;
	const unlockNote = continuation ? "" : unlockLine(cfg);
	const mayNote = ` Main may edit Status/WAITING/Waits on/False positive lines. Test before saying "cannot".`;
	const editLimit = continuation ? "" : `\nautonomy: ${tier} — ${tierNote}${mayNote}${unlockNote}`;
	return {
		allow: true,
		reason: "",
		inject: `${summary}\n(main-guard: read ${cfg.paths.queue_index}; the listed plans are summarised above; work the open plans, close finished ones with queue-close.)${editLimit}${cancel}${incidentText}`,
		...(continuation ? {} : { state: { callsSinceStop: 0, idleStops: 0 } }),
	};
}

// Plans still responsible for: open plans (parked "WAITING on owner" excluded) plus queue problems.
export function openQueue(paths: q.QueuePaths, reviewAgents: string[] = []): string[] {
	const open = q
		.activePlans(paths)
		.filter(p => !p.waiting && !q.awaitingMerge(p, paths))
		.map(p => p.file);
	for (const prob of q.queueProblems(paths, reviewAgents)) open.push(`${prob.where}: ${prob.problem}`);
	const unique: string[] = [];
	for (const item of open) if (!unique.includes(item)) unique.push(item);
	return unique;
}

// Agent names from a ledger line that are alive (RUNNING or WAITING, idle under an hour).
export function liveSubagents(ledgerOut: string): string[] {
	return ledgerOut
		.split("\n")
		.filter(l => !l.startsWith("MAIN ") && /\s(RUNNING|WAITING)\b/.test(l))
		.filter(l => {
			const m = l.match(/idle (\d+)m/);
			return !m || Number(m[1]) < 60;
		})
		.map(l => l.split(/\s+/)[0] ?? "");
}

export const STOP_PLAN_OFFER_REFUSAL = "main-guard: don't promise it — do it now, or write the plan and index it";

/**
 * stop: Main may not stop while an open plan is not parked "WAITING on owner" (or the queue has a
 * problem) and no subagent is alive to wake it; an open owner-correction incident (source
 * "realtime", no plan, no dismissal) blocks the stop regardless of live subagents. Three stop
 * attempts in a row with zero tool calls
 * in between are let through. Returns the next counters in `state`.
 */
export function checkStop(e: StopEvent, cfg: Config): Decision {
	if (e.agent !== "main") return ALLOW;
	const state = { callsSinceStop: e.callsSinceStop, idleStops: e.idleStops };
	// 20261028_0900 P2: a reply that offers to plan instead of planning is refused for the offer
	// itself; the two-empty-stops valves below never release this block.
	if (e.reply && new RegExp(cfg.guards.plan_offer, "i").test(e.reply)) {
		log(cfg.paths.guard_log, "BLOCK stop: reply offers or promises instead of doing it");
		return { allow: false, reason: STOP_PLAN_OFFER_REFUSAL, state };
	}
	// P5 (plan 20261031_1207): once the turn spent its call budget, the stop is the release —
	// refusing it would order a capped Main to keep making calls the cap itself refuses. The
	// 15-min window expiry restarts the count, and the keep-working rule with it.
	if (cfg.guards.main_max_calls > 0) {
		const w = readWindow(cfg.paths);
		if (w.mainCalls >= cfg.guards.main_max_calls && !mainCallsExpired(w)) {
			log(cfg.paths.guard_log, `ALLOW stop: turn spent ${w.mainCalls}/${cfg.guards.main_max_calls} calls`);
			return { ...ALLOW, state };
		}
	}
	let open: string[];
	try {
		open = openQueue(cfg.paths, cfg.review.agents);
	} catch (err) {
		log(cfg.paths.guard_log, `BLOCK stop: cannot read queue: ${err}`);
		open = [`queue unreadable (${cfg.paths.queue_index}): ${err}`];
	}
	const pending = q.cancelPending(cfg.paths);
	if (pending && state.idleStops < 2) {
		if (state.callsSinceStop === 0) state.idleStops++;
		state.callsSinceStop = 0;
		log(cfg.paths.guard_log, `BLOCK stop: cancel pending (${pending.words})`);
		return { allow: false, reason: `main-guard: ${CANCEL_TODO} Flagged: "${pending.words}"`, state };
	}
	// Same release valve as cancel-pending: an idle Main that cannot act is let out after two
	// empty stop attempts instead of looping forever. Live subagents do not clear this block.
	// Findings/traces stay notes: only owner corrections (source "realtime") block the stop.
	const incidents = openIncidentList(cfg).filter(i => i.source === "realtime");
	if (incidents.length && state.idleStops < 2) {
		if (state.callsSinceStop === 0) state.idleStops++;
		state.callsSinceStop = 0;
		const ids = incidents.map(i => i.id).join(", ");
		log(cfg.paths.guard_log, `BLOCK stop: open incidents: ${ids}`);
		return {
			allow: false,
			reason:
				`main-guard: ${incidents.length} open incident(s) with no plan and no dismissal: ${ids}. Plan the fix: ` +
				"`neurastream incident plan <id> <plan.md>` (the plan must contain \"INCIDENT <id>\"), or dismiss it: " +
				'`neurastream incident dismiss <id> --why "<text>"`. The stop stays refused while an incident is open.',
			state,
		};
	}
	// P5 (plan 20261031_0911): a landed open plan whose auto-close failed holds the stop until a
	// running subagent's brief names it (staffing ∩ live ledger); unrelated live subagents release
	// nothing. Valve (20261031_2320): like the incident block above, empty stops count toward
	// cfg.guards.idle_stops; a stop with calls in between resets the count and re-locks.
	const locked = q.activePlans(cfg.paths).filter(p => p.status === "open" && q.autoCloseCandidate(p) && q.lastCloseFailed(p.file, cfg.paths));
	if (locked.length) {
		const staffed = staffedPlans(readStaffing(cfg.paths), liveSubagents(e.ledgerText));
		const unworked = locked.filter(s => !staffed.includes(s.file));
		if (unworked.length) {
			if (state.callsSinceStop === 0) state.idleStops++;
			else state.idleStops = 0;
			state.callsSinceStop = 0;
			if (state.idleStops >= cfg.guards.idle_stops) {
				log(cfg.paths.guard_log, `ALLOW stop after ${state.idleStops} idle stop attempts; locked: ${unworked.map(s => s.file).join(", ")}`);
				return { allow: true, reason: "", state: { callsSinceStop: 0, idleStops: 0 } };
			}
			const left = cfg.guards.idle_stops - state.idleStops;
			log(cfg.paths.guard_log, `BLOCK stop: landed but not closed: ${unworked.map(s => s.file).join(", ")}`);
			return {
				allow: false,
				reason:
					`main-guard: ${unworked.map(s => `${s.file} landed but its auto-close failed (${(q.lastCloseResult(s.file, cfg.paths) ?? "").replace(/^queue-close: /, "")})`).join("; ")}. ` +
					"The stop stays locked: spawn an agent whose brief names the plan, or fix the close. " +
					`${left} idle stop ${left === 1 ? "attempt" : "attempts"} left before the stop is allowed.`,
				state,
			};
		}
	}
	if (open.length === 0) return { ...ALLOW, state };
	const live = liveSubagents(e.ledgerText);
	if (live.length > 0) {
		log(cfg.paths.guard_log, `ALLOW stop: live subagents: ${live.join(", ")}`);
		return { ...ALLOW, state };
	}
	if (state.callsSinceStop === 0) state.idleStops++;
	else state.idleStops = 0;
	state.callsSinceStop = 0;
	if (state.idleStops >= cfg.guards.idle_stops) {
		log(cfg.paths.guard_log, `ALLOW stop after ${state.idleStops} idle stop attempts; open: ${open.join(" | ")}`);
		return { allow: true, reason: "", state: { callsSinceStop: 0, idleStops: 0 } };
	}
	// P5b (plan 20261031_1207): the refusal repeats on every blocked stop; name the first 10 only.
	const listed = open.slice(0, q.SUMMARY_CAP);
	const moreOpen = open.length - listed.length;
	log(cfg.paths.guard_log, `BLOCK stop; open: ${open.join(" | ")}`);
	return {
		allow: false,
		reason:
			`main-guard: the queue has ${open.length} open item${open.length === 1 ? "" : "s"} and no subagent is ` +
			`running to wake you. Owner rule: keep working while the queue has items. Start the next step (spawn an ` +
			`agent), close a finished plan with queue-close, or, if a plan truly waits on the owner, add a line ` +
			`"WAITING on owner: <what>" to that plan. Open: ${listed.join(" | ")}` +
			(moreOpen > 0 ? ` … ${moreOpen} more (queue-check lists all)` : ""),
		state,
	};
}
