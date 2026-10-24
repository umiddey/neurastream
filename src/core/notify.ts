// Chat notify (plan 20261024_2155): Main's final reply is posted to Discord and/or Slack when a
// session stop hands the turn back to the owner. The webhook URLs live in secret files — the
// config holds only their paths. This module knows the configured paths, keeps every agent away
// from them (guard rules in guards.ts), and does the posting. Plain TypeScript, no harness here.

import { dirname } from "node:path";
import { configFile, type Config } from "./config.ts";

export type NotifyProviderName = "discord" | "slack";

export interface NotifyProvider {
	name: NotifyProviderName;
	/** Path of the secret file holding this provider's webhook URL. */
	file: string;
}

/** The configured providers in posting order; a provider is on when its file path is non-empty. */
export function notifyProviders(cfg: Config): NotifyProvider[] {
	const out: NotifyProvider[] = [];
	if (cfg.notify.discord_webhook_file) out.push({ name: "discord", file: cfg.notify.discord_webhook_file });
	if (cfg.notify.slack_webhook_file) out.push({ name: "slack", file: cfg.notify.slack_webhook_file });
	return out;
}

/** The configured secret files (paths only; contents are read at post time, never cached). */
export function notifySecretFiles(cfg: Config): string[] {
	return notifyProviders(cfg).map(p => p.file);
}

/** Writes that change a notify secret or the config file itself need the owner's unlock. */
export function notifyProtectedPaths(cfg: Config): string[] {
	return [configFile(cfg.paths.home), ...notifySecretFiles(cfg)];
}

const GLOB_META = /[*?[]/;

function hitsSecret(p: string, file: string): boolean {
	const dir = dirname(file);
	if (p === file || p === dir || p.startsWith(`${dir}/`)) return true;
	const m = GLOB_META.exec(p);
	if (!m) return false;
	const base = p.slice(0, m.index).replace(/\/+$/, "");
	if (!base) return false;
	// The glob's literal prefix is the secrets dir, sits inside it, or is an ancestor of it:
	// every match it can name is a secret (or reveals the directory listing).
	return base === dir || base.startsWith(`${dir}/`) || dir.startsWith(`${base}/`);
}

/** The first touched read path that hits a configured secret file, its directory, or a glob over
 *  them; null otherwise. Refused with or without the guard unlock: no agent ever needs a webhook
 *  URL. Reading the config file itself and other files beside the secrets stays allowed. */
export function notifySecretReadHit(paths: string[], cfg: Config): string | null {
	for (const p of paths) {
		for (const file of notifySecretFiles(cfg)) {
			if (hitsSecret(p, file)) return p;
		}
	}
	return null;
}
