// `neurastream ui`: serve the owner's phone page on the tailnet address only. Refuses to start
// when the config has the page off or no owner login; the core startOwnerUi enforces the same
// two refusals. Runs until killed (systemd user unit templates/systemd/neurastream-ui.service).

import { defaultRunSource } from "../adapters/omp/sessions.ts";
import { ConfigError, loadConfig } from "../core/config.ts";
import { startOwnerUi } from "../core/owner-ui.ts";
import { applyQueueEnv } from "../core/queue/env.ts";
import { realTailscale } from "../core/tailscale.ts";

export function runUi(): number {
	let cfg;
	try {
		cfg = loadConfig();
	} catch (err) {
		console.error(err instanceof ConfigError ? err.message : String(err));
		return 1;
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
	startOwnerUi({ cfg, tailscale: realTailscale, source: defaultRunSource(cfg) });
	return 0; // serving never returns; the process runs until killed
}
