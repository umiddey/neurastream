// `neurastream workspace`: serve the owner's phone page on the tailnet address only. Refuses to
// start when the config has the page off or no owner login; the core startOwnerUi enforces the
// same two refusals. Runs until killed (systemd user unit
// templates/systemd/neurastream-workspace.service). `workspace on --login <email> [--port N]` /
// `workspace off` set up and undo that whole setup in one command (the core lives in
// src/core/ui-setup.ts); plain `neurastream workspace` keeps serving as today. The command was
// `neurastream ui` before the workspace rename — no alias: the old name is an unknown command.

import { getAdapter } from "../adapters/index.ts";
import { ConfigError, loadConfig, type Config } from "../core/config.ts";
import { beat, errorLine } from "../core/heartbeat.ts";
import { startOwnerUi, type OwnerUiOptions, type OwnerUiServer } from "../core/owner-ui.ts";
import { applyQueueEnv } from "../core/queue/env.ts";
import { realTailscale, type Tailscale, untilIp4Changes } from "../core/tailscale.ts";
import { systemTerminal, uiOff, uiOn, type Runner } from "../core/ui-setup.ts";

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
}

const WORKSPACE_USAGE = "usage: neurastream workspace [on --login <tailscale login> [--port N] | off]";

// `workspace on|off` argument handling: --login is required for on (exit 1, nothing done without
// it), --port optional; anything else is a usage error (exit 2). No args reaches the serve path.
function runWorkspaceSetup(args: string[], deps: WorkspaceDeps): number {
	const on = args[0] === "on";
	let login: string | undefined;
	let port: number | null = null;
	for (let i = 1; i < args.length; i++) {
		if (on && args[i] === "--login") {
			login = args[i + 1];
			i++;
		} else if (on && args[i] === "--port") {
			const n = Number(args[i + 1]);
			if (!Number.isInteger(n) || n! <= 0 || n! > 65535) {
				console.error(`neurastream workspace on: --port needs a port number (1..65535), got "${args[i + 1] ?? ""}"`);
				return 2;
			}
			port = n;
			i++;
		} else {
			console.error(WORKSPACE_USAGE);
			return 2;
		}
	}
	const setup = { home: deps.home, runner: deps.runner, tailscale: deps.tailscale };
	if (on) {
		if (!login) {
			console.error("neurastream workspace on: --login <tailscale login> is required — e.g. neurastream workspace on --login me@example.com");
			return 1;
		}
		// A question only on a terminal: scripted runs get the message and exit 1, no prompt.
		const terminal = process.stdin.isTTY && process.stdout.isTTY ? systemTerminal : undefined;
		return uiOn({ login, port, terminal, ...setup });
	}
	return uiOff(setup);
}

export async function runWorkspace(args: string[] = [], deps: WorkspaceDeps = {}): Promise<number> {
	if (args[0] === "on" || args[0] === "off") return runWorkspaceSetup(args, deps);
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
