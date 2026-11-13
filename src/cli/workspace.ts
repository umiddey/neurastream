// `neurastream workspace`: serve the owner's phone page on the tailnet address only. Refuses to
// start when the config has the page off or no owner login; the core startOwnerUi enforces the
// same two refusals. Runs until killed (systemd user unit
// templates/systemd/neurastream-workspace.service). `workspace on --login <email> [--port N]` /
// `workspace off` set up and undo that whole setup in one command (the core lives in
// src/core/ui-setup.ts); plain `neurastream workspace` keeps serving as today. The command was
// `neurastream ui` before the workspace rename — no alias: the old name is an unknown command.
// Teams: `workspace on --team <name> --admin <login> --repo <glob>...` sets up one team's queue
// server (its own unit, `workspace --team <name>` serves it); `workspace members` edits a team's
// member list; `workspace off --team <name>` undoes that one team. The team server is the same
// queue the teams use: see src/core/team-server.ts.

import { homedir } from "node:os";
import { getAdapter } from "../adapters/index.ts";
import { ConfigError, loadConfig, type Config } from "../core/config.ts";
import { beat, errorLine } from "../core/heartbeat.ts";
import { startOwnerUi, type OwnerUiOptions, type OwnerUiServer } from "../core/owner-ui.ts";
import { applyQueueEnv } from "../core/queue/env.ts";
import { realTailscale, type Tailscale, untilIp4Changes } from "../core/tailscale.ts";
import { TEAM_NAME_HINT, TEAM_NAME_RE } from "../core/team-labels.ts";
import { addTeamMember, listTeamMembers, removeTeamMember, startTeamServer, type TeamServer, type TeamServerConfig, type TeamServerOptions } from "../core/team-server.ts";
import { PERSONAL, readTeamServerFile, systemTerminal, teamDbPath, uiOff, uiOn, type Runner, type Scope, type TeamServerFile } from "../core/ui-setup.ts";

export interface WorkspaceDeps {
	/** The merged config. Default: loadConfig(). */
	cfg?: Config;
	/** Starts the page. Default: startOwnerUi. */
	start?: (opts: OwnerUiOptions) => OwnerUiServer;
	/** Command runner for `workspace on`/`workspace off` (default: spawnSync of systemctl --user). */
	runner?: Runner;
	/** Tailscale seam for `workspace on` and the serve path (default: realTailscale). */
	tailscale?: Tailscale;
	/** HOME the `workspace on`/`workspace off` config and unit paths resolve against (default: homedir()). */
	home?: string;
	/** How often the serve path checks for a new tailnet address (default: IP4_POLL_MS). */
	ipPollMs?: number;
	/** Starts the team queue server for `workspace --team <name>`. Default: startTeamServer. */
	startTeam?: (opts: TeamServerOptions) => TeamServer;
}

const WORKSPACE_USAGE = "usage: neurastream workspace [on --login <tailscale login> [--port N] | on --team <name> --admin <tailscale login> --repo <glob>... [--port N] | off [--team <name>] | --team <name> | members add|remove <login> --team <name> | members list --team <name>]";

// `workspace on|off` argument handling. Personal: `on --login` (required: exit 1 without it).
// Team: `on --team <name> --admin <login> --repo <glob>...`. Flags that do not fit either form are
// a usage error (exit 2); the core (src/core/ui-setup.ts) decides the rest.
function runWorkspaceSetup(args: string[], deps: WorkspaceDeps): number {
	const on = args[0] === "on";
	const allowed = on ? ["--login", "--team", "--admin", "--repo", "--port"] : ["--team"];
	let login: string | undefined;
	let team: string | undefined;
	let admin: string | undefined;
	const repos: string[] = [];
	let port: number | null = null;
	for (let i = 1; i < args.length; i++) {
		const flag = args[i]!;
		if (!allowed.includes(flag)) {
			console.error(WORKSPACE_USAGE);
			return 2;
		}
		const value = args[i + 1];
		i++;
		if (flag === "--login") login = value;
		else if (flag === "--team") team = value ?? "";
		else if (flag === "--admin") admin = value;
		else if (flag === "--repo") repos.push(value ?? "");
		else {
			const n = Number(value);
			if (!Number.isInteger(n) || n <= 0 || n > 65535) {
				console.error(`neurastream workspace on: --port needs a port number (1..65535), got "${value ?? ""}"`);
				return 2;
			}
			port = n;
		}
	}
	if (team !== undefined && !TEAM_NAME_RE.test(team)) {
		console.error(`neurastream workspace: ${TEAM_NAME_HINT}`);
		return 2;
	}
	// Personal forms take --login only; team forms take --admin and --repo only.
	if (team === undefined ? admin !== undefined || repos.length > 0 : login !== undefined) {
		console.error(WORKSPACE_USAGE);
		return 2;
	}
	const scope: Scope = team === undefined ? PERSONAL : { kind: "team", name: team };
	const setup = { home: deps.home, runner: deps.runner, tailscale: deps.tailscale, scope };
	if (!on) return uiOff(setup);
	if (team === undefined && !login) {
		console.error("neurastream workspace on: --login <tailscale login> is required — e.g. neurastream workspace on --login me@example.com");
		return 1;
	}
	// A question only on a terminal: scripted runs get the message and exit 1, no prompt.
	const terminal = process.stdin.isTTY && process.stdout.isTTY ? systemTerminal : undefined;
	return uiOn({ ...setup, login, admin, repos, port, terminal });
}

