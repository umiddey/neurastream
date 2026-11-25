// Owner UI POST action handlers: answer, team answer, incident, unlock, lock, tier, and queue reorder.

import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { RunSource } from "../adapter.ts";
import { chatTier, type Tier } from "../autonomy.ts";
import { nowSec, strftime } from "../clock.ts";
import type { Config } from "../config.ts";
import { dismissIncident, isFindingKind, openIncidents } from "../incidents.ts";
import { activePlans, chatUnlock, dependencyOrderProblems, expandHome, updateIndex, type Plan, type QueuePaths } from "../queue/lib.ts";
import { postTeamAnswer, type TeamEarlier } from "../team-client.ts";
import { ANSWER_MAX, jsonFail, jsonSent, receiptText, redirect, sentTo, textRes } from "./auth.ts";
import { inboxPath, storeOwnerMessage } from "./messages.ts";
import { pageRes } from "./render.ts";

/** The last answer appended per plan, for the double-press guard (P8c): memory only, no file. */
const lastAnswerByPlan = new Map<string, { answer: string; ts: number }>();
const DOUBLE_PRESS_SEC = 10;

/** Clears per-server answer deduplication memory when a fresh UI server starts. */
export function clearAnswerDedupe(): void {
	lastAnswerByPlan.clear();
}

/** Appends the answer to the owner inbox unless this plan got the same trimmed answer in the last 10 s (P8c). */
function appendAnswer(plan: string, question: string, answer: string, login: string, paths: Pick<QueuePaths, "queue_state">): void {
	const now = nowSec();
	const last = lastAnswerByPlan.get(plan);
	if (last !== undefined && last.answer === answer && now - last.ts < DOUBLE_PRESS_SEC) return;
	mkdirSync(paths.queue_state, { recursive: true });
	appendFileSync(inboxPath(paths), `${JSON.stringify({ ts: now, plan, question, answer, login })}\n`);
	lastAnswerByPlan.set(plan, { answer, ts: now });
}

export function handleAnswer(cfg: Config, source: RunSource, fields: Record<string, string>, login: string, wantsJson: boolean, pagesHost: string): Response {
	const planFile = (fields.plan ?? "").trim();
	const answer = (fields.answer_text ?? "").trim() || (fields.answer ?? "").trim();
	if (!planFile || !answer) return wantsJson ? jsonFail("plan and answer are required", 400) : textRes("plan and answer are required", 400);
	if (answer.length > ANSWER_MAX) return wantsJson ? jsonFail(`answer is longer than ${ANSWER_MAX} chars`, 400) : textRes(`answer is longer than ${ANSWER_MAX} chars`, 400);
	// P4: a team plan is answered on its server, never in this machine's inbox; the branch sits
	// before the INDEX lookup, which knows only this machine's own plans.
	if ((fields.team ?? "").trim()) return handleTeamAnswer(cfg, fields, planFile, answer, wantsJson);
	const plan = activePlans(cfg.paths).find(p => p.file === planFile);
	if (!plan) return wantsJson ? jsonFail("plan is not open and waiting", 409) : textRes("plan is not open and waiting", 409);
	if (plan.status !== "open" || !plan.waiting || !plan.waitingLine) {
		// Stale answer (P8b): Main cleared the question before the answer arrived; pass it on anyway.
		appendAnswer(planFile, "(already cleared)", answer, login, cfg.paths);
		if (wantsJson) return jsonSent("stale", receiptText("stale", new URLSearchParams()));
		return pageRes(cfg, source, new URLSearchParams({ sent: "stale" }), undefined, pagesHost);
	}
	appendAnswer(planFile, plan.waitingLine, answer, login, cfg.paths);
	if (wantsJson) return jsonSent("answer", receiptText("answer", new URLSearchParams()));
	return redirect(sentTo(fields.tab ?? "", "sent=answer"));
}

/**
 * An answer to a team plan (P4): `POST /answer/<id>` on that team's server with the answer
 * alone — the server stores the whois login — and nothing is written to this machine's inbox,
 * which belongs to its own Main. The double-press guard is the page's own memory, keyed
 * `<team>/<id>`; a repeated press within 10 s sends nothing again.
 */
