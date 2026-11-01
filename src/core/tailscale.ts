// The only place that names the tailscale binary. The owner page (src/core/owner-ui.ts) takes
// a Tailscale value instead of calling these directly, so tests inject a fixture and never run
// the real binary or bind the real tailnet address.

import { spawnSync } from "node:child_process";

export type TailscaleState = "missing" | "stopped" | "running";

export interface Tailscale {
	/** This machine's tailnet IPv4 address (first line of `tailscale ip -4`), or null when tailscale fails or answers nothing. */
	ip4(): string | null;
	/** This machine's MagicDNS name (`Self.DNSName` of `tailscale status --self --json`), trailing dot stripped, or null on failure. */
	dnsName(): string | null;
	/** The login that owns the peer address (`UserProfile.LoginName` of `tailscale whois --json <peer>`), or null on failure. */
	whois(peer: string): string | null;
	/** Every `User[*].LoginName` of `tailscale status --json`, or null when tailscale fails or the answer is unreadable — callers then skip their login check with a printed warning, never refuse on a tailscale failure. */
	logins(): string[] | null;
	/** `missing` when the binary does not exist; `stopped` when it is installed but `tailscale status --json` fails, answers unreadably, or its BackendState is not "Running"; else `running`. */
	state(): TailscaleState;
}

function firstStdoutLine(args: string[]): string | null {
	const r = spawnSync("tailscale", args, { encoding: "utf8", timeout: 8000 });
	if (r.error || r.status !== 0) return null;
	const line = (r.stdout ?? "").split("\n").map(l => l.trim()).filter(Boolean)[0];
	return line || null;
}

/** The login in `tailscale whois --json` output: multi-line JSON with the login at `UserProfile.LoginName`. Null when absent or unparseable. */
export function parseWhoisLogin(stdout: string): string | null {
	try {
		const parsed = JSON.parse(stdout) as { UserProfile?: { LoginName?: unknown } };
		const login = parsed.UserProfile?.LoginName;
		return typeof login === "string" && login ? login : null;
	} catch {
		return null;
	}
}

/** `running` only when `BackendState` of `tailscale status --json` is "Running"; unreadable JSON or any other state is `stopped`. */
export function parseBackendState(stdout: string): "running" | "stopped" {
	try {
		const parsed = JSON.parse(stdout) as { BackendState?: unknown };
		return parsed.BackendState === "Running" ? "running" : "stopped";
	} catch {
		return "stopped";
	}
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
		const r = spawnSync("tailscale", ["whois", "--json", peer], { encoding: "utf8", timeout: 8000 });
		if (r.error || r.status !== 0) return null;
		return parseWhoisLogin(r.stdout ?? "");
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
	state() {
		const r = spawnSync("tailscale", ["status", "--json"], { encoding: "utf8", timeout: 8000 });
		if (r.error) return (r.error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "stopped";
		if (r.status !== 0) return "stopped";
		return parseBackendState(r.stdout ?? "");
	},
};
