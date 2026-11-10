// `neurastream team share|unshare <plan>` (plan 20261027_1305 P1) and `team sync` (P3). share
// writes `Queue: team` when the repo's origin matches a teams: glob and pushes that one plan;
// unshare removes that line, keeps the file and deletes the plan's sync-record entries. The
// holder check goes through the chooser (claimStoreFor): a local-only read would unshare a plan
// another member holds on the server. planShare is the gate that refuses to send a plan without
// the marker; sync runs only when called — no hook and no heartbeat tick runs it.

import { readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { heldByOther, type ClaimStore } from "../core/claims.ts";
import { ConfigError, loadConfig, type Config } from "../core/config.ts";
import { mainId } from "../core/guards.ts";
import { defaultRunner, type CommandRunner } from "../core/mr-sweep.ts";
import { headerField, planRepo } from "../core/queue/lib.ts";
import { deleteRecordEntries, claimStoreFor, pushTeamPlan, syncTeam, type TeamEntry } from "../core/team-client.ts";
import { repoTeam } from "../core/team-labels.ts";

const USAGE = [
	"usage: neurastream team share <plan>",
	"       neurastream team unshare <plan>",
	"       neurastream team sync [--team <name>]",
].join("\n");

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
	if (sub === "sync") {
		let cfg: Config;
		try {
			cfg = opts.cfg ?? loadConfig();
		} catch (err) {
			console.error(err instanceof ConfigError ? err.message : String(err));
			return 1;
		}
		const run = opts.run ?? defaultRunner;
		const name = args.includes("--team") ? args[args.indexOf("--team") + 1] : undefined;
		const teams = name ? (cfg.teams ?? []).filter(t => t.name === name) : cfg.teams ?? [];
		if (name && !teams.length) {
			console.error(`team sync: no teams: entry named ${name}`);
			return 1;
		}
		for (const team of teams) syncTeam(team, cfg, run);
		return 0;
	}
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
		// P3: share uploads the plan — one plan's push, guarded like every push.
		const entry = (cfg.teams ?? []).find(t => t.name === team) as TeamEntry | undefined;
		if (entry) pushTeamPlan(entry, cfg, file, undefined, run);
		return 0;
	}
	if (headerField(text, "Queue") !== "team") {
		console.log(`team unshare: ${file} is already personal`);
		return 0;
	}
	const store = opts.store ?? claimStoreFor(file, cfg);
	const held = store.holder(file);
	const me = mainId();
	if (held !== null && "unreachable" in held) {
		console.error(`team unshare: team server ${held.unreachable} unreachable`);
		return 1;
	}
	if (held && heldByOther(held, me)) {
		console.error(`team unshare: ${file} is held by Main ${held.main}; unshare only while you hold the claim, or the plan is unclaimed`);
		return 1;
	}
	writeFileSync(file, withQueue(text, null));
	// The record entries go too: the chooser's record rule must not keep routing a plan whose
	// header says personal (that rule would fail open the other way).
	deleteRecordEntries(cfg, file, run);
	console.log(`team unshare: ${file} is personal again (local copy kept)`);
	return 0;
}