export async function runWorkspace(args: string[] = [], deps: WorkspaceDeps = {}): Promise<number> {
	if (args[0] === "on" || args[0] === "off") return runWorkspaceSetup(args, deps);
	if (args[0] === "members") return runMembers(args.slice(1), deps);
	if (args[0] === "--team" && args.length === 2) return serveTeam(args[1]!, deps);
	if (args.length) {
		console.error(WORKSPACE_USAGE);
		return 2;
	}
	let cfg = deps.cfg;
	if (!cfg) {
		try {
			cfg = loadConfig();
		} catch (err) {
			console.error(err instanceof ConfigError ? err.message : String(err));
			return 1;
		}
	}
	applyQueueEnv(cfg);
	if (!cfg.workspace.enabled) {
		console.error("neurastream workspace: workspace.enabled is false — set it in the config first");
		return 1;
	}
	if (!cfg.workspace.owner_login) {
		console.error("neurastream workspace: workspace.owner_login is empty — set the tailscale login that may open the page");
		return 1;
	}
	const tailscale = deps.tailscale ?? realTailscale;
	let server: OwnerUiServer;
	try {
		server = (deps.start ?? startOwnerUi)({ cfg, tailscale, source: getAdapter(cfg).runSource(cfg) });
	} catch (e) {
		beat(cfg, "workspace", { ok: false, detail: errorLine(e) });
		throw e;
	}
	beat(cfg, "workspace", { ok: true });
	// Resolves 1 when the tailnet address moves: src/cli/main.ts exits with it, which would end the
	// server, and systemd restarts it on the new address. Otherwise serving runs until systemd or a signal stops it.
	return untilIp4Changes(tailscale, server.hostname, deps.ipPollMs);
}

type TeamState = { file: TeamServerFile; cfg: Config; config: TeamServerConfig; dbPath: string };

// Reads a team's settings file and the config (the queue database path comes from the config).
// Returns the failure as a message for the user, or the pieces a team command needs.
function readTeam(name: string, deps: WorkspaceDeps): TeamState | string {
	const home = deps.home ?? homedir();
	let file: TeamServerFile | null;
	try {
		file = readTeamServerFile(home, name);
	} catch (err) {
		return `neurastream workspace: ${(err as Error).message}`;
	}
	if (!file) return `neurastream workspace: no team "${name}" on this machine — run neurastream workspace on --team ${name} --admin <tailscale login> --repo <glob> first`;
	let cfg = deps.cfg;
	if (!cfg) {
		try {
			cfg = loadConfig({ home });
		} catch (err) {
			return `neurastream workspace: ${err instanceof ConfigError ? err.message : String(err)}`;
		}
	}
	const config = { team: file.team, admin: file.admin, leader: file.leader, repos: file.repos, members: file.members };
	return { file, cfg, config, dbPath: teamDbPath(cfg, name) };
}

// `workspace --team <name>`: the team's unit runs this. It serves the team queue on the tailnet
// address until the address changes or the unit stops. It writes no heartbeat: beat() feeds the
// personal page's health line, and a team server has no line of its own yet.
async function serveTeam(name: string, deps: WorkspaceDeps): Promise<number> {
	if (!TEAM_NAME_RE.test(name)) {
		console.error(`neurastream workspace: ${TEAM_NAME_HINT}`);
		return 2;
	}
	const state = readTeam(name, deps);
	if (typeof state === "string") {
		console.error(state);
		return 1;
	}
	applyQueueEnv(state.cfg);
	const tailscale = deps.tailscale ?? realTailscale;
	let server: TeamServer;
	try {
		server = (deps.startTeam ?? startTeamServer)({
			tailscale,
			config: state.config,
			dbPath: state.dbPath,
			port: state.file.port,
			claimTtlMin: state.cfg.queue.claim_ttl_min,
		});
	} catch (err) {
		console.error(`neurastream workspace: ${(err as Error).message}`);
		return 1;
	}
	return untilIp4Changes(tailscale, server.hostname, deps.ipPollMs);
}

// `workspace members add|remove <login> --team <name>` and `workspace members list --team <name>`:
// the admin's changes go straight to the team's queue database, the same as the team server's own
// member routes. Both refuse until the team has started once.
function runMembers(args: string[], deps: WorkspaceDeps): number {
	const sub = args[0];
	const at = args.indexOf("--team");
	const name = at >= 1 ? args[at + 1] : undefined;
	const positional = args.filter((_, i) => i !== 0 && i !== at && i !== at + 1);
	const wantsLogin = sub === "add" || sub === "remove";
	if (name === undefined || !(sub === "list" || wantsLogin) || positional.length !== (sub === "list" ? 0 : 1)) {
		console.error(WORKSPACE_USAGE);
		return 2;
	}
	if (!TEAM_NAME_RE.test(name)) {
		console.error(`neurastream workspace: ${TEAM_NAME_HINT}`);
		return 2;
	}
	const state = readTeam(name, deps);
	if (typeof state === "string") {
		console.error(state);
		return 1;
	}
	if (sub === "list") {
		for (const login of listTeamMembers(state.dbPath)) console.log(login);
		return 0;
	}
	const login = positional[0]!;
	if (sub === "add") {
		const r = addTeamMember(state.dbPath, state.config, login);
		if (!r.ok) {
			console.error(`neurastream workspace members: ${r.error}`);
			return 1;
		}
		console.log(r.added ? `added ${login} to team ${name}` : `${login} is already a member of team ${name}`);
		return 0;
	}
	const r = removeTeamMember(state.dbPath, state.config, login);
	if (!r.ok) {
		console.error(`neurastream workspace members: ${r.error}`);
		return 1;
	}
	console.log(`removed ${login} from team ${name}; freed ${r.claimsFreed} claim(s)`);
	return 0;
}
