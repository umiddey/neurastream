// Chat notify (plan 20261024_2155): Main's final reply is posted to Discord and/or Slack when a
// session stop hands the turn back to the owner. The webhook URLs live in secret files — the
// config holds only their paths. This module knows the configured paths, keeps every agent away
// from them (guard rules in guards.ts), and does the posting. Plain TypeScript, no harness here.

import { dirname } from "node:path";
import { readFileSync, statSync } from "node:fs";
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

export interface NotifyFindings {
	problems: string[];
	warnings: string[];
}

/** Host fragments that mark a webhook URL pasted straight into the config file, by provider. */
const RAW_URL_LABELS: Record<string, string> = {
	"discord.com/api/webhooks": "discord",
	"discordapp.com/api/webhooks": "discord",
	"hooks.slack.com": "slack",
};

/** Doctor findings for the notify setup: a problem when a secret file is readable by group or
 *  others, when the config file holds a raw webhook URL, or when a secret file sits next to
 *  config.yml; a warning only when a configured secret file is missing (notify is simply off). */
export function notifyFindings(cfg: Config): NotifyFindings {
	const problems: string[] = [];
	const warnings: string[] = [];
	const configPath = configFile(cfg.paths.home);
	const configDir = dirname(configPath);
	let raw = "";
	try {
		raw = readFileSync(configPath, "utf8");
	} catch {}
	const rawLabels = new Set<string>();
	for (const [host, label] of Object.entries(RAW_URL_LABELS)) if (raw.includes(host)) rawLabels.add(label);
	for (const label of rawLabels) {
		problems.push(`notify: ${configPath} holds a raw ${label} webhook URL; anyone holding it can post as the bot — keep it in a secret file`);
	}
	for (const p of notifyProviders(cfg)) {
		const key = `notify.${p.name}_webhook_file`;
		let st;
		try {
			st = statSync(p.file);
		} catch {
			warnings.push(`notify: ${key} points at ${p.file}, which does not exist; notify stays off until the owner writes it`);
			continue;
		}
		if ((st.mode & 0o77) !== 0) {
			problems.push(`notify: ${p.file} is readable by group/others (mode ${(st.mode & 0o777).toString(8)}); chmod 600 it`);
		}
		if (dirname(p.file) === configDir) {
			problems.push(`notify: ${p.file} sits next to ${configPath}; keep the webhook files in their own directory`);
		}
	}
	return { problems, warnings };
}
