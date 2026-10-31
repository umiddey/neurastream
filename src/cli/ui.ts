// `neurastream ui`: serve the owner's phone page on the tailnet address only. Refuses to start
// when the config has the page off or no owner login; the core startOwnerUi enforces the same
// two refusals. Runs until killed (systemd user unit templates/systemd/neurastream-ui.service).
// `ui on --login <email> [--port N]` / `ui off` set up and undo that whole setup in one command
// (the core lives in src/core/ui-setup.ts); plain `neurastream ui` keeps serving as today.

import { getAdapter } from "../adapters/index.ts";
import { ConfigError, loadConfig, type Config } from "../core/config.ts";
import { startOwnerUi, type OwnerUiOptions, type OwnerUiServer } from "../core/owner-ui.ts";
import { applyQueueEnv } from "../core/queue/env.ts";
import { realTailscale, type Tailscale } from "../core/tailscale.ts";
import { systemTerminal, uiOff, uiOn, type Runner } from "../core/ui-setup.ts";

export interface UiDeps {
	/** The merged config. Default: loadConfig(). */
	cfg?: Config;
	/** Starts the page. Default: startOwnerUi. */
	start?: (opts: OwnerUiOptions) => OwnerUiServer;
	/** Command runner for `ui on`/`ui off` (default: spawnSync of systemctl --user). */
	runner?: Runner;
	/** Tailscale seam for `ui on` (default: realTailscale). */
	tailscale?: Tailscale;
	/** HOME the `ui on`/`ui off` config and unit paths resolve against (default: homedir()). */
	home?: string;
}

const UI_USAGE = "usage: neurastream ui [on --login <tailscale login> [--port N] | off]";

// `ui on|off` argument handling: --login is required for on (exit 1, nothing done without it),
// --port optional; anything else is a usage error (exit 2). No args reaches the serve path.
function runUiSetup(args: string[], deps: UiDeps): number {
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
				console.error(`neurastream ui on: --port needs a port number (1..65535), got "${args[i + 1] ?? ""}"`);
				return 2;
			}
			port = n;
			i++;
		} else {
			console.error(UI_USAGE);
			return 2;
		}
	}
	const setup = { home: deps.home, runner: deps.runner, tailscale: deps.tailscale };
	if (on) {
		if (!login) {
			console.error("neurastream ui on: --login <tailscale login> is required — e.g. neurastream ui on --login me@example.com");
			return 1;
		}
		// A question only on a terminal: scripted runs get the message and exit 1, no prompt.
		const terminal = process.stdin.isTTY && process.stdout.isTTY ? systemTerminal : undefined;
		return uiOn({ login, port, terminal, ...setup });
	}
	return uiOff(setup);
}

export async function runUi(args: string[] = [], deps: UiDeps = {}): Promise<number> {
	if (args[0] === "on" || args[0] === "off") return runUiSetup(args, deps);
	if (args.length) {
		console.error(UI_USAGE);
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
	if (!cfg.ui.enabled) {
		console.error("neurastream ui: ui.enabled is false — set it in the config first");
		return 1;
	}
	if (!cfg.ui.owner_login) {
		console.error("neurastream ui: ui.owner_login is empty — set the tailscale login that may open the page");
		return 1;
	}
	(deps.start ?? startOwnerUi)({ cfg, tailscale: realTailscale, source: getAdapter(cfg).runSource(cfg) });
	// src/cli/main.ts exits with the code this returns, which would kill the server: serving
	// never resolves, and the process runs until systemd or a signal stops it.
	return new Promise<number>(() => {});
}
