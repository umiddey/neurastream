// Plan approval from the plan's own diagram page (plan 20261026_0930 P9). A plan that has a page in
// Base is approved there: the Approve bar records a hash of the plan text in the queue state
// (plan-approvals.json). The plan file is never edited. main-guard refuses a spawn on a plan whose page
// has no record with the plan's current hash; a plan with no page predates the convention and is left alone, unless it is stamped at or after approval.since (plan 20261029_1455 P3), when it is refused until its page is published.
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import * as q from "./queue/lib.ts";
import type { Config } from "./config.ts";

/** Lines only Main may write: the status, owner parking, plan waits, owner cancellation, cancelled-list clearance. */
export const MAIN_ONLY_LINE = /^\s*(?:[-*]\s+)?(Status:|WAITING on owner:|Waits on:|Cancelled by owner:|False positive:)/;

/** What a PASS covers: the plan text outside "## Progress" without the Main-only lines, so progress notes never expire a review. */
export function reviewHash(text: string): string {
	return q.sha(
		q
			.outsideProgress(text)
			.split("\n")
			.filter(l => !MAIN_ONLY_LINE.test(l))
			.map(l => l.replace(/^(\s*[-*]\s+)\[[xX]\]/, "$1[ ]")) // a ticked phase box hashes as unticked: ticking never expires a PASS
			.join("\n"),
	);
}

/** What publishing recorded for a page: the plan it approves and what its diagram check found. */
export interface PagePlan {
	plan: string;
	missing: string[];
	thin: string[];
}

/** The record a page was published with, or null when it was published without `--plan`. */
export function readPagePlan(dir: string, name: string): PagePlan | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(join(dir, ".meta", `${name}.json`), "utf8"));
	} catch {
		return null;
	}
	if (parsed === null || typeof parsed !== "object" || !("plan" in parsed)) return null;
	const plan = parsed.plan;
	if (typeof plan !== "string" || plan === "") return null;
	const list = (value: unknown): string[] => (Array.isArray(value) ? value.filter((one): one is string => typeof one === "string") : []);
	const missing = "missing" in parsed ? parsed.missing : [];
	const thin = "thin" in parsed ? parsed.thin : [];
	return { plan, missing: list(missing), thin: list(thin) };
}

/** The plan file a page approves, or null when the page was published without `--plan`. */
export function planForPage(dir: string, name: string): string | null {
	return readPagePlan(dir, name)?.plan ?? null;
}

/** Remember the plan a page approves and its diagram check: one small JSON beside the pages, never served. */
export function recordPagePlan(dir: string, name: string, entry: PagePlan): void {
	mkdirSync(join(dir, ".meta"), { recursive: true });
	writeFileSync(join(dir, ".meta", `${name}.json`), JSON.stringify({ plan: resolve(entry.plan), missing: entry.missing, thin: entry.thin }));
}

/** The page that approves this plan, or null when the plan has none in Base. */
export function pageOfPlan(dir: string, file: string): string | null {
	let names: string[] = [];
	try {
		names = readdirSync(join(dir, ".meta"));
	} catch {
		return null;
	}
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const page = name.slice(0, -".json".length);
		if (planForPage(dir, page) === resolve(file)) return page;
	}
	return null;
}

// --- Plan approval records (plan 20261026_0930 P9): a hash in the queue state, not a line in the plan ---

/** One approval: the plan text it covers, when it was recorded, and how. */
export interface PlanApproval {
	hash: string;
	at: number;
	via: "page" | "chat";
	page: string;
}

function planApprovalsFile(): string {
	return join(q.STATE_DIR, "plan-approvals.json");
}

function readPlanApprovals(): Record<string, PlanApproval> {
	try {
		const parsed = JSON.parse(readFileSync(planApprovalsFile(), "utf8"));
		if (parsed?.approvals && typeof parsed.approvals === "object") return parsed.approvals as Record<string, PlanApproval>;
	} catch {
	}
	return {};
}