export function handleTeamAnswer(cfg: Config, fields: Record<string, string>, planId: string, answer: string, wantsJson: boolean): Response {
	const name = (fields.team ?? "").trim();
	const team = cfg.teams.find(t => t.name === name);
	if (!team) return wantsJson ? jsonFail("unknown team", 400) : textRes("unknown team", 400);
	const key = `${team.name}/${planId}`;
	const now = nowSec();
	const last = lastAnswerByPlan.get(key);
	const repeat = last !== undefined && last.answer === answer && now - last.ts < DOUBLE_PRESS_SEC;
	let earlier: TeamEarlier | null = null;
	if (!repeat) {
		const out = postTeamAnswer(team, planId, answer);
		if ("unreachable" in out) return wantsJson ? jsonFail(`team server ${out.unreachable} unreachable`, 503) : textRes(`team server ${out.unreachable} unreachable`, 503);
		if (!out.ok) {
			const error = out.status === 404 ? "plan is not on the team server" : out.error;
			return wantsJson ? jsonFail(error, out.status === 404 ? 409 : out.status) : textRes(error, out.status === 404 ? 409 : out.status);
		}
		lastAnswerByPlan.set(key, { answer, ts: now });
		earlier = out.earlier;
	}
	const note = earlier ? `answer kept; an earlier answer by ${earlier.login} at ${strftime(earlier.time, "%H:%M")} won: "${earlier.answer}"` : null;
	if (wantsJson) return jsonSent("team-answer", note ?? receiptText("team-answer", new URLSearchParams({ team: team.name })));
	if (note) return textRes(note, 200);
	return redirect(sentTo(fields.tab ?? "", `sent=team-answer&team=${encodeURIComponent(team.name)}`));
}

// ---- POST /incident (plan P3): the owner's tap on a finding: "false alarm" closes it, "bug" plans it ----
export function handleIncident(cfg: Config, fields: Record<string, string>, login: string, wantsJson: boolean): Response {
	const id = (fields.id ?? "").trim();
	const choice = (fields.choice ?? "").trim();
	const fail = (error: string, status: number): Response => (wantsJson ? jsonFail(error, status) : textRes(error, status));
	if (choice !== "bug" && choice !== "false") return fail("choice must be bug or false", 400);
	const view = openIncidents(cfg).find(i => i.id === id);
	if (!view) return fail("incident is not open", 409);
	if (!isFindingKind(view.kind)) return fail("only a finding is tapped here", 409);
	if (choice === "false") {
		const why = `owner tapped "false alarm" on the phone page (${login}): ${view.proposal?.why ?? "no reason given"}`;
		const err = dismissIncident(cfg, id, why, undefined, login);
		if (err) return fail(err, 409);
		if (wantsJson) return jsonSent("incident-closed", receiptText("incident-closed", new URLSearchParams()));
		return redirect(sentTo(fields.tab ?? "", "sent=incident-closed"));
	}
	storeOwnerMessage(`${id}: it's a bug — plan it`, login, [], "", cfg.paths);
	if (wantsJson) return jsonSent("incident-bug", receiptText("incident-bug", new URLSearchParams()));
	return redirect(sentTo(fields.tab ?? "", "sent=incident-bug"));
}

export function handleUnlock(cfg: Config, fields: Record<string, string>, login: string, wantsJson: boolean): Response {
	const minutes = fields.minutes ?? "";
	if (minutes !== "" && !/^\d+$/.test(minutes)) return wantsJson ? jsonFail("minutes must be a number", 400) : textRes("minutes must be a number", 400);
	const result = chatUnlock(minutes === "" ? "unlock" : `unlock ${minutes}`, cfg, `ui:${login}`, "ui");
	if (!result.applied) return wantsJson ? jsonFail("Refused — chat unlock is off", 400) : redirect(sentTo(fields.tab ?? "", "sent=unlock-off"));
	mkdirSync(cfg.paths.queue_state, { recursive: true });
	appendFileSync(
		inboxPath(cfg.paths),
		`${JSON.stringify({ ts: nowSec(), kind: "unlock", minutes: result.minutes, until: result.until, login })}\n`,
	);
	if (wantsJson) return jsonSent("unlock", receiptText("unlock", new URLSearchParams({ minutes: String(result.minutes) })));
	return redirect(sentTo(fields.tab ?? "", `sent=unlock&minutes=${result.minutes}`));
}

