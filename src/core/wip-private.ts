// The backup target must be verifiably private before anything is pushed: a repo made public by
// accident would publish every saved worktree. Parsing happens first, so a hostile URL never
// reaches a command; the answer is "unknown" unless it is the exact word "private".
import { cmd, type CmdResult } from "./proc.ts";

export type Visibility = "private" | "public" | "internal" | "unknown";

/** One argv array in, one result out: tests inject this instead of running gh/glab. */
export type Run = (args: string[]) => CmdResult;

export interface Remote {
	host: string;
	segments: string[];
}

const HOST_RX = /^[A-Za-z0-9.-]+$/;
const SEGMENT_RX = /^[A-Za-z0-9._-]+$/;
const SCP_RX = /^[A-Za-z0-9._-]+@([^:/@]+):(.+)$/;
const URL_RX = /^(?:ssh|git|https?):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/;

/** host plus path segments of a git remote, or null when the URL cannot be trusted as written. */
export function parseRemote(url: string): Remote | null {
	const raw = url.trim();
	if (raw === "") return null;
	const scp = SCP_RX.exec(raw);
	const scheme = scp ? null : URL_RX.exec(raw);
	const host = scp?.[1] ?? scheme?.[1];
	const path = scp?.[2] ?? scheme?.[2];
	if (!host || !path || !HOST_RX.test(host)) return null;
	// A "?" or "#" would be a query/fragment, "%" a hidden escape: the path must be plain segments.
	const segments = path.replace(/\/+$/, "").split("/");
	const last = segments.length - 1;
	if (segments[last]?.endsWith(".git")) segments[last] = segments[last]!.slice(0, -4);
	for (const segment of segments) {
		if (!SEGMENT_RX.test(segment) || segment === "." || segment === "..") return null;
	}
	return { host: host.toLowerCase(), segments };
}

/** `host/owner/repo` of a remote, or null when it does not parse (P8 matches hook opt-ins on this). */
export function originId(url: string): { host: string; id: string; owner: string } | null {
	const remote = parseRemote(url);
	if (!remote) return null;
	return {
		host: remote.host,
		owner: `${remote.host}/${remote.segments[0]}`,
		id: `${remote.host}/${remote.segments.join("/")}`,
	};
}

/**
 * Whether a `wip.backup_hook_off` entry names this origin: it must equal the origin's `host/owner`
 * or `host/owner/repo` exactly. A substring test would let one entry opt in every repo on a host,
 * or even an unrelated one (`git` matching every ssh URL).
 */
export function originMatches(entry: string, url: string): boolean {
	const parsed = originId(url);
	return parsed !== null && (entry === parsed.owner || entry === parsed.id);
}

function answer(text: string): Visibility {
	const value = text.trim();
	return value === "private" || value === "public" || value === "internal" ? value : "unknown";
}

/**
 * How visible the backup repo is: "private" is the only answer that lets a push through.
 * github and gitlab are asked through their CLIs; any other host must answer through
 * `wip.private_check` (argv, URL last), and an empty setting is "unknown".
 */
export function backupVisibility(url: string, run: Run = (args) => cmd(args), check = ""): Visibility {
	const remote = parseRemote(url);
	if (!remote) return "unknown";
	if (remote.host === "github.com") {
		if (remote.segments.length !== 2) return "unknown";
		const r = run(["gh", "api", `repos/${remote.segments[0]}/${remote.segments[1]}`, "--jq", ".visibility"]);
		return r.code === 0 ? answer(r.stdout) : "unknown";
	}
	if (remote.host === "gitlab.com" || /(^|\.)gitlab\./.test(remote.host)) {
		const r = run(["glab", "api", `projects/${encodeURIComponent(remote.segments.join("/"))}`]);
		if (r.code !== 0) return "unknown";
		try {
			const parsed = JSON.parse(r.stdout) as { visibility?: unknown };
			return answer(typeof parsed.visibility === "string" ? parsed.visibility : "");
		} catch {
			return "unknown";
		}
	}
	const probe = check.trim();
	if (probe === "") return "unknown";
	const r = run([...probe.split(/\s+/), url]);
	return r.code === 0 && r.stdout.trim() === "private" ? "private" : "unknown";
}
