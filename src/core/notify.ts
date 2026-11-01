// Chat notify (plan 20261024_2155): Main's final reply is posted to Discord and/or Slack when a
// session stop hands the turn back to the owner. The webhook URLs live in secret files — the
// config holds only their paths. This module knows the configured paths, keeps every agent away
// from them (guard rules in guards.ts), and does the posting. Plain TypeScript, no harness here.

import { dirname } from "node:path";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { configFile, type Config } from "./config.ts";
import { mainId } from "./guards.ts";
import { strftime } from "./clock.ts";
import { recentOwnerMessages, type MessageRow } from "./owner-ui.ts";
import { stateDirPath } from "./queue/lib.ts";
import { loadKnownSecrets, redactSecrets } from "./secret-redact.ts";

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
	// The glob's literal prefix is the secrets dir or sits inside it: every match it can name is a
	// secret (or reveals the directory listing).
	if (base && (base === dir || base.startsWith(`${dir}/`))) return true;
	// P5g: a wider glob refuses only when it actually matches a secret file or the secrets dir
	// (Bun.Glob, filesystem-free, asked once per secret file and once per its directory), never
	// by its prefix alone — a home-wide glob hunting an unrelated folder passes, and the cost
	// stays bounded by the number of secret files, not by what the glob would expand to.
	return new Bun.Glob(p).match(file) || new Bun.Glob(p).match(dir);
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

// --- posting ---

const DISCORD_LIMIT = 2000;
const SLACK_LIMIT = 3000;
const POST_TIMEOUT_MS = 5000;

export interface NotifyPostResult {
	provider: NotifyProviderName;
	/** True when every chunk of the reply got a 2xx answer. */
	posted: boolean;
	chunks: number;
	/** Why nothing (or not everything) was posted; empty on success. */
	error: string;
}

/** https, or a loopback http URL (local fakes and self-tests): a real webhook URL is always https. */
function postableUrl(url: string): boolean {
	if (url.startsWith("https://")) return true;
	return /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])([:/?]|$)/.test(url);
}

/** Split within the provider's limit on line boundaries where possible; a run of text longer than
 *  the limit is hard-split, so nothing is ever lost. */
export function notifyChunks(text: string, limit: number): string[] {
	if (text.length <= limit) return [text];
	const out: string[] = [];
	let rest = text;
	while (rest.length > limit) {
		const nl = rest.lastIndexOf("\n", limit - 1);
		const cut = nl > 0 ? nl + 1 : limit;
		out.push(rest.slice(0, cut));
		rest = rest.slice(cut);
	}
	if (rest.length > 0) out.push(rest);
	return out;
}

function webhookUrl(p: NotifyProvider): { url: string; why: string } {
	let raw = "";
	try {
		raw = readFileSync(p.file, "utf8").trim();
	} catch (err) {
		return { url: "", why: `cannot read ${p.file}: ${err instanceof Error ? err.message : String(err)}` };
	}
	if (raw === "") return { url: "", why: `${p.file} is empty` };
	if (!postableUrl(raw)) return { url: "", why: `${p.file} does not hold an https webhook URL` };
	return { url: raw, why: "" };
}

async function postChunks(provider: NotifyProvider, url: string, chunks: string[]): Promise<NotifyPostResult> {
	const key = provider.name === "discord" ? "content" : "text";
	for (const [i, chunk] of chunks.entries()) {
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				const r = await fetch(url, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ [key]: chunk }),
					signal: AbortSignal.timeout(POST_TIMEOUT_MS),
				});
				if (r.ok) break;
				if (r.status === 429 && attempt === 0) {
					let retryAfter: number | undefined;
					try {
						const body: unknown = await r.clone().json();
						if (body && typeof body === "object" && "retry_after" in body && typeof body.retry_after === "number") retryAfter = body.retry_after;
					} catch {}
					if (retryAfter === undefined) {
						const rawHeader = r.headers.get("retry-after");
						const header = rawHeader === null ? Number.NaN : Number(rawHeader);
						if (Number.isFinite(header) && header >= 0) retryAfter = header;
					}
					const { promise, resolve } = Promise.withResolvers<void>();
					setTimeout(resolve, Math.min(retryAfter ?? 1, 10) * 1000);
					await promise;
					continue;
				}
				return { provider: provider.name, posted: false, chunks: i + 1, error: `${provider.name} answered ${r.status} on chunk ${i + 1}/${chunks.length}` };
			} catch (err) {
				return { provider: provider.name, posted: false, chunks: i + 1, error: `${provider.name} chunk ${i + 1}/${chunks.length} failed: ${err instanceof Error ? err.message : String(err)}` };
			}
		}
	}
	return { provider: provider.name, posted: true, chunks: chunks.length, error: "" };
}

