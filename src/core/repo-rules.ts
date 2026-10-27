// Project rules reach the agent: a repo's own AGENTS.md (test lanes, no-push, conventions) the way
// Main gets the queue summary. The finder and the hash cache are host-neutral; the hook wiring
// (when an agent's context gets the text) is in src/adapters/<harness>/.
//
// The owner's burden rule is a neurastream rule, not a repo rule: it is read from
// templates/AGENTS.md, never copied here, so the template stays the one place it is written.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGENTS_TEMPLATE } from "./agents-md.ts";
import type { Config } from "./config.ts";
import { MAIN_PLAN_FILE } from "./guards.ts";
import { readPlans, repoRoot, sections, sha } from "./queue/lib.ts";

/** A repo's rules file and the text to inject (cut to `rules.max_bytes`). */
export interface RepoRules {
	path: string;
	text: string;
}

/** The file's text, or null when it is not there (a repo without AGENTS.md has no rules to inject). */
function readRules(file: string): { path: string; text: string } | null {
	try {
		return { path: file, text: readFileSync(file, "utf8") };
	} catch {
		return null;
	}
}

/**
 * The rules of the repo a plan is worked in: the plan's own checkout (git top of its main repo),
 * or — when the plan is worked in a linked worktree whose AGENTS.md differs — that worktree's.
 * Null when the repo has no AGENTS.md. Text past `rules.max_bytes` is cut and one line names the
 * file to read for the rest, so a huge rules file cannot fill a context.
 */
export function repoRules(cfg: Config, planPath: string): RepoRules | null {
	const repo = repoRoot(planPath);
	if (!repo) return null;
	const main = readRules(join(repo, "AGENTS.md"));
	// The Worktree line names where the plan's promises are made; it can carry its own rules.
	const worktree = MAIN_PLAN_FILE.test(planPath) ? readPlans([planPath])[0]?.worktree : null;
	const work = worktree && worktree !== repo ? readRules(join(worktree, "AGENTS.md")) : null;
	const rules = work && work.text !== main?.text ? work : main;
	if (!rules) return null;
	const max = cfg.rules.max_bytes;
	if (rules.text.length <= max) return rules;
	return { path: rules.path, text: `${rules.text.slice(0, max).trimEnd()}\n…cut, read ${rules.path}` };
}

/**
 * The owner's burden rule (the first bullet of the template's Plans section) as templates/AGENTS.md
 * words it. The rule text lives in the template only: nothing here repeats a word of it, so Main's
 * context and every implementer's read the same sentence. Empty when the template is unreadable.
 */
export function burdenRule(): string {
	let template: string;
	try {
		template = readFileSync(AGENTS_TEMPLATE, "utf8");
	} catch {
		return "";
	}
	const plans = sections(template).get("plans") ?? "";
	return plans.split("\n").find(line => line.startsWith("- ")) ?? "";
}

/** How many (session, file) hashes the cache keeps; beyond it the oldest entries are dropped. */
const KEEP = 200;

/**
 * True when this session has not been handed this file's current text yet; records the hash so the
 * next turn does not inject it again. A changed file hashes differently and comes back once. One
 * JSON file under `paths.queue_state`, bounded to the newest `KEEP` entries.
 */
export function rulesChanged(cfg: Config, session: string, path: string, text: string): boolean {
	const file = join(cfg.paths.queue_state, "repo-rules.json");
	const seen: Record<string, string> = {};
	try {
		const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
			for (const [key, hash] of Object.entries(parsed)) if (typeof hash === "string") seen[key] = hash;
	} catch {}
	const key = `${session}\u0000${path}`;
	const hash = sha(text);
	if (seen[key] === hash) return false;
	// Re-insert so the entry moves to the end: the file drops from the front.
	delete seen[key];
	seen[key] = hash;
	const keys = Object.keys(seen);
	for (const old of keys.slice(0, Math.max(0, keys.length - KEEP))) delete seen[old];
	try {
		mkdirSync(cfg.paths.queue_state, { recursive: true });
		writeFileSync(file, JSON.stringify(seen));
	} catch {}
	return true;
}
