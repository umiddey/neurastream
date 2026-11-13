// `neurastream team share|unshare <plan>` (plan 20261027_1305 P1) and `team sync` (P3). share
// writes `Queue: team` when the repo's origin matches a teams: glob and pushes that one plan;
// unshare removes that line, keeps the file and deletes the plan's sync-record entries. The
// holder check goes through the chooser (claimStoreFor): a local-only read would unshare a plan
// another member holds on the server. planShare is the gate that refuses to send a plan without
// the marker; sync runs only when called — no hook and no heartbeat tick runs it.
// `team join <url> --name <name> --repo <glob>...` and `team leave <name>` (P6) add and remove one
// teams: entry in the config. join asks the server for its view first and writes nothing when the
// server does not answer this login (down, or not a member).
// `team pause <name>` and `team resume <name>` (P6b1): pause stops this login's claims on the team, and also gives up this Main's own claims there (see pauseTeam). resume only lifts the stop.

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { heldByOther, type ClaimStore } from "../core/claims.ts";
import { nowSec, strftime } from "../core/clock.ts";
import { ConfigError, configFile, loadConfig, type Config } from "../core/config.ts";
import { setConfigKeys } from "../core/config-edit.ts";
import { mainId } from "../core/guards.ts";
import { defaultRunner, type CommandRunner } from "../core/mr-sweep.ts";
import { headerField, planRepo } from "../core/queue/lib.ts";
import { deleteRecordEntries, claimStoreFor, postTeamPause, pushTeamPlan, recordPath, releaseTeamClaim, sameGoalCheck, syncTeam, teamViews, type TeamEntry } from "../core/team-client.ts";
import { TEAM_NAME_HINT, TEAM_NAME_RE, repoTeam, teamConfigError } from "../core/team-labels.ts";

const USAGE = [
	"usage: neurastream team share <plan> [--distinct \"<reason>\"]",
	"       neurastream team unshare <plan>",
	"       neurastream team sync [--team <name>]",
	"       neurastream team join <url> --name <name> --repo <glob>...",
	"       neurastream team leave <name>",
	"       neurastream team pause <name>",
	"       neurastream team resume <name>",
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
	if (sub === "pause" || sub === "resume") return runPause(args, opts);
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
	const distinctAt = args.indexOf("--distinct");
	const distinct = distinctAt === -1 ? undefined : args[distinctAt + 1];
	const shaped = distinctAt === -1 ? args.length === 2 : sub === "share" && distinctAt === 2 && args.length === 4;
	if ((sub !== "share" && sub !== "unshare") || !planArg || !shaped) {
		console.error(USAGE);
		return 2;
	}
	if (distinct !== undefined && (distinct.trim() === "" || distinct.length > 200)) {
		console.error("team share: --distinct needs a reason of 1 to 200 characters");
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
		const entry = (cfg.teams ?? []).find(t => t.name === team) as TeamEntry | undefined;
		// P6b2 rule a: a plan with the same goal as a plan or MR already in the team is refused unless --distinct gives a reason.
		if (entry && distinct === undefined) {
			const check = sameGoalCheck(entry, cfg, file, text, run, { send: opts.send });
			if ("refused" in check) {
				console.error(`team share: ${file} refused: ${check.refused}; pass --distinct "<reason>" to share anyway`);
				return 1;
			}
			if (check.overlaps.length) {
				console.error(`team share: ${file} has the same goal as:`);
				for (const o of check.overlaps) console.error(`  ${o.item} (overlap ${o.score.toFixed(2)})`);
				console.error(`team share: refused; pass --distinct "<reason>" if this plan's goal is distinct`);
				return 1;
			}
		}
		writeFileSync(file, withQueue(text, "team"));
		console.log(`team share: ${file} marked Queue: team for ${team}`);
		// P3: share uploads the plan — one plan's push, guarded like every push.
		if (entry) pushTeamPlan(entry, cfg, file, undefined, run, distinct);
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

/** The text with `line` as the last line of its `## Progress` section, or in a new section at the end when the plan has none. */
function withProgress(text: string, line: string): string {
	const lines = text.replace(/\s*$/, "").split("\n");
	const head = lines.findIndex(l => /^## Progress\s*$/.test(l));
	if (head < 0) return `${lines.join("\n")}\n\n## Progress\n${line}\n`;
	let end = lines.findIndex((l, i) => i > head && l.startsWith("## "));
	if (end < 0) end = lines.length;
	let last = end - 1;
	while (last > head && lines[last]?.trim() === "") last--;
	lines.splice(last + 1, 0, line);
	return `${lines.join("\n")}\n`;
}

/** `team pause <name>` stops this login's claims on the team; it then gives up this Main's own claims there: each plan with a local copy the sync record names gets a Progress line, is pushed, and its claim is released by id. `team resume` only lifts the stop. */
export function pauseTeam(team: TeamEntry, cfg: Config, paused: boolean, opts: { run?: CommandRunner; send?: ViewSend } = {}): number {
	const sent = postTeamPause(team, paused, { send: opts.send });
	if (!sent.ok) {
		console.error(`team ${paused ? "pause" : "resume"}: ${sent.error}`);
		return 1;
	}
	if (!paused) {
		console.log(`team resume: ${team.name} open to this member again`);
		return 0;
	}
	const view = teamViews({ ...cfg, teams: [team] }, { send: opts.send }).get(team.name);
	if (!view || "unreachable" in view) {
		console.error(`team pause: ${team.name} is paused on the server, but its claims could not be read; none were released`);
		return 1;
	}
	const me = mainId();
	const run = opts.run ?? defaultRunner;
	for (const claim of view.claims.filter(c => c.mine && c.main === me)) {
		const file = recordPath(cfg, team, claim.plan);
		if (file && existsSync(file)) {
			const stamp = strftime(nowSec(), "%Y-%m-%d %H:%M");
			const next = withProgress(readFileSync(file, "utf8"), `- ${stamp} ${me}: team ${team.name} paused by this member; claim released.`);
			const tmp = `${file}.${process.pid}.tmp`;
			writeFileSync(tmp, next);
			renameSync(tmp, file);
			pushTeamPlan(team, cfg, file, next, run);
		}
		releaseTeamClaim(team, claim.plan, me, { send: opts.send });
		console.log(`team pause: released ${claim.plan} (${team.name})`);
	}
	console.log(`team pause: ${team.name} paused for this member`);
	return 0;
}

/** `team pause|resume <name>`: looks up the named teams: entry, then runs pauseTeam. */
function runPause(args: string[], opts: { cfg?: Config; run?: CommandRunner; send?: ViewSend }): number {
	const sub = args[0];
	const name = args[1];
	if (!name || args.length !== 2) {
		console.error(USAGE);
		return 2;
	}
	let cfg: Config;
	try {
		cfg = opts.cfg ?? loadConfig();
	} catch (err) {
		console.error(err instanceof ConfigError ? err.message : String(err));
		return 1;
	}
	const team = (cfg.teams ?? []).find(t => t.name === name) as TeamEntry | undefined;
	if (!team) {
		console.error(`team ${sub}: no teams: entry named ${name}`);
		return 1;
	}
	return pauseTeam(team, cfg, sub === "pause", opts);
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
