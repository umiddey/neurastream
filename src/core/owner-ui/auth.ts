// Owner UI authentication, DNS-rebinding/Origin guards, CSP, form parsing, and response helpers.

import { nowSec, strftime } from "../clock.ts";
import type { Config } from "../config.ts";
import type { Tailscale } from "../tailscale.ts";

export const ANSWER_MAX = 2000;
/** The page's tabs, in pill order; anything else in `?tab=` renders Now. */
export const TABS: [string, string][] = [["now", "Now"], ["queue", "Queue"], ["agents", "Agents"], ["spend", "Spend"], ["knowledge", "Base"], ["results", "Results"]];
export const TAB_IDS = TABS.map(([id]) => id);
// Tailscale hands out addresses from 100.64.0.0/10 (CGNAT) and its own ULA /48 for IPv6.
const TAILNET6 = /^fd7a:115c:a1e0:/i;

/** The slice of Bun's server the page needs: the peer address of a request. Bun.serve's return satisfies it. */
export interface UiHttpServer {
	requestIP(req: Request): { address: string; family: string; port: number } | null;
}

export type Auth = { ok: true; login: string } | { ok: false; why: string };

export function isLoopback(peer: string): boolean {
	return peer === "::1" || peer === "localhost" || peer.startsWith("127.");
}

export function isTailnet(peer: string): boolean {
	const v4 = /^(\d+)\.(\d+)\./.exec(peer);
	if (v4) return v4[1] === "100" && Number(v4[2]) >= 64 && Number(v4[2]) <= 127;
	return TAILNET6.test(peer);
}

/** Serve only the owner's phone: a tailnet peer that is not this machine and not loopback, whose tailscale whois login equals workspace.owner_login. Everything else is a 403. With `workspace.allow_this_machine`, this machine itself (loopback and its own tailnet IP) is served as the owner too — any local process can then press the buttons. */
export function authenticate(cfg: Config, tailscale: Tailscale, peer: string): Auth {
	if (!cfg.workspace.owner_login) return { ok: false, why: "workspace.owner_login is empty" };
	if (cfg.workspace.allow_this_machine && (isLoopback(peer) || peer === tailscale.ip4())) return { ok: true, login: cfg.workspace.owner_login };
	if (isLoopback(peer)) return { ok: false, why: "loopback peer" };
	if (!isTailnet(peer)) return { ok: false, why: "peer is not a tailnet address" };
	if (peer === tailscale.ip4()) return { ok: false, why: "this machine's own tailnet address" };
	const login = tailscale.whois(peer);
	if (!login) return { ok: false, why: "tailscale whois failed" };
	if (login !== cfg.workspace.owner_login) return { ok: false, why: "not the owner's login" };
	return { ok: true, login };
}

/**
 * DNS-rebinding guard, built once per server. A page on another host sends that Host with a
 * matching Origin, so the peer and Origin checks alone would pass it. The Host header must
 * name this server — the tailnet address or the MagicDNS name (dnsName(), trailing dot already
 * stripped) — with the served port. When `allowLoopback` is enabled (e.g. `workspace.allow_this_machine`),
 * loopback hosts (`127.0.0.1`, `localhost`, `[::1]`) are also permitted. No bound port: nothing is
 * allowed. The phone page, pages server, and team server all call this.
 */
export function hostAllowlist(
	tailscale: { ip4(): string | null; dnsName(): string | null },
	opts?: { allowLoopback?: boolean },
): (hostHeader: string, port: number | undefined) => boolean {
	let allowedHosts: string[] | null = null;
	return (hostHeader, port) => {
		// No bound port (never expected): nothing is allowed — fail closed.
		if (port === undefined) return false;
		if (allowedHosts === null) {
			const dns = tailscale.dnsName();
			const hosts = [tailscale.ip4(), dns].filter((h): h is string => Boolean(h));
			if (opts?.allowLoopback) hosts.push("127.0.0.1", "localhost", "[::1]");
			allowedHosts = hosts.map(h => `${h}:${port}`);
		}
		return allowedHosts.includes(hostHeader);
	};
}

/** True when Origin is exactly `http://` plus the Host header. Callers apply it to the methods they write. */
export function originIsHost(origin: string | null, hostHeader: string): boolean {
	return origin === `http://${hostHeader}`;
}

/** The owner pages' CSP: the one inline script takes this response's nonce; the team page shares it. */
export function pageCsp(nonce: string): string {
	return `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`;
}

export async function fieldsOf(req: Request): Promise<Record<string, string>> {
	const ct = req.headers.get("content-type") ?? "";
	if (ct.includes("application/json")) {
		const raw: unknown = await req.json();
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
		return Object.fromEntries(Object.entries(raw as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
	}
	const form = await req.formData();
	return Object.fromEntries([...form.entries()].map(([k, v]) => [k, typeof v === "string" ? v : ""]));
}

export function textRes(body: string, status: number): Response {
	return new Response(`${body}\n`, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

export function redirect(target: string): Response {
	return new Response(null, { status: 303, headers: { location: target } });
}

/** The POST reply target: the tab the owner was on (a hidden `tab` field; unknown = now, the default), then the receipt. */
export function sentTo(tab: string, sent: string): string {
	const t = TAB_IDS.includes(tab) ? tab : "now";
	return t === "now" ? `/?${sent}` : `/?tab=${t}&${sent}`;
}

/** The JSON POST replies (P11b): the receipt text rides along so the page script never re-derives it. */
export function jsonSent(sent: string, receipt?: string | null): Response {
	return Response.json(receipt ? { ok: true, sent, receipt } : { ok: true, sent });
}

export function jsonFail(error: string, status: number): Response {
	return Response.json({ ok: false, error }, { status });
}

export function esc(s: string): string {
	return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

export function na(label: string): string {
	return `<p class="na">${esc(label)} unavailable</p>`;
}

export function receiptText(sent: string, params: URLSearchParams): string | null {
	let text: string;
	switch (sent) {
		case "answer":
		case "message":
			text = `Sent to Main · ${strftime(nowSec(), "%H:%M")}`;
			break;
		case "team-answer": {
			const team = params.get("team") ?? "";
			text = `Sent to team ${team} · ${strftime(nowSec(), "%H:%M")}`;
			break;
		}
		case "incident-closed":
			text = `Marked as a false alarm · ${strftime(nowSec(), "%H:%M")}`;
			break;
		case "incident-bug":
			text = `Sent to Main to plan the fix · ${strftime(nowSec(), "%H:%M")}`;
			break;
		case "unlock": {
			const minutes = Number(params.get("minutes"));
			text = Number.isInteger(minutes) && minutes > 0 ? `Unlocked for ${minutes} min` : "Unlocked";
			break;
		}
		case "lock":
			text = "Locked";
			break;
		case "reorder": {
			// The rank counts the OPEN plans (what the page shows), not every INDEX.md line.
			const to = Number(params.get("to"));
			text = Number.isInteger(to) && to > 0 ? `Moved to #${to} of open plans · Main sees it next turn` : "Moved · Main sees it next turn";
			break;
		}
		case "unlock-off":
			text = "Refused — chat unlock is off";
			break;
		case "stale":
			text = "Already handled — Main cleared this question before your answer; your answer was still passed on.";
			break;
		default:
			return null;
	}
	return text;
}
