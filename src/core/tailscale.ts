// The only place that names the tailscale binary. The owner page (src/core/owner-ui.ts) takes
// a Tailscale value instead of calling these directly, so tests inject a fixture and never run
// the real binary or bind the real tailnet address.

import { spawnSync } from "node:child_process";

export interface Tailscale {
	/** This machine's tailnet IPv4 address (first line of `tailscale ip -4`), or null when tailscale fails or answers nothing. */
	ip4(): string | null;
	/** This machine's MagicDNS name (`Self.DNSName` of `tailscale status --self --json`), trailing dot stripped, or null on failure. */
	dnsName(): string | null;
	/** The login that owns the peer address (`User.LoginName` of `tailscale whois --json <peer>`), or null on failure. */
	whois(peer: string): string | null;
	/** Every `User[*].LoginName` of `tailscale status --json`, or null when tailscale fails or the answer is unreadable — callers then skip their login check with a printed warning, never refuse on a tailscale failure. */
	logins(): string[] | null;
}

function firstStdoutLine(args: string[]): string | null {
	const r = spawnSync("tailscale", args, { encoding: "utf8", timeout: 8000 });
	if (r.error || r.status !== 0) return null;
	const line = (r.stdout ?? "").split("\n").map(l => l.trim()).filter(Boolean)[0];
	return line || null;
}

export const realTailscale: Tailscale = {
	ip4() {
		return firstStdoutLine(["ip", "-4"]);
	},
	dnsName() {
		try {
			const r = spawnSync("tailscale", ["status", "--self", "--json"], { encoding: "utf8", timeout: 8000 });
			if (r.error || r.status !== 0) return null;
			const parsed = JSON.parse(r.stdout ?? "") as { Self?: { DNSName?: unknown } };
			const name = parsed.Self?.DNSName;
			return typeof name === "string" && name ? name.replace(/\.+$/, "") : null;
		} catch {
			return null;
		}
	},
	whois(peer) {
		const line = firstStdoutLine(["whois", "--json", peer]);
		if (!line) return null;
		try {
			const parsed = JSON.parse(line) as { User?: { LoginName?: unknown } };
			const login = parsed.User?.LoginName;
			return typeof login === "string" && login ? login : null;
		} catch {
			return null;
		}
	},
	logins() {
		try {
			const r = spawnSync("tailscale", ["status", "--json"], { encoding: "utf8", timeout: 8000 });
			if (r.error || r.status !== 0) return null;
			const parsed = JSON.parse(r.stdout ?? "") as { User?: unknown };
			const users = parsed.User;
			if (typeof users !== "object" || users === null || Array.isArray(users)) return null;
			const names: string[] = [];
			for (const user of Object.values(users)) {
				const login = (user as { LoginName?: unknown } | null)?.LoginName;
				if (typeof login === "string" && login) names.push(login);
			}
			return names;
		} catch {
			return null;
		}
	},
};