function writePlanApprovals(approvals: Record<string, PlanApproval>): boolean {
	try {
		mkdirSync(q.STATE_DIR, { recursive: true });
		writeFileSync(planApprovalsFile(), JSON.stringify({ approvals }, null, 1));
		return true;
	} catch {
		return false;
	}
}

function readPlanApproval(file: string): PlanApproval | null {
	return readPlanApprovals()[file] ?? null;
}

/** Record one approval. Throws when the queue state cannot be written, so nobody reports "approved" for a record that is not there. */
function recordApproval(file: string, approval: PlanApproval): void {
	const approvals = readPlanApprovals();
	approvals[file] = approval;
	if (!writePlanApprovals(approvals)) throw new Error(`cannot write ${planApprovalsFile()}`);
}

/** The owner's click on a plan page: record a hash of the plan text in the queue state and return the page it approved. The plan file itself is never edited. */
export function approvePlanFile(file: string, page: string, now = new Date()): string {
	const text = readFileSync(file, "utf8");
	recordApproval(file, { hash: reviewHash(text), at: now.getTime(), via: "page", page });
	return `approved ${page}`;
}

export type ChatApproveResult = { applied: true; plan: string } | { applied: false; problem?: string };

const APPROVE_CMD = /^approve (\d{8}_\d{4})$/;

/**
 * The owner's own chat `approve <YYYYMMDD_HHMM>` (same trust rules as chatGo): the one open indexed
 * plan whose file stamp matches records a chat approval and is logged to plan_guard_log. Any other
 * text is not an approval. A stamp that matches none, or several, or a record that cannot be saved,
 * is a problem for the owner to read; nothing is approved.
 */
export function chatApprove(text: string, cfg: Config, source: string): ChatApproveResult {
	if (!cfg.guards.chat_unlock) return { applied: false };
	const m = APPROVE_CMD.exec(text.trim());
	if (!m) return { applied: false };
	const stamp = m[1];
	const matches = q.activePlans().filter(p => p.status === "open" && basename(p.file).startsWith(`${stamp}_`));
	const [plan, second] = matches;
	if (!plan) return { applied: false, problem: `no open plan ${stamp}` };
	if (second) return { applied: false, problem: `${matches.length} open plans match ${stamp}; nothing approved` };
	try {
		recordApproval(plan.file, { hash: reviewHash(plan.text), at: Date.now(), via: "chat", page: pageOfPlan(cfg.pages.dir, plan.file) ?? "" });
	} catch (e) {
		return { applied: false, problem: `plan ${stamp} not approved: ${e instanceof Error ? e.message : String(e)}` };
	}
	try {
		appendFileSync(cfg.paths.plan_guard_log, `${new Date().toISOString()} APPROVE chat source=${source} plan=${plan.file}\n`);
	} catch {}
	return { applied: true, plan: plan.file };
}

/** Why a spawn may not run on this plan, or null. A plan with a page in Base needs a record with its current hash. A plan stamped at or after `since` (approval.since, "" = off) needs a page too (plan 20261029_1455 P3): with no page it is refused until the page is published. A file with no stamp counts as stamped after `since`. */
export function approvalProblem(text: string, file: string, pagesDir: string, since: string): string | null {
	const page = pageOfPlan(pagesDir, file);
	const stamp = /^\d{8}_\d{4}/.exec(basename(file))?.[0] ?? null;
	const gated = since !== "" && (stamp === null || stamp >= since);
	if (page === null) {
		if (!gated) return null; // predates the convention
		return `plan ${file} has no page: publish its page with neurastream pages publish <page.html> --plan ${file}`;
	}
	const rec = readPlanApproval(file);
	if (rec !== null && rec.hash === reviewHash(text)) return null;
	const hint = stamp !== null ? `, or types: approve ${stamp}` : "";
	return `plan ${file} has no approval record. The owner approves it from ${page} in Base${hint}.`;
}