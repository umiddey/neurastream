// Reconcile open forge MRs with open plans. The forge is the source of truth; a missing CLI,
// auth failure, unknown host or absent origin skips that repo and never fails the sweep.
// Host-neutral: forge CLIs are invoked through a command runner. No harness imports.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { cmd } from "./proc.ts";
import { activePlans, gitTop } from "./queue/lib.ts";

export const MR_SWEEP_NO_CLI = "mr-sweep: skipped (no forge CLI)";
const UNTRACKED_TAIL = "— no open plan mentions it";
const PAGE = 100;
const MAX_PAGES = 20;

export type Forge = "gitlab" | "github";

export interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
	/** The executable was not on PATH. Distinct from a non-zero exit (auth, network, usage). */
	missing?: boolean;
}

export type CommandRunner = (args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv }) => CommandResult;

export interface SweepMr {
	forge: Forge;
	number: number;
	token: string;
	branch: string;
	repo: string;
	tracked: boolean;
}

export interface SweepResult {
	lines: string[];
	mrs: SweepMr[];
	/** True only when a reachable forge listed at least one untracked MR. A skip is never a failure. */
	fail: boolean;
}

export interface SweepOpts {
	index?: string;
	env?: NodeJS.ProcessEnv;
	runner?: CommandRunner;
}

