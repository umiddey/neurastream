// `neurastream team share|unshare <plan>` (plan 20261027_1305 P1) and `team sync` (P3). share
// writes `Queue: team` when the repo's origin matches a teams: glob and pushes that one plan;
// unshare removes that line, keeps the file and deletes the plan's sync-record entries. The
// holder check goes through the chooser (claimStoreFor): a local-only read would unshare a plan
// another member holds on the server. planShare is the gate that refuses to send a plan without
// the marker; sync runs only when called — no hook and no heartbeat tick runs it.
// `team join <url> --name <name> --repo <glob>...` and `team leave <name>` (P6) add and remove one
// teams: entry in the config. join asks the server for its view first and writes nothing when the
// server does not answer this login (down, or not a member).

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { heldByOther, type ClaimStore } from "../core/claims.ts";
import { ConfigError, configFile, loadConfig, type Config } from "../core/config.ts";
import { setConfigKeys } from "../core/config-edit.ts";
import { mainId } from "../core/guards.ts";
import { defaultRunner, type CommandRunner } from "../core/mr-sweep.ts";
import { headerField, planRepo } from "../core/queue/lib.ts";
import { deleteRecordEntries, claimStoreFor, pushTeamPlan, syncTeam, teamViews, type TeamEntry } from "../core/team-client.ts";
import { TEAM_NAME_HINT, TEAM_NAME_RE, repoTeam, teamConfigError } from "../core/team-labels.ts";

const USAGE = [
	"usage: neurastream team share <plan>",
	"       neurastream team unshare <plan>",
	"       neurastream team sync [--team <name>]",
	"       neurastream team join <url> --name <name> --repo <glob>...",
	"       neurastream team leave <name>",
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

export function runTeam(args: string[], opts: { cfg?: Config; run?: CommandRunner; store?: ClaimStore; home?: string; send?: ViewSend } = {}): number {
	const sub = args[0];
	if (sub === "join" || sub === "leave") return runJoinLeave(args, opts);
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

// Writes the teams: list into the config file and keeps every other key as it is.
function writeTeamsKey(home: string, teams: TeamEntry[]): void {
	const file = configFile(home);
	mkdirSync(path.dirname(file), { recursive: true });
	const text = existsSync(file) ? readFileSync(file, "utf8") : null;
	writeFileSync(file, setConfigKeys(text, { teams: JSON.stringify(teams) }));
}

// `team join` adds one teams: entry; `team leave` removes it. join asks the server for its view
// before it writes: an unreachable server, or one that refuses this login, writes nothing. The repo
// globs are the admin's and come from the command line. leave leaves this machine's plan files alone.
// The probe's transport: the team-client seam, so tests stub the server's answer.
type ViewSend = NonNullable<Parameters<typeof teamViews>[1]>["send"];
function runJoinLeave(args: string[], opts: { cfg?: Config; home?: string; send?: ViewSend }): number {
	const sub = args[0];
	const rest = args.slice(1);
	const home = opts.home ?? homedir();
	let cfg = opts.cfg;
	if (!cfg) {
		try {
			cfg = loadConfig({ home });
		} catch (err) {
			console.error(err instanceof ConfigError ? err.message : String(err));
			return 1;
		}
	}
	const teams = cfg.teams ?? [];
	if (sub === "leave") {
		const name = rest[0];
		if (!name || rest.length !== 1) {
			console.error(USAGE);
			return 2;
		}
		if (!teams.some(t => t.name === name)) {
			console.error(`team leave: no teams: entry named ${name}`);
			return 1;
		}
		writeTeamsKey(home, teams.filter(t => t.name !== name));
		console.log(`team leave: ${name} removed from teams:`);
		return 0;
	}
	const url = rest[0];
	let name: string | undefined;
	const repos: string[] = [];
	for (let i = 1; i < rest.length; i++) {
		if (rest[i] === "--name") name = rest[++i];
		else if (rest[i] === "--repo") repos.push(rest[++i] ?? "");
		else {
			console.error(USAGE);
			return 2;
		}
	}
	if (!url || name === undefined || repos.length === 0) {
		console.error(USAGE);
		return 2;
	}
	if (!TEAM_NAME_RE.test(name)) {
		console.error(`team join: ${TEAM_NAME_HINT}`);
		return 2;
	}
	if (teams.some(t => t.name === name)) {
		console.error(`team join: a teams: entry named ${name} already exists`);
		return 1;
	}
	const candidate: TeamEntry = { name, server: url.replace(/\/+$/, ""), repos };
	const err = teamConfigError([candidate]);
	if (err) {
		console.error(`team join: ${err}`);
		return 1;
	}
	const view = teamViews({ ...cfg, teams: [candidate] }, { send: opts.send }).get(name);
	if (!view || "unreachable" in view) {
		console.error(`team join: ${candidate.server} did not return the team view for this login — it is down, or this login is not a member; nothing was written`);
		return 1;
	}
	writeTeamsKey(home, [...teams, candidate]);
	console.log(`team join: ${name} added to teams: (${candidate.server})`);
	return 0;
}
