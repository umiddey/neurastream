// `neurastream team share|unshare <plan>` (plan 20261027_1305 P1). share writes `Queue: team`
// when the repo's origin matches a teams: glob; unshare removes that line and keeps the file.
// The holder check goes through the claim store the same way claim.ts does (fileClaimStore +
// holder). When team claims are remote, this must use claimStoreFor — a local-only read would
// unshare a plan another member holds. The server upload/delete lands with the team server;
// planShare is the gate that refuses to send a plan without the marker.

import { readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileClaimStore, type ClaimStore } from "../core/claims.ts";
import { nowSec } from "../core/clock.ts";
import { ConfigError, loadConfig, type Config } from "../core/config.ts";
import { mainId } from "../core/guards.ts";
import { defaultRunner, type CommandRunner } from "../core/mr-sweep.ts";
import { headerField, planRepo } from "../core/queue/lib.ts";
import { repoTeam } from "../core/team-labels.ts";

const USAGE = ["usage: neurastream team share <plan>", "       neurastream team unshare <plan>"].join("\n");

/** Header text with `Queue:` set to team, or removed (absent means personal). The first `##` section is kept. */
function withQueue(text: string, value: "team" | null): string {
	const at = text.search(/^## /m);
	const head = at < 0 ? text : text.slice(0, at);
	const tail = at < 0 ? "" : text.slice(at);
	const kept = head.split("\n").filter(line => !/^Queue:\s*\S/.test(line));
	let body = kept.join("\n").replace(/\s*$/, "");
	if (value === "team") body = body === "" ? "Queue: team" : `${body}\nQueue: team`;
	if (tail) return `${body}\n\n${tail}`;
	return body === "" ? "" : `${body}\n`;
}

export function runTeam(args: string[], opts: { cfg?: Config; run?: CommandRunner; store?: ClaimStore } = {}): number {
	const sub = args[0];
	const planArg = args[1];
	if ((sub !== "share" && sub !== "unshare") || !planArg || args.length !== 2) {
		console.error(USAGE);
		return 2;
	}
	let cfg = opts.cfg;
	if (!cfg) {
		try {
			cfg = loadConfig();
		} catch (err) {
			console.error(err instanceof ConfigError ? err.message : String(err));
			return 1;
		}
	}
	const file = path.resolve(planArg);
	let text: string;
	try {
		if (!statSync(file).isFile()) throw new Error("not a file");
		text = readFileSync(file, "utf8");
	} catch {
		console.error(`team ${sub}: ${file} is not a plan file`);
		return 1;
	}
	const run = opts.run ?? defaultRunner;
	if (sub === "share") {
		const team = repoTeam(planRepo(file), cfg, run);
		if (!team) {
			console.error(`team share: ${file} is personal (its origin matches no team); a plan whose repo has no team label is not shared`);
			return 1;
		}
		if (headerField(text, "Queue") === "team") {
			console.log(`team share: ${file} already Queue: team for ${team}`);
			return 0;
		}
		writeFileSync(file, withQueue(text, "team"));
		console.log(`team share: ${file} marked Queue: team for ${team}`);
		return 0;
	}
	if (headerField(text, "Queue") !== "team") {
		console.log(`team unshare: ${file} is already personal`);
		return 0;
	}
	const store = opts.store ?? fileClaimStore(cfg.paths.queue_state, nowSec, cfg.queue.claim_ttl_min);
	const held = store.holder(file);
	const me = mainId();
	if (held && held.main !== me) {
		console.error(`team unshare: ${file} is held by Main ${held.main}; unshare only while you hold the claim, or the plan is unclaimed`);
		return 1;
	}
	writeFileSync(file, withQueue(text, null));
	console.log(`team unshare: ${file} is personal again (local copy kept)`);
	return 0;
}