export function handleLock(cfg: Config, fields: Record<string, string>, login: string, wantsJson: boolean): Response {
	const result = chatUnlock("lock", cfg, `ui:${login}`, "ui");
	if (!result.applied) return wantsJson ? jsonFail("Refused — chat unlock is off", 400) : redirect(sentTo(fields.tab ?? "", "sent=unlock-off"));
	mkdirSync(cfg.paths.queue_state, { recursive: true });
	appendFileSync(inboxPath(cfg.paths), `${JSON.stringify({ ts: nowSec(), kind: "lock", login })}\n`);
	if (wantsJson) return jsonSent("lock", receiptText("lock", new URLSearchParams()));
	return redirect(sentTo(fields.tab ?? "", "sent=lock"));
}

const TIERS: readonly Tier[] = ["strict", "opinionated", "full"];

// Autonomy tier from the phone page (plan 20261025_1940 P3): behind the same auth as every other
// route, written by the core chatTier with the owner's tapped name; a bad name is a 400 before
// the core is called, and the chat gate off redirects to the plain-words note like unlock/lock.
export function handleTier(cfg: Config, fields: Record<string, string>, login: string, wantsJson: boolean): Response {
	const name = (fields.tier ?? "").trim().toLowerCase();
	if (!(TIERS as readonly string[]).includes(name)) return wantsJson ? jsonFail("tier must be strict, opinionated or full", 400) : textRes("tier must be strict, opinionated or full", 400);
	const result = chatTier(`tier ${name}`, cfg, `ui:${login}`, "ui");
	if (!result.applied) return wantsJson ? jsonFail("Refused — chat unlock is off", 400) : redirect(sentTo(fields.tab ?? "", "sent=unlock-off"));
	mkdirSync(cfg.paths.queue_state, { recursive: true });
	appendFileSync(inboxPath(cfg.paths), `${JSON.stringify({ ts: nowSec(), kind: "tier", tier: result.tier, login })}\n`);
	if (wantsJson) return jsonSent("tier");
	return redirect(sentTo(fields.tab ?? "", `sent=tier&tier=${result.tier}`));
}

// ---- queue reorder (plan P4): the owner drags a card; INDEX.md is rewritten atomically ----

/**
 * The index text with its open-plan groups reordered: a group is a plan line plus the non-plan
 * lines (blank or `<!--` comment) attached above it, and the open groups — the first line of
 * each path in `openPaths`, in file order — are replaced by the groups of `order`, so every open
 * plan moves with its comment lines while every other plan line keeps its slot (a path listed
 * twice keeps both lines). Lines after the last plan keep the file's end. Returns null when an
 * order path is no longer in the file.
 */
