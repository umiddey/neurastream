// `neurastream claim` (plan 20261027_1300 P4): picking work across several Mains over one queue.
// `next` claims the highest free plan in index order with the queue's own skip rules — open only,
// not WAITING on the owner, not waiting on another open plan (the queueSummary waits-on rule), not
// held by another live Main; `list` prints the live claims; `release <plan>` frees this Main's
// claim and `--force` frees another Main's, refused for agents by the guard (the owner runs it in
// a terminal).
import path from "node:path";
import { fileClaimStore } from "../core/claims.ts";
import { nowSec, strftime } from "../core/clock.ts";
import { mainId } from "../core/guards.ts";
import { applyQueueEnv } from "../core/queue/env.ts";
import { activePlans, openWaits } from "../core/queue/lib.ts";
import type { Config } from "../core/config.ts";

const USAGE = [
	"usage: neurastream claim next",
	"       neurastream claim list",
	"       neurastream claim release <plan> [--force]",
].join("\n");

export function claimCli(args: string[], cfg: Config): number {
	applyQueueEnv(cfg);
	const store = fileClaimStore(cfg.paths.queue_state, nowSec, cfg.queue.claim_ttl_min);
	const me = mainId();

	if (args[0] === "next") {
		// Index order IS priority; the skips are queueSummary's flags minus plans another live
		// Main holds. A claim that races away mid-loop just moves the pick to the next plan.
		const plans = activePlans();
		const rank = new Map(plans.map((p, i) => [p.file, i + 1] as const));
		for (const p of plans) {
			if (p.status !== "open" || p.waiting || openWaits(p, plans, rank).length) continue;
			const h = store.holder(p.file);
			if (h && h.main !== me) continue;
			const c = store.claim(p.file, me);
			if ("heldBy" in c) continue;
			console.log(`claim: ${p.file} for Main ${me} since ${strftime(c.since, "%H:%M")}`);
			return 0;
		}
		console.error("claim: no free plan (open plans are held by another Main, WAITING on the owner, or waiting on another open plan)");
		return 1;
	}

	if (args[0] === "list") {
		// holder() applies the store's own liveness rule (claim_ttl_min), so list and next agree.
		const live = store
			.list()
			.filter(c => store.holder(c.plan)?.main === c.main)
			.toSorted((a, b) => a.since - b.since || a.plan.localeCompare(b.plan));
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
		const h = store.holder(file);
		if (!h) {
			console.log(`claim: ${file} is free`);
			return 0;
		}
		if (h.main !== me && !force) {
			console.error(`claim: ${file} is held by Main ${h.main} since ${strftime(h.since, "%H:%M")}; freeing another Main's claim needs --force and is the owner's move, in a terminal.`);
			return 1;
		}
		store.release(file, h.main);
		console.log(`claim: released ${file}${h.main !== me ? ` (held by Main ${h.main})` : ""}`);
		return 0;
	}

	console.error(USAGE);
	return 2;
}
