// CI in the loop (plan 20261027_1430 P6b): the watcher's forge checks, plus the M3 `ci` recording
// that used to live only in the CLI. Every forge call goes through an injected CommandRunner
// (mr-sweep's), so tests run a fake glab/gh/git and never touch a real forge.
// Only finished pipelines (success|failed) count: a running or pending one neither opens nor
// closes an incident, so a run in flight cannot flap one.

import type { Config } from "./config.ts";
import { appendMetric, readMetricEvents } from "./metrics.ts";
import { defaultRunner, listOpenMrs, mentioned, parseList, repoForge, type CommandRunner, type Forge } from "./mr-sweep.ts";

/** One pipeline. `other` = running, pending, canceled or skipped. */
export interface Pipeline {
	ref: string;
	sha: string;
	status: "success" | "failed" | "other";
	/** Unix seconds the pipeline was created. */
	at: number;
}

/** One CI problem, shaped like the watcher's WatchProblem (watch.ts keeps its own copy). */
export interface CiProblem {
	fingerprint: string;
	kind: string;
	job: string;
	at: string;
	line: string;
	summary: string;
	evidence: string;
}

export interface CiInputs {
	run: CommandRunner;
	now: number;
	/** The plans whose repos are scanned, and the text an MR is matched against. */
	plans: { file: string; repo: string; text: string }[];
	/** Plan files with a running agent: an MR they name never opens ci-red-mr. */
	staffed: string[];
}

export interface CiScan {
	problems: CiProblem[];
	/** M3 `ci` records this run wrote. */
	recorded: number;
	/** `ci-flaky` records this run wrote. */
	flaky: number;
	/** Repos or steps the check could not read, with the reason. */
	skipped: string[];
	/** ci-red-mr fingerprints a staffed plan held back this run: still red, so their incidents stay open. */
	held: string[];
}

export type CiRecord = { ok: true; tries: number; skipped: string[] } | { ok: false; code: number; error: string };

/** Newest merged MRs one run reads per repo. The ledger marks what is recorded, so an MR is never recorded twice; this only bounds the first backfill. */
const MERGED_LIST = 20;
/** Newest pipelines one run reads per repo. */
const PIPELINE_LIST = 100;

const iso = (sec: number): string => new Date(sec * 1000).toISOString();
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Runs the configured CI command for one MR and records how many pipelines it needed (M3), then the repo's product numbers. The CLI and the watcher show the error their own way. */
export function recordCiMr(cfg: Config, repoDir: string, mr: string, now: number, run: CommandRunner = defaultRunner): CiRecord {
	const template = cfg.metrics.ci_pipelines_cmd;
	if (!template) return { ok: false, code: 2, error: "metrics.ci_pipelines_cmd not set" };
	const r = run(["sh", "-c", template.replaceAll("{mr}", `'${mr.replaceAll("'", "'\\''")}'`)], { cwd: repoDir });
	if (r.code !== 0) return { ok: false, code: 1, error: `ci command exited ${r.code}: ${r.stderr.trim()}` };
	let pipelines: unknown;
	try {
		pipelines = JSON.parse(r.stdout);
	} catch {
		pipelines = undefined;
	}
	if (!Array.isArray(pipelines)) return { ok: false, code: 1, error: "ci command must print a JSON array on stdout" };
	appendMetric(cfg, { type: "ci", mr, repo: repoDir, tries: pipelines.length, ts: now });
	return { ok: true, tries: pipelines.length, skipped: recordProducts(cfg, repoDir, now) };
}

const PRODUCT_TIMEOUT_MS = 10_000;

/**
 * Runs the repo's configured product numbers once each (metrics.product_cmds) and appends one
 * product record per number. A command that fails, times out or prints anything but one finite
 * number is skipped and returned as a message; the ci record itself never fails on a product number.
 */
function recordProducts(cfg: Config, repoDir: string, now: number): string[] {
	const skipped: string[] = [];
	for (const [name, cmd] of Object.entries(cfg.metrics.product_cmds[repoDir] ?? {})) {
		const proc = Bun.spawnSync(["sh", "-c", cmd], { cwd: repoDir, stdout: "pipe", stderr: "pipe", timeout: PRODUCT_TIMEOUT_MS });
		const out = proc.stdout.toString().trim();
		const value = Number(out);
		if (proc.exitCode !== 0 || out === "" || !Number.isFinite(value)) {
			const why = proc.exitCode !== 0 ? `exit ${proc.exitCode ?? "signal"}` : `not one number: "${out.slice(0, 40)}"`;
			skipped.push(`product_cmds.${name}: skipped (${why})`);
			continue;
		}
		appendMetric(cfg, { type: "product", repo: repoDir, name, value, ts: now });
	}
	return skipped;
}