let postQueue: Promise<void> = Promise.resolve();
const enqueuePost = <T>(operation: () => Promise<T>): Promise<T> => {
	const result = postQueue.then(operation);
	postQueue = result.then(() => undefined, () => undefined);
	return result;
}

/** Post Main's final reply to every configured provider, serially across calls. 429s retry once
 *  after Discord's requested delay (capped at 10 seconds); other failures return to the caller. */
export function postReply(text: string, cfg: Config): Promise<NotifyPostResult[]> {
	return enqueuePost(async () => {
		const providers = notifyProviders(cfg);
		const body = cfg.notify.prefix ? `${cfg.notify.prefix} [${mainId()}] ${text}` : `[${mainId()}] ${text}`;
		if (body.trim() === "") return providers.map(p => ({ provider: p.name, posted: false, chunks: 0, error: "empty reply; nothing posted" }));
		// The chat is where a secret does its damage (plan 20261025_2204): a reply can carry a value
		// the owner pasted or one the redactor's tool_result pass never saw, so the post is scrubbed
		// here too, after the prefix and before the split.
		const scrubbed = cfg.secrets.redact ? redactSecrets(body, loadKnownSecrets(cfg), cfg.secrets.extra_patterns).text : body;
		const out: NotifyPostResult[] = [];
		for (const p of providers) {
			const { url, why } = webhookUrl(p);
			if (url === "") {
				out.push({ provider: p.name, posted: false, chunks: 0, error: why });
				continue;
			}
			const limit = p.name === "discord" ? DISCORD_LIMIT : SLACK_LIMIT;
			out.push(await postChunks(p, url, notifyChunks(scrubbed, limit)));
		}
		return out;
	});
}

// ---- Owner answer steer (plan 20261027_1430 P9): a phone-page owner message must be answered
// by the next hand-back within notify.answer_within_min. The rule is host-neutral: core decides
// who is waiting and keeps the once-per-message markers; the harness adapter injects the steer
// at its tool_result hook and records the hand-back at its turn end. The markers live in a file
// under the queue state, not in session memory: one-shot CLI calls and a reloaded plugin must
// agree, like the guard window file.

function ownerAnswerStatePath(): string {
	return `${stateDirPath()}/owner-answer.json`;
}

interface OwnerAnswerState {
	/** Unix seconds of the last hand-back; a message older than this was answered by it. */
	lastHandBack: number;
	/** Message ids this turn already steered, so a message steers once per turn. */
	steered: string[];
}

function readOwnerAnswerState(): OwnerAnswerState {
	try {
		const s = JSON.parse(readFileSync(ownerAnswerStatePath(), "utf8")) as Partial<OwnerAnswerState>;
		return {
			lastHandBack: Number(s.lastHandBack) || 0,
			steered: Array.isArray(s.steered) ? s.steered.filter((x): x is string => typeof x === "string") : [],
		};
	} catch {
		return { lastHandBack: 0, steered: [] };
	}
}

function writeOwnerAnswerState(state: OwnerAnswerState): void {
	mkdirSync(stateDirPath(), { recursive: true });
	writeFileSync(ownerAnswerStatePath(), `${JSON.stringify(state)}\n`);
}

/** Phone-page owner messages waiting past notify.answer_within_min with no hand-back after them; none when the limit is 0. */
export function waitingOwnerMessages(cfg: Config, now: number): MessageRow[] {
	const limit = cfg.notify.answer_within_min * 60;
	if (!(limit > 0)) return [];
	const { lastHandBack } = readOwnerAnswerState();
	return recentOwnerMessages(now).filter((m) => now - m.ts > limit && m.ts > lastHandBack);
}

/** The steer for every waiting message this turn has not steered yet — one line per message, so
 * each owner ask lands once — or null when nobody is waiting. Marks the messages steered. */
export function ownerAnswerSteer(cfg: Config, now: number): string | null {
	const limit = cfg.notify.answer_within_min * 60;
	if (!(limit > 0)) return null;
	const state = readOwnerAnswerState();
	const due = recentOwnerMessages(now).filter((m) => now - m.ts > limit && m.ts > state.lastHandBack && !state.steered.includes(m.id));
	if (due.length === 0) return null;
	state.steered.push(...due.map((m) => m.id));
	writeOwnerAnswerState(state);
	return due.map((m) => `Owner asked at ${strftime(m.ts, "%H:%M")}; end your turn with the answer now`).join("\n");
}

/** A hand-back ends the wait: the reply just posted answers whatever waited, so the wait clears
 * and the next owner message starts fresh. */
export function ownerAnswerHandback(now: number): void {
	writeOwnerAnswerState({ lastHandBack: now, steered: [] });
}
