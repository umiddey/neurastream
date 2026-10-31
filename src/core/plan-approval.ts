// Plan approval from the plan's own diagram page (plan 20261026_0930 P9). A plan that has a page in
// Base is approved there: the Approve bar records a hash of the plan text in the queue state
// (plan-approvals.json). The plan file is never edited. main-guard refuses a spawn on a plan whose page
// has no record with the plan's current hash; a plan with no page predates the convention and is left alone.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import * as q from "./queue/lib.ts";

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
	via: "page";
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

function writePlanApprovals(approvals: Record<string, PlanApproval>): void {
	try {
		mkdirSync(q.STATE_DIR, { recursive: true });
		writeFileSync(planApprovalsFile(), JSON.stringify({ approvals }, null, 1));
	} catch {
		// plan approval is best-effort: if the state dir is not writable, the guard simply refuses the spawn
	}
}

function readPlanApproval(file: string): PlanApproval | null {
	return readPlanApprovals()[file] ?? null;
}

/** The owner's click on a plan page: record a hash of the plan text in the queue state and return the page it approved. The plan file itself is never edited. */
export function approvePlanFile(file: string, page: string, now = new Date()): string {
	const text = readFileSync(file, "utf8");
	const approvals = readPlanApprovals();
	approvals[file] = { hash: reviewHash(text), at: now.getTime(), via: "page", page };
	writePlanApprovals(approvals);
	return `approved ${page}`;
}

/** Why a spawn may not run on this plan, or null; only a plan with a page in Base is gated. */
export function approvalProblem(text: string, file: string, pagesDir: string): string | null {
	const page = pageOfPlan(pagesDir, file);
	if (page === null) return null; // no page: the plan predates the convention, not gated
	const rec = readPlanApproval(file);
	if (rec !== null && rec.hash === reviewHash(text)) return null;
	return `plan ${file} has no approval record. The owner approves it from ${page} in Base.`;
}