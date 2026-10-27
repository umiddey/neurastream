// Plan approval from the plan's own diagram page (plan 20261026_0930 P9). A plan that has a page in
// Base is approved there — the Approve bar records `Approved: <date> (<page>)` in the plan — and a
// chat "go" is the same thing: Main writes the same line. `Approval: self — owner: "<his words>"`
// covers the plans he tells Main to do on its own. main-guard refuses a spawn on a plan that has a
// page and no line; a plan with no page predates the convention and is left alone.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const APPROVED = /^\s*(?:[-*]\s+)?Approved:.*$/im;
const SELF = /^\s*(?:[-*]\s+)?Approval:\s*self\b[^\n]*owner:\s*["\u201c][^"\u201d\n]+["\u201d]/im;

/** The plan file a page approves, or null when the page was published without `--plan`. */
export function planForPage(dir: string, name: string): string | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(join(dir, ".meta", `${name}.json`), "utf8"));
	} catch {
		return null;
	}
	const plan = parsed !== null && typeof parsed === "object" && "plan" in parsed ? parsed.plan : null;
	return typeof plan === "string" && plan !== "" ? plan : null;
}

/** Remember the plan a page approves: one small JSON beside the pages, never served. */
export function recordPlanForPage(dir: string, name: string, plan: string): void {
	mkdirSync(join(dir, ".meta"), { recursive: true });
	writeFileSync(join(dir, ".meta", `${name}.json`), JSON.stringify({ plan: resolve(plan) }));
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

export function isApproved(text: string): boolean {
	return APPROVED.test(text) || SELF.test(text);
}

export function isSelfApproved(text: string): boolean {
	return SELF.test(text);
}

export function approvalLine(page: string, now = new Date()): string {
	return `Approved: ${now.toISOString().slice(0, 10)} (${page})`;
}

/** The plan text with its approval line replaced, or added above the first `## ` section. */
export function recordApproval(text: string, page: string, now = new Date()): string {
	const line = approvalLine(page, now);
	if (APPROVED.test(text)) return text.replace(APPROVED, line);
	const at = text.search(/^## /m);
	return at < 0 ? `${text.replace(/\s*$/, "")}\n${line}\n` : `${text.slice(0, at)}${line}\n\n${text.slice(at)}`;
}

/** Write the owner's click into the plan and return the line it recorded. */
export function approvePlanFile(file: string, page: string, now = new Date()): string {
	writeFileSync(file, recordApproval(readFileSync(file, "utf8"), page, now));
	return approvalLine(page, now);
}

/** Why a spawn may not run on this plan, or null; only a plan with a page in Base is gated. */
export function approvalProblem(text: string, file: string, pagesDir: string): string | null {
	if (isApproved(text)) return null;
	const page = pageOfPlan(pagesDir, file);
	if (page === null) return null;
	return `plan ${file} has no "Approved:" line. The owner approves it from ${page} in Base, or the plan says Approval: self \u2014 owner: "<his words>".`;
}
