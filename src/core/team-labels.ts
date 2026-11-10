// Share decision for team-queue P1. queue/lib cannot import mr-sweep (mr-sweep already
// imports it), and the forge reconciler should not own the Queue header, so the decision
// lives here. planShare is the gate later sync must call before any send: null means the
// plan stays on this machine.

import type { Config } from "./config.ts";
import { defaultRunner, remotePath, type CommandRunner } from "./mr-sweep.ts";
import { headerField, type Plan } from "./queue/lib.ts";
import { globMatch } from "./trace-actions.ts";

function isObj(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Host lowercased, no trailing slash, so `GitLab.com/acme/*` and `gitlab.com/acme/*` are one pattern. */
function normPattern(p: string): string {
	const t = p.trim().replace(/\/+$/, "");
	const i = t.indexOf("/");
	return i < 0 ? t.toLowerCase() : t.slice(0, i).toLowerCase() + t.slice(i);
}

function fill(p: string): string {
	return p.replaceAll("**/", "a/").replaceAll("**", "a").replaceAll("*", "a").replaceAll("?", "a");
}

function segMatch(pattern: string, text: string): boolean {
	let re = "";
	for (const c of pattern) {
		if (c === "*") re += ".*";
		else if (c === "?") re += ".";
		else re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${re}$`).test(text);
}

/** One path segment. `*` is anything in the segment, matching globMatch (a star does not cross `/`). */
function segOverlap(a: string, b: string): boolean {
	if (a === "*" || b === "*") return true;
	if (a === b) return true;
	if (!(a.includes("*") || a.includes("?"))) return segMatch(b, a);
	if (!(b.includes("*") || b.includes("?"))) return segMatch(a, b);
	return segMatch(a, fill(b)) || segMatch(b, fill(a));
}

/** True when the two origin globs can name the same `host/path`. */
function globsOverlap(a: string, b: string): boolean {
	const left = normPattern(a);
	const right = normPattern(b);
	if (left === right) return true;
	if (left.includes("**") || right.includes("**")) return globMatch(left, fill(right), "") || globMatch(right, fill(left), "");
	const as = left.split("/");
	const bs = right.split("/");
	if (as.length !== bs.length) return false;
	return as.every((seg, i) => segOverlap(seg, bs[i]!));
}

/**
 * Why `teams` cannot load, or null. Two teams that can name the same remote are an error:
 * a repo must belong to one team. Shape is checked here because an array in the template
 * is replaced whole, so item types never pass through merge.
 */
export function teamConfigError(teams: unknown): string | null {
	if (!Array.isArray(teams)) return "teams must be a list of {name, server, repos}";
	const names = new Set<string>();
	const parsed: { name: string; repos: string[] }[] = [];
	for (const [i, raw] of teams.entries()) {
		if (!isObj(raw)) return `teams[${i}] must be {name, server, repos}`;
		const { name, server, repos } = raw;
		if (typeof name !== "string" || name.trim() === "" || /\s/.test(name))
			return `teams[${i}].name must be a non-empty name without spaces`;
		if (names.has(name)) return `teams: two entries named "${name}"`;
		names.add(name);
		if (typeof server !== "string" || server.trim() === "") return `teams[${i}].server must be a non-empty string`;
		if (!Array.isArray(repos) || repos.length === 0 || repos.some(r => typeof r !== "string" || r.trim() === ""))
			return `teams[${i}].repos must be a list of non-empty origin globs (host/path, * does not cross /)`;
		parsed.push({ name, repos });
	}
	for (let i = 0; i < parsed.length; i++) {
		for (let j = i + 1; j < parsed.length; j++) {
			const a = parsed[i]!;
			const b = parsed[j]!;
			for (const pa of a.repos) {
				for (const pb of b.repos) {
					if (globsOverlap(pa, pb)) return `teams: "${a.name}" and "${b.name}" both match the same remote (${pa} and ${pb})`;
				}
			}
		}
	}
	return null;
}

/** True when a git origin URL matches one of these repo globs. Unparseable is not listed. The team server calls this with the remote it was given, so it does not shell out. */
export function remoteListed(remote: string, repos: string[]): boolean {
	const path = remotePath(remote);
	if (!path) return false;
	return repos.some(p => globMatch(normPattern(p), path, ""));
}

/** The team whose `repos` glob matches this repo's origin, or null (no origin, unparseable, or no match). */
export function repoTeam(repoDir: string, cfg: Config, run: CommandRunner = defaultRunner): string | null {
	const remote = run(["git", "-C", repoDir, "remote", "get-url", "origin"], {});
	const url = remote.code === 0 ? remote.stdout.trim() : "";
	if (!url) return null;
	for (const team of cfg.teams) {
		if (remoteListed(url, team.repos)) return team.name;
	}
	return null;
}

/**
 * The team this plan shares with, or null. A missing or non-`team` Queue header returns
 * before the origin is read, so a personal plan is never looked up to send.
 */
export function planShare(plan: Plan, cfg: Config, run: CommandRunner = defaultRunner): string | null {
	if (headerField(plan.text, "Queue") !== "team") return null;
	return repoTeam(plan.repo, cfg, run);
}