/** The default branch from origin's HEAD; null when origin has no HEAD ref. */
function defaultBranch(repo: string, run: CommandRunner): string | null {
	const r = run(["git", "-C", repo, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"], {});
	const name = r.code === 0 ? r.stdout.trim().replace(/^origin\//, "") : "";
	return name || null;
}

/** Newest pipelines of a repo; null when the forge CLI cannot answer (never "no pipelines"). */
export function pipelinesOf(repo: string, forge: Forge, run: CommandRunner): Pipeline[] | null {
	const r =
		forge === "gitlab"
			? run(["glab", "api", `projects/:id/pipelines?per_page=${PIPELINE_LIST}`], { cwd: repo })
			: run(["gh", "run", "list", "--limit", String(PIPELINE_LIST), "--json", "headBranch,headSha,conclusion,status,createdAt"], { cwd: repo });
	const rows = r.code === 0 ? parseList(r.stdout) : null;
	if (!rows) return null;
	const pipes = rows.map((row): Pipeline => {
		if (forge === "gitlab") {
			const s = str(row.status);
			return { ref: str(row.ref), sha: str(row.sha), status: s === "success" || s === "failed" ? s : "other", at: Date.parse(str(row.created_at)) / 1000 };
		}
		// A gh run is finished when its status is completed; the conclusion then says how it ended.
		const c = str(row.conclusion);
		const status = str(row.status) !== "completed" ? "other" : c === "success" ? "success" : c === "failure" ? "failed" : "other";
		return { ref: str(row.headBranch), sha: str(row.headSha), status, at: Date.parse(str(row.createdAt)) / 1000 };
	});
	return pipes.filter(p => Number.isFinite(p.at));
}

/** Newest merged MR numbers of a repo; null when the forge CLI cannot answer. */
function mergedMrs(repo: string, forge: Forge, run: CommandRunner): number[] | null {
	const r =
		forge === "gitlab"
			? run(["glab", "mr", "list", "--merged", "-F", "json", "-P", String(MERGED_LIST)], { cwd: repo })
			: run(["gh", "pr", "list", "--state", "merged", "--limit", String(MERGED_LIST), "--json", "number"], { cwd: repo });
	const rows = r.code === 0 ? parseList(r.stdout) : null;
	if (!rows) return null;
	// The cap holds here too: the forge's own limit flag is only a hint, and the first backfill must stay bounded.
	return rows.map(row => (typeof row.iid === "number" ? row.iid : row.number)).filter((n): n is number => typeof n === "number" && n > 0).slice(0, MERGED_LIST);
}

/** When the newest finished run of a ref started failing: the oldest failure of the unbroken red streak at the head. Null when the newest passed. */
function redSince(runs: Pipeline[]): number | null {
	if (runs[0]?.status !== "failed") return null;
	let since = runs[0].at;
	for (const p of runs) {
		if (p.status !== "failed") break;
		since = p.at;
	}
	return since;
}

/** Shas that went red and then green: a passing run newer than a failed run of the same commit. */
function flakyShas(pipes: Pipeline[]): string[] {
	const out = new Set<string>();
	pipes.forEach((ok, i) => {
		if (ok.status === "success" && pipes.slice(i + 1).some(p => p.status === "failed" && p.sha === ok.sha)) out.add(ok.sha);
	});
	return [...out];
}

function redProblems(cfg: Config, repo: string, pipes: Pipeline[], inp: CiInputs, scan: CiScan): CiProblem[] {
	const out: CiProblem[] = [];
	const finished = pipes.filter(p => p.status !== "other");
	const branch = defaultBranch(repo, inp.run);
	const main = finished.find(p => p.ref === branch);
	if (main?.status === "failed") {
		out.push({
			fingerprint: `watch:ci-red-main:${repo}`,
			kind: "ci-red-main",
			job: repo,
			at: iso(main.at),
			line: `pipeline on ${branch} failed (sha ${main.sha.slice(0, 8)})`,
			summary: `${branch} pipeline failed in ${repo}`,
			evidence: `ci: newest finished pipeline on ${branch} is failed`,
		});
	}
	const open = listOpenMrs(repo, inp.run);
	if (!open.ok) {
		scan.skipped.push(`${repo} (open MRs: ${open.why})`);
		return out;
	}
	for (const mr of open.mrs) {
		const since = redSince(finished.filter(p => p.ref === mr.branch));
		if (since === null) continue;
		const hours = (inp.now - since) / 3600;
		if (hours <= cfg.watch.ci_red_hours) continue;
		const staffed = inp.plans.some(p => p.repo === repo && inp.staffed.includes(p.file) && mentioned(mr.token, mr.branch, [p.text]));
		const fingerprint = `watch:ci-red-mr:${repo}#${mr.number}`;
		if (staffed) {
			// Held back, not recovered: the MR is still red, so its incident stays open.
			scan.held.push(fingerprint);
			continue;
		}
		const h = hours.toFixed(1);
		out.push({
			fingerprint,
			kind: "ci-red-mr",
			job: `${repo} ${mr.token}`,
			at: iso(since),
			line: `pipeline on ${mr.branch} red for ${h}h (limit ${cfg.watch.ci_red_hours}h)`,
			summary: `${mr.token} pipeline red for ${h}h on ${mr.branch} in ${repo}`,
			evidence: `ci: newest finished pipelines on ${mr.branch} failed since ${iso(since)}`,
		});
	}
	return out;
}

/**
 * Records M3 `ci` for merged MRs with no ledger row. A CI error skips only that MR, so the rest still
 * record. Its skip is logged once (a ci-skip record) and the MR is retried on the next run.
 */
function recordMerged(cfg: Config, repo: string, forge: Forge, done: Set<string>, skipLogged: Set<string>, inp: CiInputs, scan: CiScan): void {
	if (!cfg.metrics.ci_pipelines_cmd) return;
	const merged = mergedMrs(repo, forge, inp.run);
	if (!merged) {
		scan.skipped.push(`${repo} (merged MRs unreachable)`);
		return;
	}
	for (const mr of merged) {
		const key = `${repo}#${mr}`;
		if (done.has(key)) continue;
		const rec = recordCiMr(cfg, repo, String(mr), inp.now, inp.run);
		if (!rec.ok) {
			if (!skipLogged.has(key)) {
				scan.skipped.push(`${repo} (ci command for !${mr}: ${rec.error})`);
				appendMetric(cfg, { type: "ci-skip", repo, mr: String(mr), ts: inp.now });
				skipLogged.add(key);
			}
			continue;
		}
		done.add(key);
		scan.recorded++;
		for (const s of rec.skipped) scan.skipped.push(`${repo} (${s})`);
	}
}

function recordFlaky(cfg: Config, repo: string, pipes: Pipeline[], flagged: Set<string>, inp: CiInputs, scan: CiScan): void {
	for (const sha of flakyShas(pipes)) {
		const key = `${repo}@${sha}`;
		if (flagged.has(key)) continue;
		appendMetric(cfg, { type: "ci-flaky", repo, sha, ts: inp.now });
		flagged.add(key);
		scan.flaky++;
	}
}

/** One watcher pass over CI: red default branch, red open MRs, M3 for merged MRs, flaky commits. Repos come from the active plans, as mr-sweep does. */
export function ciScan(cfg: Config, inp: CiInputs): CiScan {
	const scan: CiScan = { problems: [], recorded: 0, flaky: 0, skipped: [], held: [] };
	const events = readMetricEvents(cfg);
	const ciDone = new Set(events.filter(e => e.type === "ci").map(e => `${e.repo}#${e.mr}`));
	const flagged = new Set(events.filter(e => e.type === "ci-flaky").map(e => `${e.repo}@${e.sha}`));
	const skipLogged = new Set(events.filter(e => e.type === "ci-skip").map(e => `${e.repo}#${e.mr}`));
	for (const repo of new Set(inp.plans.map(p => p.repo))) {
		const found = repoForge(repo, inp.run);
		if ("why" in found) {
			scan.skipped.push(`${repo} (${found.why})`);
			continue;
		}
		const pipes = pipelinesOf(repo, found.forge, inp.run);
		if (!pipes) {
			scan.skipped.push(`${repo} (pipelines unreachable)`);
			continue;
		}
		scan.problems.push(...redProblems(cfg, repo, pipes, inp, scan));
		recordMerged(cfg, repo, found.forge, ciDone, skipLogged, inp, scan);
		recordFlaky(cfg, repo, pipes, flagged, inp, scan);
	}
	return scan;
}