export function reorderedIndexText(text: string, order: string[], openPaths: ReadonlySet<string>): string | null {
	if (!text) return null;
	const groups: { path: string; lines: string[] }[] = [];
	let pending: string[] = [];
	for (const raw of text.split("\n")) {
		const norm = raw
			.trim()
			.replace(/^[-*]\s+/, "")
			.trim();
		if (!norm || norm.startsWith("<!--")) {
			pending.push(raw);
			continue;
		}
		groups.push({ path: resolve(process.cwd(), expandHome(norm.replace(/`/g, ""))), lines: [...pending, raw] });
		pending = [];
	}
	// The open slots in file order: the first line of each open path; a later duplicate of the
	// same path keeps its place like a non-open line, so a path listed twice keeps both lines.
	const byPath = new Map<string, number>();
	const slots: number[] = [];
	const seen = new Set<string>();
	for (const [i, g] of groups.entries()) {
		if (!byPath.has(g.path)) byPath.set(g.path, i);
		if (openPaths.has(g.path) && !seen.has(g.path)) {
			seen.add(g.path);
			slots.push(i);
		}
	}
	if (slots.length !== order.length) return null;
	const parts: string[] = [];
	let k = 0;
	for (let i = 0; i < groups.length; i++) {
		if (slots[k] === i) {
			const at = byPath.get(order[k] ?? "");
			if (at === undefined) return null;
			parts.push(...groups[at]!.lines);
			k++;
		} else {
			parts.push(...groups[i]!.lines);
		}
	}
	parts.push(...pending);
	return parts.join("\n");
}

export function handleReorder(cfg: Config, fields: Record<string, string>, login: string, wantsJson: boolean): Response {
	const index = cfg.paths.queue_index;
	const order = (fields.order ?? "")
		.split("\n")
		.map(l => l.trim())
		.filter(l => l.length > 0);
	const before = (fields.before ?? "")
		.split("\n")
		.map(l => l.trim())
		.filter(l => l.length > 0);
	const moved = (fields.moved ?? "").trim();
	// The page's drag and arrow buttons send this over fetch (accept: application/json) and read
	// the JSON reply; a no-JS form post still gets the 303. Errors follow the same split.
	const fail = (error: string, status: number): Response =>
		wantsJson ? Response.json({ ok: false, error }, { status }) : textRes(error, status);
	// One source of truth for the reorderable set: the open plans, the same list queueRows renders.
	const openPlans = activePlans(cfg.paths).filter(p => p.status === "open");
	const openPaths = openPlans.map(p => p.file);
	const openPlan: Record<string, Plan> = Object.fromEntries(openPlans.map(p => [p.file, p]));
	if (!moved || !order.length) return fail("order and moved are required", 400);
	// 400: the posted order must be exactly the open plans the page renders now — no adds, drops or duplicates.
	if (new Set(order).size !== order.length) return fail("order lists a plan more than once", 400);
	const sortedOrder = [...order].sort();
	const sortedOpen = [...openPaths].sort();
	const sameSet = order.length === openPaths.length && sortedOrder.every((p, i) => p === sortedOpen[i]);
	if (!sameSet) return fail("order is not exactly the plans now on the page", 400);
	// 409: the order the page was rendered with must still be the open plans' current order.
	const stale = before.length !== openPaths.length || before.some((p, i) => p !== openPaths[i]);
	if (stale) return fail("the queue changed since the page loaded — reload and drag again", 409);
	// 409: the index is priority (I-20261025-208), so the posted order itself may not put a plan
	// above the open plan it waits on. Checked before any write: the index file and the reorder
	// inbox stay untouched, and the page's 409 branch shows the message and reloads the real order.
	const firstBlock = dependencyOrderProblems(order.map(o => openPlan[o]!))[0];
	if (firstBlock) return fail(`blocked: ${firstBlock}`, 409);
	const from = openPaths.indexOf(moved);
	const to = order.indexOf(moved);
	if (from === -1 || to === -1) return fail("moved is not one of the page's plans", 400);
	// The queue library owns every index write (plan 20261031_0911 P2): a reorder is the same plan
	// set, so no removal reason, and the locked RMW write lands temp + chmod 0444 + rename.
	const wrote = updateIndex(index, undefined, (currentText) => {
		const newText = reorderedIndexText(currentText, order, new Set(openPaths));
		return newText === null ? null : newText.trimEnd().split("\n");
	});
	if (!wrote) return fail("the queue index no longer lists every open plan", 400);
	mkdirSync(cfg.paths.queue_state, { recursive: true });
	appendFileSync(inboxPath(cfg.paths), `${JSON.stringify({ ts: nowSec(), kind: "reorder", plan: moved, from: from + 1, to: to + 1, login })}\n`);
	if (wantsJson) return Response.json({ ok: true, to: to + 1 });
	return redirect(sentTo(fields.tab ?? "", `sent=reorder&to=${to + 1}`));
}