export function defaultRunner(args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): CommandResult {
	const bin = args[0];
	if (!bin) return { code: 127, stdout: "", stderr: "missing command", missing: true };
	const r = spawnSync(bin, args.slice(1), {
		cwd: opts.cwd,
		env: opts.env ?? process.env,
		encoding: "utf8",
		timeout: 20_000,
		maxBuffer: 8 * 1024 * 1024,
	});
	const err = r.error as NodeJS.ErrnoException | undefined;
	if (err?.code === "ENOENT") return { code: 127, stdout: "", stderr: err.message, missing: true };
	if (err) return { code: 1, stdout: r.stdout ?? "", stderr: `${r.stderr ?? ""}${err.message}` };
	return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Host of an origin URL (`git@host:path`, `ssh://`, `https://`). Null when it does not parse. */
export function remoteHost(url: string): string | null {
	const u = url.trim();
	if (!u.includes("://")) {
		const scp = /^[^@\s]+@([^:\s]+):/.exec(u);
		if (scp?.[1]) return scp[1].toLowerCase();
	}
	try {
		if (u.includes("://")) {
			const host = new URL(u).hostname.toLowerCase();
			return host || null;
		}
	} catch {
		return null;
	}
	return null;
}

/** `gitlab` in the host → gitlab; `github` in the host → github; anything else is unknown. */
export function forgeOf(host: string): Forge | null {
	const h = host.toLowerCase();
	if (h.includes("gitlab")) return "gitlab";
	if (h.includes("github")) return "github";
	return null;
}

/** `!N` / `#N` as a whole token, or the source branch name, in any of the texts. `MR !N: ignored` matches the token. */
export function mentioned(token: string, branch: string, texts: string[]): boolean {
	const re = new RegExp(`(?:^|[^0-9])${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![0-9])`);
	for (const text of texts) {
		if (re.test(text)) return true;
		if (branch && text.includes(branch)) return true;
	}
	return false;
}

function asRecord(v: unknown): Record<string, unknown> | null {
	return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function asNumber(v: unknown): number | null {
	if (typeof v === "number" && Number.isInteger(v) && v > 0) return v;
	if (typeof v === "string" && /^[0-9]+$/.test(v)) return Number(v);
	return null;
}

/** Parse a JSON list. Null means the CLI answered but not with a list — treat as unreachable, never as "no MRs". */
function parseList(stdout: string): Record<string, unknown>[] | null {
	const t = stdout.trim();
	if (!t) return [];
	const from = (v: unknown): Record<string, unknown>[] | null => {
		if (Array.isArray(v)) return v.map(asRecord).filter((x): x is Record<string, unknown> => x !== null);
		const rec = asRecord(v);
		if (!rec) return null;
		for (const key of ["merge_requests", "items", "pull_requests"]) {
			const inner = rec[key];
			if (Array.isArray(inner)) return inner.map(asRecord).filter((x): x is Record<string, unknown> => x !== null);
		}
		return null;
	};
	try {
		return from(JSON.parse(t));
	} catch {
		const at = t.indexOf("[");
		const end = t.lastIndexOf("]");
		if (at < 0 || end <= at) return null;
		try {
			return from(JSON.parse(t.slice(at, end + 1)));
		} catch {
			return null;
		}
	}
}

interface Listed {
	missing?: boolean;
	fail?: boolean;
	items: { number: number; branch: string }[];
}

function takeItems(parsed: Record<string, unknown>[], numberKey: "iid" | "number", branchKeys: string[]): { number: number; branch: string }[] {
	const items: { number: number; branch: string }[] = [];
	const seen = new Set<number>();
	for (const item of parsed) {
		const n = asNumber(item[numberKey] ?? item.number);
		if (n === null || seen.has(n)) continue;
		const state = typeof item.state === "string" ? item.state : "";
		// The list command already asks for open MRs. Skip only an explicit closed/merged row,
		// so an unexpected state label cannot hide an open MR.
		if (state === "closed" || state === "merged") continue;
		seen.add(n);
		let branch = "";
		for (const key of branchKeys) {
			const value = item[key];
			if (typeof value === "string") {
				branch = value;
				break;
			}
		}
		items.push({ number: n, branch });
	}
	return items;
}

function listGitlab(repo: string, run: CommandRunner, env?: NodeJS.ProcessEnv): Listed {
	const items: { number: number; branch: string }[] = [];
	const seen = new Set<number>();
	for (let page = 1; page <= MAX_PAGES; page++) {
		const r = run(["glab", "mr", "list", "-F", "json", "-P", String(PAGE), "-p", String(page)], { cwd: repo, env });
		if (r.missing) return { missing: true, items: [] };
		if (r.code !== 0) return { fail: true, items: [] };
		const parsed = parseList(r.stdout);
		if (parsed === null) return { fail: true, items: [] };
		for (const item of takeItems(parsed, "iid", ["source_branch", "sourceBranch"])) {
			if (seen.has(item.number)) continue;
			seen.add(item.number);
			items.push(item);
		}
		if (parsed.length < PAGE) break;
	}
	return { items };
}

function listGithub(repo: string, run: CommandRunner, env?: NodeJS.ProcessEnv): Listed {
	const r = run(["gh", "pr", "list", "--state", "open", "--limit", "1000", "--json", "number,headRefName,title"], { cwd: repo, env });
	if (r.missing) return { missing: true, items: [] };
	if (r.code !== 0) return { fail: true, items: [] };
	const parsed = parseList(r.stdout);
	if (parsed === null) return { fail: true, items: [] };
	return { items: takeItems(parsed, "number", ["headRefName", "head_ref_name"]) };
}

function skip(repo: string, why: string): string {
	return `mr-sweep: skipped ${repo} (${why})`;
}

export interface OpenMr {
	forge: Forge;
	number: number;
	token: string;
	branch: string;
}

/** `{ ok: false, why }` is the sweep's degrade: the caller logs it and never treats it as "no MRs". */
export type OpenMrs = { ok: true; mrs: OpenMr[] } | { ok: false; why: string };

/**
 * Open MRs of one repo (the sweep's lister, single-repo): `!N` / `#N` token plus source branch.
 * Everything — origin lookup included — goes through the runner, so callers can inject it.
 */
export function listOpenMrs(repo: string, run: CommandRunner = defaultRunner, env?: NodeJS.ProcessEnv): OpenMrs {
	const remote = run(["git", "-C", repo, "remote", "get-url", "origin"], { env });
	const url = remote.code === 0 ? remote.stdout.trim() : "";
	if (!url) return { ok: false, why: "no origin remote" };
	const host = remoteHost(url);
	const forge = host ? forgeOf(host) : null;
	if (!forge) return { ok: false, why: "unknown forge" };
	const listed = forge === "gitlab" ? listGitlab(repo, run, env) : listGithub(repo, run, env);
	if (listed.missing) return { ok: false, why: "no forge CLI" };
	if (listed.fail) return { ok: false, why: "forge unreachable" };
	return {
		ok: true,
		mrs: listed.items
			.map(item => ({ forge, number: item.number, token: forge === "gitlab" ? `!${item.number}` : `#${item.number}`, branch: item.branch }))
			.toSorted((a, b) => a.number - b.number),
	};
}

/**
 * Open MRs of every repo in the index, marked tracked when an open plan of that repo contains
 * the `!N` / `#N` token (including `MR !N: ignored`) or the source branch name.
 */
export function mrSweep(opts: SweepOpts = {}): SweepResult {
	const run = opts.runner ?? defaultRunner;
	const plans = activePlans(opts.index);
	const repos: string[] = [];
	for (const p of plans) if (!repos.includes(p.repo)) repos.push(p.repo);
	const lines: string[] = [];
	const mrs: SweepMr[] = [];
	let missingCli = false;
	let fail = false;
	for (const repo of repos) {
		if (!gitTop(repo)) {
			lines.push(skip(repo, "not a git repo"));
			continue;
		}
		const remote = cmd(["git", "-C", repo, "remote", "get-url", "origin"], { env: opts.env });
		const url = remote.code === 0 ? remote.stdout.trim() : "";
		if (!url) {
			lines.push(skip(repo, "no origin remote"));
			continue;
		}
		const host = remoteHost(url);
		const forge = host ? forgeOf(host) : null;
		if (!forge) {
			lines.push(skip(repo, "unknown forge"));
			continue;
		}
		const listed = forge === "gitlab" ? listGitlab(repo, run, opts.env) : listGithub(repo, run, opts.env);
		if (listed.missing) {
			missingCli = true;
			continue;
		}
		if (listed.fail) {
			lines.push(skip(repo, "forge unreachable"));
			continue;
		}
		const texts = plans.filter(p => p.repo === repo && p.status === "open").map(p => p.text);
		const found = listed.items
			.map(item => {
				const token = forge === "gitlab" ? `!${item.number}` : `#${item.number}`;
				const mr: SweepMr = {
					forge,
					number: item.number,
					token,
					branch: item.branch,
					repo,
					tracked: mentioned(token, item.branch, texts),
				};
				return mr;
			})
			.sort((a, b) => a.number - b.number);
		for (const mr of found) {
			mrs.push(mr);
			if (mr.tracked) lines.push(`tracked MR ${mr.token} ${path.basename(mr.repo)} ${mr.repo} (${mr.branch})`);
			else {
				lines.push(`UNTRACKED MR ${mr.token} ${path.basename(mr.repo)} ${mr.repo} (${mr.branch}) ${UNTRACKED_TAIL}`);
				fail = true;
			}
		}
	}
	if (missingCli) lines.unshift(MR_SWEEP_NO_CLI);
	return { lines, mrs, fail };
}
