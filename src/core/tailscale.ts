// The only place that names the tailscale binary. The owner page (src/core/owner-ui.ts) takes
// a Tailscale value instead of calling these directly, so tests inject a fixture and never run
// the real binary or bind the real tailnet address.

import { spawnSync } from "node:child_process";

export interface Tailscale {
	/** This machine's tailnet IPv4 address (first line of `tailscale ip -4`), or null when tailscale fails or answers nothing. */
	ip4(): string | null;
	/** The login that owns the peer address (`User.LoginName` of `tailscale whois --json <peer>`), or null on failure. */
	whois(peer: string): string | null;
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
};
