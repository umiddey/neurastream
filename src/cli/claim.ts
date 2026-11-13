// `neurastream claim` (plan 20261027_1300 P4; team plans 20261027_1305 P3): picking work across
// several Mains over one queue. `next` claims the highest free plan in index order with the
// queue's own skip rules — open only, not WAITING on the owner, not waiting on another open
// plan (the queueSummary waits-on rule), not held by another Main or member, not on a team
// server that does not answer; `list` prints the live claims (the file store's list plus each
// team's remote list); `release <plan>` frees this Main's claim and `--force` frees another
// Main's or member's, refused for agents by the guard (the owner runs it in a terminal).
import path from "node:path";
import { fileClaimStore, heldByOther, type Claim, type ClaimStore } from "../core/claims.ts";
import { nowSec, strftime } from "../core/clock.ts";
import { mainId } from "../core/guards.ts";
import { applyQueueEnv } from "../core/queue/env.ts";
import { activePlans, openWaits } from "../core/queue/lib.ts";
import { claimStoreFor, remoteStoreFor, type TeamEntry } from "../core/team-client.ts";
import type { Config } from "../core/config.ts";

const USAGE = [
	"usage: neurastream claim next",
	"       neurastream claim list",
	"       neurastream claim release <plan> [--force]",
].join("\n");

export function claimCli(args: string[], cfg: Config): number {
	applyQueueEnv(cfg);
	const me = mainId();

	if (args[0] === "next") {
		// Index order IS priority; the skips are queueSummary's flags minus plans another live
		// Main holds. A claim that races away mid-loop just moves the pick to the next plan.
		const plans = activePlans();
		const rank = new Map(plans.map((p, i) => [p.file, i + 1] as const));
		for (const p of plans) {
			if (p.status !== "open" || p.waiting || openWaits(p, plans, rank).length) continue;
			const store = claimStoreFor(p.file, cfg);
			const h = store.holder(p.file);
			// heldByOther covers an unreachable server too: the plan is skipped either way.
			if (h !== null && heldByOther(h, me)) continue;
			const c = store.claim(p.file, me);
			if ("unreachable" in c) continue;
			if ("heldBy" in c) continue;
			console.log(`claim: ${p.file} for Main ${me} since ${strftime(c.since, "%H:%M")}`);
			return 0;
		}
		console.error("claim: no free plan (open plans are held by another Main or their team server is unreachable, WAITING on the owner, or waiting on another open plan)");
		return 1;
	}

	if (args[0] === "list") {
		// Each store's holder() applies its own liveness rule (claim_ttl_min), so list and next
		// agree. A team whose list() is Unreachable prints its line and the rest still list.
		const file = fileClaimStore(cfg.paths.queue_state, nowSec, cfg.queue.claim_ttl_min);
		const stores: { store: ClaimStore; team?: TeamEntry }[] = [{ store: file }];
		for (const team of cfg.teams ?? []) stores.push({ store: remoteStoreFor(team, cfg), team });
		const live: Claim[] = [];
		for (const { store, team } of stores) {
			const rows = store.list();
			if (!Array.isArray(rows)) {
				console.error(`claim: team server ${team?.server ?? rows.unreachable} unreachable`);
				continue;
			}
			for (const c of rows) {
				// Compares a listed row with its own live holder, not with this Main; an
				// Unreachable holder only drops its own row.
				const h = store.holder(c.plan);
				if (h !== null && !("unreachable" in h) && h.main === c.main) live.push(c);
			}
		}
		live.sort((a, b) => a.since - b.since || a.plan.localeCompare(b.plan));
		if (!live.length) console.log("claim: no live claims");
		for (const c of live) console.log(`${c.plan} — held by Main ${c.main} since ${strftime(c.since, "%H:%M")}`);
		return 0;
	}

	if (args[0] === "release") {
		const force = args.includes("--force");
		const planArg = args.slice(1).find(a => !a.startsWith("-"));
		if (!planArg) {
			console.error(USAGE);
			return 2;
		}
		const file = path.resolve(planArg);
		const store = claimStoreFor(file, cfg);
		const h = store.holder(file);
		if (!h) {
			console.log(`claim: ${file} is free`);
			return 0;
		}
		if ("unreachable" in h) {
			console.error(`claim: team server ${h.unreachable} unreachable`);
			return 1;
		}
		if (heldByOther(h, me)) {
			if (!force) {
				console.error(`claim: ${file} is held by Main ${h.main} since ${strftime(h.since, "%H:%M")}; freeing another Main's claim needs --force and is the owner's move, in a terminal.`);
				return 1;
			}
			if (h.mine === false) {
				// The server would answer 403 (P2b (7c)): nothing is sent.
				console.error(`claim: ${file} is held by another member's Main; it frees at the TTL or when the admin removes that member`);
				return 1;
			}
		}
		store.release(file, h.main);
		console.log(`claim: released ${file}${h.main !== me ? ` (held by Main ${h.main})` : ""}`);
		return 0;
	}

	console.error(USAGE);
	return 2;
}
