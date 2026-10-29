// Queue model: ONE index — the main index lists plan files, one absolute path per line (templates/queue/TEMPLATE.md).

import { createHash } from "node:crypto";
import { accessSync, appendFileSync, constants, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Config } from "../config.ts";

const HOME = os.homedir();
// Base set by applyQueueEnv from paths.agent_dir. Specific QUEUE_* vars still win.
function agentDir(): string {
	return process.env.QUEUE_AGENT ?? `${HOME}/.config/neurastream`;
}
export function indexPath(): string {
	return process.env.QUEUE_INDEX ?? `${agentDir()}/INDEX.md`;
}
/** FINISHED.md sits beside the main index: one short entry per closed plan. */
export function finishedPath(): string {
	return path.join(path.dirname(indexPath()), "FINISHED.md");
}
export function blockersDirPath(): string {
	return process.env.QUEUE_BLOCKERS ?? `${agentDir()}/blockers`;
}
export function stateDirPath(): string {
	return process.env.QUEUE_STATE ?? `${HOME}/.local/state/queue`;
}
// Import-time snapshots under the live lib's names; the bins import them as values.
// refreshQueuePaths() reassigns them after applyQueueEnv, so a static import still sees config.
export let INDEX = indexPath();
export let BLOCKERS_DIR = blockersDirPath();
export let STATE_DIR = stateDirPath();
export const BACKGROUND_MAX_LINES = 40;
export const SUB_WARN_CALLS = 90;
export const SUB_MAX_CALLS = 100;
const REQUIRED = ["goal", "forbidden", "blockers", "phases", "done check", "progress"] as const;
// Plans stamped at or after this must carry a "## Code read by Main" section; older plans are grandfathered.
const READ_CUTOVER = "20261021_0100";

export interface Blocker {
	script: string;
	args: string[];
}

export interface Plan {
	repo: string;
	file: string;
	text: string;
	status: "open" | "complete" | "cancelled" | null;
	blockers: Blocker[];
	doneCheck: string | null;
	worktree: string | null;
	branch: string | null;
	appliesTo: string[];
	waiting: boolean;
	waitingLine: string | null;
	/** What the owner should do. Null when the plan has no WAITING line. */
	waitingAsk: string | null;
	/** What stays stuck until then. Null when the line has no `— blocked:`. */
	waitingBlocked: string | null;
	/** Why Main cannot do it. Null when the line has no `— why you:`. */
	waitingWhy: string | null;
	waitsOn: string[];
	priorityId: string | null;
	/** First level-1 "# " heading in the plan, else the file basename. */
	title: string;
	/** Bullet lines under "## Goal", capped at 6. */
	goal: string[];
	/** Header line `Summary: <text>`, or null when the plan has none. */
	summary: string | null;
	/** Checkbox lines under `## Phases`: done is ticked `[x]`/`[X]`. */
	phases: { done: number; total: number };
	/** True when a phase is ticked, or `## Progress` has a real `- ` entry. */
	started: boolean;
	errors: string[];
}

export function expandHome(p: string): string {
	return p === "~" ? HOME : p.startsWith("~/") ? `${HOME}/${p.slice(2)}` : p;
}

export function sha(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function indexLines(file: string): string[] | null {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return null;
	}
	return text
		.split("\n")
		.map(l => l.trim().replace(/^[-*]\s+/, "").replace(/`/g, "").trim())
		.filter(Boolean);
}

// Relative lines resolve against `base` (default: the cwd); a repo INDEX.md passes its repo dir.
export function readIndex(file = indexPath(), base = process.cwd()): string[] {
	return [...new Set((indexLines(file) ?? []).map(l => path.resolve(base, expandHome(l))))];
}

export function sections(text: string): Map<string, string> {
	const out = new Map<string, string>();
	const parts = text.split(/^## /m);
	for (const chunk of parts.slice(1)) {
		const nl = chunk.indexOf("\n");
		const head = (nl === -1 ? chunk : chunk.slice(0, nl)).trim().toLowerCase();
		out.set(head, nl === -1 ? "" : chunk.slice(nl + 1));
	}
	return out;
}

function items(body: string): string[] {
	return body
		.split("\n")
		.map(l => l.trim().replace(/^[-*]\s+/, "").trim())
		.filter(l => l && !l.startsWith("<!--"));
}

export function outsideProgress(text: string): string {
	return text.replace(/^## Progress[^\n]*\n[\s\S]*?(?=^## |(?![\s\S]))/m, "## Progress\n");
}

export function progressBody(text: string): string {
	return sections(text).get("progress") ?? "";
}
/** Last real Progress bullet, collapsed to one line. Main-only lines and the archive pointer are not entries. */
export function lastProgressLine(text: string): string {
	let last = "";
	for (const line of progressBody(text).split("\n")) {
		if (/^\s*-\s+/.test(line) && !line.startsWith(POINTER_PREFIX)) last = line.replace(/^\s*-\s+/, "");
	}
	return last.replace(/\s+/g, " ").trim();
}

export type ProgressTrim = { body: string; moved: string; count: number };

// Entries start at a top-level "- " line. The pointer line that a trim leaves behind is not an entry,
// and Main-only lines (status, owner parking, plan waits, owner cancel, cancelled-list clearance) never move to the archive.
const POINTER_PREFIX = "- Older Progress entries:";
const MAIN_ONLY_LINE = /^\s*(?:[-*]\s+)?(Status:|WAITING on owner:|Waits on:|Cancelled by owner:|False positive:)/;

const WAITING_BLOCKED = " — blocked: ";
const WAITING_WHY = " — why you: ";

/** Split `WAITING on owner:` text. An old one-part line is ask only; a missing part is null. */
export function splitWaiting(line: string): { ask: string; blocked: string | null; why: string | null } {
	const marks: { at: number; kind: "blocked" | "why"; len: number }[] = [];
	const blockedAt = line.indexOf(WAITING_BLOCKED);
	const whyAt = line.indexOf(WAITING_WHY);
	if (blockedAt >= 0) marks.push({ at: blockedAt, kind: "blocked", len: WAITING_BLOCKED.length });
	if (whyAt >= 0) marks.push({ at: whyAt, kind: "why", len: WAITING_WHY.length });
	marks.sort((a, b) => a.at - b.at);
	if (marks.length === 0) return { ask: line.trim(), blocked: null, why: null };
	let blocked: string | null = null;
	let why: string | null = null;
	for (let i = 0; i < marks.length; i++) {
		const mark = marks[i]!;
		const end = i + 1 < marks.length ? marks[i + 1]!.at : line.length;
		const text = line.slice(mark.at + mark.len, end).trim();
		if (mark.kind === "blocked") blocked = text || null;
		else why = text || null;
	}
	return { ask: line.slice(0, marks[0]!.at).trim(), blocked, why };
}

/** Keep the first `keep` entries (the file lists them newest first) and move the rest. Pure. */
export function trimProgressBody(body: string, keep: number, pointer: string): ProgressTrim | undefined {
	const lines = body.split("\n").filter(l => !l.startsWith(POINTER_PREFIX));
	const starts = lines.flatMap((l, i) => (/^- /.test(l) && !MAIN_ONLY_LINE.test(l) ? [i] : []));
	if (starts.length <= keep) return undefined;
	const cut = starts[keep];
	const tail = lines.slice(cut);
	const pinned = tail.filter(l => MAIN_ONLY_LINE.test(l));
	const moved = tail.filter(l => !MAIN_ONLY_LINE.test(l));
	let end = moved.length;
	while (end > 0 && moved[end - 1] === "") end--;
	return {
		body: [...lines.slice(0, cut), ...pinned, pointer, ...moved.slice(end)].join("\n"),
		moved: moved.slice(0, end).join("\n"),
		count: starts.length - keep,
	};
}

/** Trim the `## Progress` body of a plan file in place and append the moved entries to its archive (newest batch on top). */
export function trimPlanProgress(planFile: string, keep: number): { count: number; archive: string; before: string; after: string } | undefined {
	const text = readFileSync(planFile, "utf8");
	const head = /^## Progress[^\n]*\n/m.exec(text);
	if (!head) return undefined;
	const start = head.index + head[0].length;
	const next = text.slice(start).search(/^## /m);
	const end = next === -1 ? text.length : start + next;
	const before = text.slice(start, end);
	const archiveName = `${path.basename(planFile, ".md")}-progress.md`;
	const res = trimProgressBody(before, keep, `- Older Progress entries: archive/${archiveName}`);
	if (!res) return undefined;
	const dir = path.join(path.dirname(planFile), "archive");
	const archive = path.join(dir, archiveName);
	const older = (existsSync(archive) ? readFileSync(archive, "utf8") : "").replace(/^# Progress archive:[^\n]*\n?/, "").trim();
	mkdirSync(dir, { recursive: true });
	writeFileSync(archive, `# Progress archive: ${path.basename(planFile)}\n\n${res.moved.trim()}\n${older ? `\n${older}\n` : ""}`);
	writeFileSync(planFile, text.slice(0, start) + res.body + text.slice(end));
	return { count: res.count, archive, before, after: res.body };
}

/** Number of ticked phase lines ("- [x]") in a plan. */
export function doneCount(text: string): number {
	return (text.match(/^\s*[-*] \[x\]/gm) ?? []).length;
}

export function statusOf(text: string): Plan["status"] {
	const m = progressBody(text).match(/^Status:\s*(\S+)\s*$/m);
	const st = m?.[1];
	if (st === "open" || st === "complete" || st === "cancelled") return st;
	return null;
}

function executable(p: string): boolean {
	try {
		accessSync(p, constants.X_OK);
		return statSync(p).isFile();
	} catch {
		return false;
	}
}

function headerField(text: string, name: string): string | null {
	const m = text.split(/^## /m)[0]?.match(new RegExp(`^${name}:\\s*(.+?)\\s*$`, "m"));
	const v = m?.[1];
	return v ? v.replace(/`/g, "").trim() || null : null;
}

/** A plan filename stamp (YYYYMMDD_HHMM) as an ISO-ish string ("2026-10-29T01:00") that sorts lexically; "" when unstamped. */
export function stampIso(file: string): string {
	const m = /^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})/.exec(path.basename(file));
	return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}` : "";
}

/**
 * The review gates (P1 reuse lines, P2 reviewer PASS) apply to a plan stamped at or after the
 * `review.since` cutover — a bare date counts as midnight; `since` "" switches them off.
 */
export function reviewApplies(file: string, since: string): boolean {
	const cutover = since.length === 10 ? `${since}T00:00` : since;
	return cutover.length > 0 && stampIso(file) >= cutover;
}

/**
 * P1 (plan 20261028_1600): every new thing a plan adds carries a reuse line with a checked
 * `path:line` citation that exists relative to the plan's repo. Plans stamped before the
 * `review.since` cutover are exempt.
 */
function reuseProblems(repo: string, file: string, secs: Map<string, string>, since: string): string[] {
	if (!reviewApplies(file, since)) return [];
	const lines = items(secs.get("reuse") ?? "");
	if (!lines.length)
		return [`missing or empty "## Reuse" section (one line per new thing: - new: <thing> — checked: <path>:<line> — reuse: <how, or why not>; "- new: none — ..." when nothing is new)`];
	const probs: string[] = [];
	for (const line of lines) {
		const m = /checked:\s*`?([^`\s—]+):(\d+)(?:-\d+)?`?/.exec(line);
		if (!m) probs.push(`reuse line without "checked: <path>:<line>": ${line.slice(0, 80)}`);
		else if (!existsSync(path.resolve(repo, m[1]!))) probs.push(`reuse citation does not exist: ${m[1]}`);
	}
	return probs;
}

export function parsePlan(repo: string, file: string, text: string | null, blockersDir = blockersDirPath(), reviewSince = ""): Plan {
	const empty = { repo, file, text: "", status: null, blockers: [], doneCheck: null, worktree: null, branch: null, appliesTo: [], waiting: false, waitingLine: null, waitingAsk: null, waitingBlocked: null, waitingWhy: null, waitsOn: [], priorityId: null, title: path.basename(file), goal: [], summary: null, phases: { done: 0, total: 0 }, started: false };
	if (text === null) return { ...empty, errors: ["plan file listed in the index does not exist"] };
	const errors: string[] = [];
	const secs = sections(text);
	for (const s of REQUIRED) {
		if (s === "progress" ? !secs.has(s) : !items(secs.get(s) ?? "").length)
			errors.push(`missing or empty "## ${s.replace(/^\w/, c => c.toUpperCase())}" section (template: ${agentDir()}/queue/TEMPLATE.md)`);
	}
	const stamp = /^(\d{8}_\d{4})/.exec(path.basename(file))?.[1] ?? "";
	if (stamp >= READ_CUTOVER && !items(secs.get("code read by main") ?? "").length)
		errors.push(`missing or empty "## Code read by Main" section (plans stamped ${READ_CUTOVER} or later list each file they cite)`);
	for (const problem of reuseProblems(repo, file, secs, reviewSince)) errors.push(problem);
	const known = new Set([...REQUIRED, "applies to", "background", "code read by main", "reuse"]);
	for (const s of secs.keys()) if (!known.has(s)) errors.push(`unknown section "## ${s}" (allowed: ${[...known].join(", ")})`);
	const status = statusOf(text);
	if (!status) errors.push('"## Progress" must start with a line "Status: open", "Status: complete" or "Status: cancelled"');
	if (status === "cancelled" && !/^Cancelled by owner:\s*\S.{5,}/m.test(progressBody(text)))
		errors.push('a cancelled plan needs a Progress line: Cancelled by owner: <date> "<the owner\'s words>"');
	const blockers: Blocker[] = [];
	for (const line of items(secs.get("blockers") ?? "")) {
		const [ref = "", ...args] = line.replace(/`/g, "").split(/\s+/);
		const script = ref.includes("/") ? path.resolve(path.dirname(file), expandHome(ref)) : path.join(blockersDir, ref);
		if (!executable(script)) errors.push(`blocker "${ref}": ${script} missing or not executable`);
		blockers.push({ script, args });
	}
	const phaseLines = items(secs.get("phases") ?? "").filter(l => /^\[[ xX]\]/.test(l));
	if (secs.has("phases") && !phaseLines.length) errors.push('"## Phases" needs checkbox lines: "- [ ] P1 <what> — verify: `<command>`"');
	for (const p of phaseLines) if (!/verify:\s*`[^`]+`/.test(p)) errors.push(`phase without "verify: \`<command>\`": ${p.slice(0, 60)}`);
	const phases = { total: phaseLines.length, done: phaseLines.filter(l => /^\[[xX]\]/.test(l)).length };
	const started = phases.done > 0 || progressBody(text).split("\n").some(l => /^- /.test(l) && !l.startsWith(POINTER_PREFIX) && !MAIN_ONLY_LINE.test(l));
	const dc = (secs.get("done check") ?? "").match(/```[a-z]*\n([\s\S]*?)```|`([^`\n]+)`/);
	const doneCheck = dc ? (dc[1] ?? dc[2] ?? "").trim() : null;
	if (secs.has("done check") && !doneCheck) errors.push('"## Done check" needs one command in backticks (exit 0 = done)');
	const bg = (secs.get("background") ?? "").split("\n").filter(l => l.trim()).length;
	if (bg > BACKGROUND_MAX_LINES) errors.push(`"## Background" has ${bg} lines (max ${BACKGROUND_MAX_LINES}); link a separate file for long context`);
	const wt = headerField(text, "Worktree");
	const waitingLine = text.match(/^WAITING on owner:[ \t]*(.*)$/m)?.[1] ?? null;
	const waitingParts = waitingLine === null ? { ask: null, blocked: null, why: null } : splitWaiting(waitingLine);
	return {
		repo,
		file,
		text,
		status,
		blockers,
		doneCheck,
		worktree: wt && wt !== "-" ? path.resolve(expandHome(wt)) : null,
		branch: headerField(text, "Branch")?.replace(/^-$/, "") || null,
		appliesTo: items(secs.get("applies to") ?? "").map(p => path.resolve(repo, expandHome(p.replace(/`/g, "")))),
		waiting: /^WAITING on owner:/m.test(text),
		waitingLine,
		waitingAsk: waitingParts.ask,
		waitingBlocked: waitingParts.blocked,
		waitingWhy: waitingParts.why,
		waitsOn: [...text.matchAll(/^[ \t]*(?:[-*][ \t]+)?Waits on:[ \t]*(.+)$/gm)].map(m => m[1]!.trim()),
		priorityId: text.match(/^PRIORITY-ID:\s*`?([A-Z]{2}[0-9]{2})`?/m)?.[1] ?? null,
		title: text.match(/^# (.+)$/m)?.[1]?.trim() || path.basename(file),
		goal: items(secs.get("goal") ?? "").slice(0, 6),
		summary: headerField(text, "Summary"),
		phases,
		started,
		errors,
	};
}

/** A plan's repo: the main checkout holding the plan file; a linked worktree resolves to its main repo; without git, an archived plan reports the repo dir above docs/plans/archive/<YYYYMM>, never the month folder. */
export function planRepo(file: string): string {
	const root = repoRoot(file);
	if (root) return root;
	const dir = path.dirname(file);
	const m = /^(.*\/)docs\/plans\/archive\/\d{6}$/.exec(dir);
	return m?.[1] ? m[1].replace(/\/$/, "") : dir;
}

export function readPlans(files: string[], blockersDir = blockersDirPath(), reviewSince = ""): Plan[] {
	return files.map(file => {
		let text: string | null = null;
		try {
			text = readFileSync(file, "utf8");
		} catch {}
		return parsePlan(planRepo(file), file, text, blockersDir, reviewSince);
	});
}

export function activePlans(index = indexPath(), blockersDir = blockersDirPath(), reviewSince = ""): Plan[] {
	return readPlans(readIndex(index), blockersDir, reviewSince);
}

/** Owner holds: one line per plan with a WAITING on owner line. The only real holds; the summary, the rollover context and the handoff all read them here. */
export function ownerHolds(index = INDEX): string[] {
	return activePlans(index)
		.filter(p => p.waiting)
		.map(p => `${p.file}: WAITING on owner: ${p.waitingLine ?? ""}`);
}

export function gitTop(p: string): { top: string; repo: string } | null {
	let dir = path.resolve(p);
	for (;;) {
		const git = path.join(dir, ".git");
		let st: ReturnType<typeof statSync> | null = null;
		try {
			st = statSync(git);
		} catch {}
		if (st?.isDirectory()) return { top: dir, repo: dir };
		if (st?.isFile()) {
			const m = readFileSync(git, "utf8").match(/^gitdir:\s*(.+)$/m);
			const gd = m ? path.resolve(dir, (m[1] ?? "").trim()) : "";
			const w = gd.match(/^(.*)\/\.git\/worktrees\/[^/]+$/);
			return { top: dir, repo: w?.[1] ?? dir };
		}
		const up = path.dirname(dir);
		if (up === dir) return null;
		dir = up;
	}
}

export function repoRoot(p: string): string | null {
	return gitTop(p)?.repo ?? null;
}

function under(p: string, root: string): boolean {
	return p === root || p.startsWith(`${root}/`);
}

export function planCovers(plan: Plan, p: string, plans: Plan[] = []): boolean {
	// One plan = one worktree (0.2.0 one-index): a linked worktree that another open plan names
	// as its Worktree is that plan's ground, so this plan covers such a path only through its
	// own Worktree or ## Applies to — the repo-level fallback below must not claim every
	// worktree of the shared repo. Paths in the main checkout and in worktrees no open plan
	// names stay covered as before (safe default).
	const g = gitTop(p);
	if (g && plans.some(o => o !== plan && o.status === "open" && o.worktree && o.worktree === g.top))
		return plan.appliesTo.some(a => under(p, a)) || (!!plan.worktree && under(p, plan.worktree));
	return under(p, plan.repo) || plan.appliesTo.some(a => under(p, a)) || (!!plan.worktree && under(p, plan.worktree)) || repoRoot(p) === plan.repo;
}

export function planAt(p: string, plans: Plan[]): Plan | null {
	const clean = p.replace(/:[\d+\-,]*(:raw)?$|:raw(:[\d+\-,]+)?$/, "");
	const exact = plans.find(pl => pl.file === clean || pl.file === p);
	if (exact) return exact;
	const g = gitTop(clean);
	if (!g) return null;
	const rel = path.relative(g.top, clean);
	return plans.find(pl => pl.repo === g.repo && path.relative(pl.repo, pl.file) === rel) ?? null;
}

export function isOrchestrationPath(p: string, plans: Plan[] = activePlans()): boolean {
	if (p === INDEX || p === indexPath()) return true;
	if (planAt(p, plans)) return true;
	return plans.some(pl => pl.blockers.some(b => b.script === p));
}

const SHELL_TOOLS = new Set(["bash", "eval"]);
// A shell command is a list of segments; each `cd` segment moves the directory for the ones after it.
const SHELL_SEGMENT = /&&|\|\||[;|\n]/;
const CD_SEGMENT = /^\s*cd\s+(\S+)/;

/** The directory a shell command leaves in effect: `base`, moved by each `cd` segment in order. */
export function shellCwd(command: string, base: string): string {
	let dir = base;
	for (const seg of command.split(SHELL_SEGMENT)) {
		const cd = CD_SEGMENT.exec(seg);
		if (cd) dir = path.resolve(dir, expandHome(cd[1] ?? ""));
	}
	return dir;
}
export function touchedPaths(toolName: string, input: Record<string, unknown>, cwd: string): string[] {
	const out = new Set<string>();
	const base = typeof input?.cwd === "string" ? path.resolve(cwd, expandHome(input.cwd)) : cwd;
	const add = (raw: string, from = base) => {
		const s = expandHome(raw.trim().replace(/:[\d+\-,]*(:raw)?$|:raw(:[\d+\-,]+)?$/, ""));
		if (!s || s.includes("://")) return;
		out.add(path.resolve(from, s));
	};
	for (const key of ["path", "file"]) {
		const v = input?.[key];
		if (typeof v === "string") for (const part of v.split(";")) add(part.replace(/:[\d+\-,]*(:raw)?$|:raw(:[\d+\-,]+)?$/, ""));
	}
	const text = JSON.stringify(input ?? {});
	for (const m of text.matchAll(/\[([^\]\s#]+)#[0-9A-Fa-f]{4}\]/g)) add(m[1] ?? "");
	for (const m of text.matchAll(/(?:^|[\s"'=:([])((?:~|\/)[^\s"'`;|&)\]\\]+)/g)) {
		const tok = (m[1] ?? "").replace(/#[0-9A-Fa-f]{4}$/, "");
		if (tok.startsWith("~") || tok.split("/").length > 2) add(tok);
	}
	if (SHELL_TOOLS.has(toolName)) {
		out.add(base);
		let dir = base;
		for (const seg of String(input?.command ?? input?.code ?? "").split(SHELL_SEGMENT)) {
			for (const word of seg.split(/[\s<>()'"`,=]+/)) {
				const w = word.trim();
				if (!w || w.startsWith("-") || w.includes("://") || !/[./]/.test(w) || /^\d+(\.\d+)*$/.test(w)) continue;
				add(w, dir);
			}
			const cd = CD_SEGMENT.exec(seg);
			if (cd) dir = path.resolve(dir, expandHome(cd[1] ?? ""));
		}
	}
	return [...out];
}

export const MUTATING =
	/(\brm\b|\bmv\b|\bcp\b|\btouch\b|\btruncate\b|\bchmod\b|\bln\b|\bsed\s+(-\w*\s+)*-i|\bperl\s+(-\w*\s+)*-[a-z]*i|\btee\b|(^|[^0-9&>=\-])>{1,2}\s*[^\s&>]|\bgit\s+(rm|mv|checkout|restore|apply|am|stash|reset|clean)\b|\bpatch\b|\binstall\b|\bdd\b|writeFile|appendFile|Bun\.write|unlink|rmSync|\.write_text\(|\.write_bytes\(|\bopen\([^)]*,\s*["'][wax]b?\+?["']|shutil\.|os\.(remove|rename|replace|unlink|chmod)|\.writelines\()/;

export function withoutQuotedRedirects(code: string): string {
	return code.replace(/'[^']*'/g, m => m.replace(/>/g, " ")).replace(/"(?:[^"\\]|\\.)*"/g, m => m.replace(/>/g, " "));
}

export function changesFiles(toolName: string, input: Record<string, unknown>): boolean {
	if (toolName === "edit" || toolName === "ast_edit") return true;
	if (toolName === "write") return true;
	return SHELL_TOOLS.has(toolName) && MUTATING.test(withoutQuotedRedirects(String(input?.command ?? input?.code ?? "")));
}

// P8: package-manager and cutover commands change the running guard package.
// Their write target is the protected root they touch, so the ordinary
// protected-path check refuses them without the owner's unlock. Matched per
// shell segment, with leading KEY=VALUE assignments stripped; the cutover
// scripts stay free when the same segment pins HOME to /tmp (how every sandbox
// test and the P9 session test run them). Harness-owned command shapes are NOT
// matched here: the adapter registers them through registerPackageOpTarget,
// because core never names a harness.
function isNeurastreamSpec(t: string): boolean {
	const base = t.replace(/^["']|["']$/g, "").replace(/^\.?\//, "").replace(/^.*\//, "");
	return base === "neurastream" || base.startsWith("neurastream@") || /^neurastream-[^/]*\.tgz$/.test(base);
}

// Adapter-registered matcher for harness package operations (plugin install,
// link, ...). Returns the protected root the command writes, or null.
export type PackageOpMatcher = (code: string) => string | null;
export let packageOpMatcher: PackageOpMatcher | null = null;

export function registerPackageOpTarget(fn: PackageOpMatcher): void {
	packageOpMatcher = fn;
}

function packageOpTarget(code: string): string | null {
	for (const seg of code.split(/&&|\|\||;|\n|\|/)) {
		const toks = seg.trim().split(/\s+/).filter(Boolean);
		let i = 0;
		while (i < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i] ?? "")) i++;
		const cmd = (toks[i] ?? "").replace(/^["']|["']$/g, "").replace(/^.*\//, "");
		const rest = toks.slice(i + 1).map(t => t.replace(/^["']+|["']+$/g, ""));
		const sub = rest[0] ?? "";
		const hasGlobal = rest.some(t => t === "-g" || t === "--global");
		const names = rest.slice(1).filter(t => !t.startsWith("-"));
		if (cmd === "bun" && ["add", "install", "remove", "rm", "update", "link", "unlink"].includes(sub) && hasGlobal) {
			if (!names.length || names.some(isNeurastreamSpec)) return `${bunGlobalRoot()}/install/global/node_modules/neurastream`;
			continue;
		}
		if (cmd === "npm" && ["install", "i", "uninstall", "update", "link"].includes(sub) && hasGlobal) {
			if (!names.length || names.some(isNeurastreamSpec)) return `${bunGlobalRoot()}/install/global/node_modules/neurastream`;
			continue;
		}
		if (cmd === "neurastream" && sub === "adapter" && ["install", "uninstall"].includes(rest[1] ?? ""))
			return `${bunGlobalRoot()}/install/global/node_modules/neurastream`;
		if ((cmd === "bash" || cmd === "sh") && rest.some(t => {
			const base = t.replace(/^.*\//, "");
			return base === "cutover.sh" || base === "rollback.sh";
		})) {
			const envHome = toks.slice(0, i).find(t => t.startsWith("HOME="));
			if (envHome && envHome.slice("HOME=".length).replace(/^["']|["']$/g, "").startsWith("/tmp/")) continue;
			return `${agentDir()}/extensions/`;
		}
	}
	return packageOpMatcher?.(code) ?? null;
}

// Heredoc bodies are data, not commands: a `<<WORD` body (up to a line that is
// exactly WORD; leading tabs are ignored for `<<-`) is dropped from the text the
// redirect and command-word scans read. The line that opens the heredoc stays,
// so its own redirects (`cat <<EOF > out.txt`) still count. An unterminated
// heredoc is kept as command text: failing open would hide real writes.
const HEREDOC_START = /(?<!<)<<(-?)\s*\\?(["']?)([A-Za-z_][A-Za-z0-9_]*)\2/g;
function withoutHeredocBodies(code: string): string {
	const lines = code.split("\n");
	const keep: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		keep.push(line);
		for (const m of line.matchAll(HEREDOC_START)) {
			const word = m[3] ?? "";
			const dash = m[1] === "-";
			const end = lines.findIndex((l, j) => j > i && (dash ? l.replace(/^\t+/, "") : l) === word);
			if (end > i) i = end;
		}
	}
	return keep.join("\n");
}

// `neurastream agents allow|deny` and `neurastream init --allow` edit the subagent allow-list,
// a protected guard file, so they count as writes to it (also when run as `bun .../src/cli/main.ts`).
function subagentsOpWrites(code: string): boolean {
	for (const seg of code.split(/&&|\|\||;|\n|\|/)) {
		const toks = seg.trim().split(/\s+/).filter(Boolean);
		let i = 0;
		while (i < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i] ?? "")) i++;
		const cmd = (toks[i] ?? "").replace(/^["']|["']$/g, "").replace(/^.*\//, "");
		const rest = toks.slice(i + 1).map(t => t.replace(/^["']+|["']+$/g, ""));
		const off = cmd === "neurastream" ? 0 : cmd === "bun" && (rest[0] ?? "").endsWith("src/cli/main.ts") ? 1 : -1;
		if (off < 0) continue;
		const sub = rest[off] ?? "";
		if (sub === "agents" && ["allow", "deny"].includes(rest[off + 1] ?? "")) return true;
		if (sub === "init" && rest.some(t => t === "--allow" || t.startsWith("--allow="))) return true;
	}
	return false;
}

export function writeTargets(toolName: string, input: Record<string, unknown>, cwd: string): string[] {
	const out = new Set<string>();
	const add = (raw: string, from: string) => {
		const s = expandHome(String(raw).trim().replace(/^["']|["']$/g, ""));
		if (!s || s.includes("://") || s.startsWith("$") || s === "/dev/null" || s.startsWith("/dev/")) return;
		out.add(path.resolve(from, s));
	};
	if (toolName === "write") {
		const target = String(input?.path ?? "");
		if (target === "xd://ast_edit") {
			let spec: Record<string, unknown> = {};
			try {
				spec = JSON.parse(String(input?.content ?? "{}"));
			} catch {}
			if (typeof spec.path === "string") add(spec.path, cwd);
		} else if (!target.startsWith("xd://")) add(target.replace(/:raw$/, ""), cwd);
		return [...out];
	}
	if (toolName === "edit") {
		const target = typeof input?.path === "string" ? input.path : typeof input?.file === "string" ? input.file : "";
		if (target) add(target, cwd);
		for (const m of String(input?.input ?? "").matchAll(/^\[([^\]\n]+?)#[0-9A-Fa-f]{4}\]/gm)) add(m[1] ?? "", cwd);
		return [...out];
	}
	if (toolName === "ast_edit") {
		if (typeof input?.path === "string") add(input.path, cwd);
		return [...out];
	}
	if (!SHELL_TOOLS.has(toolName)) return [];
	const code = String(input?.command ?? input?.code ?? "");
	// A package/plugin/cutover command is a write even though none of the
	// generic mutating heuristics fire on its text.
	const pkgOp = packageOpTarget(code);
	const subOp = subagentsOpWrites(code);
	if (!MUTATING.test(withoutQuotedRedirects(code)) && !pkgOp && !subOp) return [];
	let dir = typeof input?.cwd === "string" ? path.resolve(cwd, expandHome(input.cwd)) : cwd;
	for (const seg of withoutHeredocBodies(code).split(/&&|\|\||;|\n|\|/)) {
		const s = seg.trim();
		const cd = s.match(/^cd\s+(\S+)/);
		if (cd) {
			dir = path.resolve(dir, expandHome((cd[1] ?? "").replace(/^["']|["']$/g, "")));
			continue;
		}
		const noQuotedRedirect = withoutQuotedRedirects(s);
		for (const m of noQuotedRedirect.matchAll(/(?:^|[^0-9&>=\-])>{1,2}\s*([^\s&|;)<>]+)/g)) {
			// A target with no letter, digit, `.` or `/` (`>,`) is prose, not a file.
			const target = (m[1] ?? "").replace(/^["']|["']$/g, "");
			if (/[\p{L}\p{N}./]/u.test(target)) add(target, dir);
		}
		const words = s.split(/\s+/).filter(Boolean);
		const cmd = words[0]?.replace(/^.*\//, "") ?? "";
		const args = words.slice(1).filter(w => !w.startsWith("-"));
		if (["rm", "mv", "touch", "truncate", "chmod", "ln", "tee", "unlink", "rmdir", "mkdir"].includes(cmd))
			for (const a of cmd === "chmod" ? args.slice(1) : args) add(a, dir);
		if (["cp", "install"].includes(cmd) && args.length) add(args[args.length - 1] ?? "", dir);
		if ((cmd === "sed" && /\s-[a-zA-Z]*i/.test(s)) || (cmd === "perl" && /\s-[a-z]*i/.test(s)))
			for (const a of args.slice(1)) add(a, dir);
		const g = s.match(/^git\s+(?:-C\s+(\S+)\s+)?(rm|mv|checkout|restore|apply|am|stash|reset|clean)\b/);
		if (g && !(g[2] === "checkout" && /\s-b\s/.test(s)) && !(g[2] === "reset" && !/--hard/.test(s)))
			add(g[1] ?? ".", dir);
	}
	for (const re of [
		/\bopen\(\s*(["'][^"']+["'])\s*,\s*["'][wax]b?\+?["']/g,
		/\bPath\(\s*(["'][^"']+["'])\s*\)\.(?:write_text|write_bytes|unlink|rename|touch|mkdir)\(/g,
		/\b(?:writeFileSync|writeFile|appendFileSync|appendFile|Bun\.write|rmSync|unlinkSync)\(\s*(["'`][^"'`]+["'`])/g,
		/\bos\.(?:remove|unlink|rename|replace)\(\s*(["'][^"']+["'])/g,
		/\bshutil\.\w+\(\s*["'][^"']+["']\s*,\s*(["'][^"']+["'])/g,
	])
		for (const m of code.matchAll(re)) add((m[1] ?? "").replace(/`/g, ""), dir);
	if (pkgOp) out.add(pkgOp);
	if (subOp) out.add(subagentsPath());
	return [...out];
}

export function unlockPath(): string {
	return process.env.QUEUE_UNLOCK ?? `${agentDir()}/.guard-unlock`;
}
export let UNLOCK = unlockPath();
export const UNLOCK_MINUTES = 30;
// P8 (2026-10-21): after the npm cutover the running guards load from the
// installed package, so the package itself is guard surface. The package root
// is only claimed when this file really is part of a published neurastream
// package (package.json name check): the pre-cutover standalone copy under
// <agent>/queue/ has no package.json above it and must not protect the home.
function packageManifest(): { root: string; bins: string[] } | null {
	try {
		const root = realpathSync(path.resolve(path.dirname(import.meta.path), "..", "..", ".."));
		const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { name?: string; bin?: Record<string, string> };
		if (pkg.name !== "neurastream") return null;
		return { root, bins: Object.keys(pkg.bin ?? {}) };
	} catch {
		return null;
	}
}

function bunGlobalRoot(): string {
	return process.env.BUN_INSTALL ? path.resolve(expandHome(process.env.BUN_INSTALL)) : `${HOME}/.bun`;
}

function protectedPaths(): string[] {
	const agent = agentDir();
	const paths = [
		`${agent}/extensions/`,
		`${agent}/queue/`,
		`${agent}/blockers/`,
		`${agent}/agents/`,
		`${agent}/AGENTS.md`,
		`${agent}/CANCELLED.md`,
		`${stateDirPath()}/`,
		`${agent}/config.yml`,
		// The user's neurastream config file, even when agent_dir points elsewhere: an agent that
		// could rewrite it could point notify at its own webhook.
		`${HOME}/.config/neurastream/config.yml`,
		`${agent}/notes/subagents.md`,
		`${agent}/.guard-unlock`,
		`${path.dirname(agent)}/git-no-verify-guard.mjs`,
		`${HOME}/.local/bin/queue-check`,
		`${HOME}/.local/bin/queue-close`,
		`${HOME}/.local/bin/queue-cancel`,
		`${HOME}/.local/bin/agent-ledger`,
		`${HOME}/.local/bin/brief-lint`,
		`${HOME}/.local/bin/main-start`,
		`${HOME}/.local/bin/git`,
		`${HOME}/.local/bin/git-secret-gate`,
		`${HOME}/.config/git-secret-gate/`,
		// Where `bun add -g neurastream` lands; writeTargets points package
		// operations here so they need the owner's unlock like any guard edit.
		// The plugin dir is adapter surface: the installer lists it in the
		// config's guards.protected (core never names a harness path).
		`${bunGlobalRoot()}/install/global/node_modules/neurastream/`,
	];
	const pkg = packageManifest();
	if (pkg) {
		paths.push(`${pkg.root}/`);
		for (const name of pkg.bins) paths.push(`${HOME}/.bun/bin/${name}`);
	}
	return paths;
}
export let PROTECTED = protectedPaths();

export function unlocked(): boolean {
	try {
		return Date.now() - statSync(UNLOCK).mtimeMs < UNLOCK_MINUTES * 60_000;
	} catch {
		return false;
	}
}

export interface ChatUnlockResult {
	/** True when the text was a whole-message unlock/lock command that took effect. */
	applied: boolean;
	command?: "unlock" | "lock";
	/** For an unlock: the minutes the existing mtime window stays open (for the owner notice). */
	minutes?: number;
	/** For an unlock: epoch seconds when the guard window closes (mtime + unlock_minutes). */
	until?: number;
}

const CHAT_CMD = /^(unlock|lock)(?:\s+(\d+))?$/i;

/**
 * Owner unlock by chat (guards.chat_unlock): the whole trimmed message, case-insensitive —
 * "unlock" (open for guards.unlock_minutes), "unlock N" (open for exactly N minutes, N clamped
 * to 1..unlock_minutes) or "lock" (close again). Only the adapter and the owner page call this,
 * with text the owner really typed or tapped; a model, a tool result or a machine prompt must
 * never reach it. The file is written or removed from the extension process (or the ui server),
 * not through a tool call, so plan-guard does not see the write. Every applied unlock/lock is
 * logged to the plan-guard log with `word` naming the entry point ("chat" or "ui").
 */
export function chatUnlock(text: string, cfg: Config, source: string, word: "chat" | "ui" = "chat"): ChatUnlockResult {
	if (!cfg.guards.chat_unlock) return { applied: false };
	const m = CHAT_CMD.exec(text.trim());
	if (!m) return { applied: false };
	const minutes = cfg.guards.unlock_minutes;
	if ((m[1] ?? "").toLowerCase() === "lock") {
		rmSync(unlockPath(), { force: true });
		try {
			appendFileSync(cfg.paths.plan_guard_log, `${new Date().toISOString()} LOCK ${word} source=${source}\n`);
		} catch {}
		return { applied: true, command: "lock" };
	}
	const want = m[2] === undefined ? minutes : Number(m[2]);
	if (want < 1) return { applied: false }; // "unlock 0" is no unlock
	const n = Math.min(want, minutes);
	const file = unlockPath();
	writeFileSync(file, "");
	// Backdate the mtime so the existing window (mtime + unlock_minutes) closes after exactly n minutes.
	const past = (Date.now() - (minutes - n) * 60_000) / 1000; // utimesSync takes seconds
	utimesSync(file, past, past);
	try {
		appendFileSync(cfg.paths.plan_guard_log, `${new Date().toISOString()} UNLOCK ${word} source=${source} minutes=${n}\n`);
	} catch {}
	return { applied: true, command: "unlock", minutes: n, until: Math.floor(past + minutes * 60) };
}

export function protectedHit(paths: string[]): string | null {
	for (const p of paths) for (const g of PROTECTED) if (g.endsWith("/") ? p.startsWith(g) || `${p}/` === g : p === g) return p;
	return null;
}

export function subagentsPath(): string {
	return process.env.QUEUE_SUBAGENTS ?? `${agentDir()}/notes/subagents.md`;
}
export let SUBAGENTS_MD = subagentsPath();
export function allowedAgents(file = subagentsPath()): Set<string> {
	let text = "";
	try {
		text = readFileSync(file, "utf8");
	} catch {}
	const body = sections(text).get("allowed") ?? "";
	return new Set([...body.matchAll(/^\s*[-*]\s+`([a-z0-9-]+)`/gm)].map(m => m[1] ?? ""));
}

// P4d (plan 20261028_1600): a review spawn runs under a review.agents entry that Main may spawn
// (## Allowed of the subagents file). None allowed is a problem: every review spawn is refused.
// An entry not allowed is a warning: it can never run a review spawn.
export function reviewAgentsProblem(cfg: Config, allowed: Set<string>): { problem: string | null; warnings: string[] } {
	const agents = cfg.review.agents;
	const warnings = agents
		.filter(a => !allowed.has(a))
		.map(a => `review.agents lists "${a}", which is not in "## Allowed" of ${cfg.paths.subagents}; it cannot run a review spawn`);
	const problem = agents.some(a => allowed.has(a))
		? null
		: `no review.agents entry is in "## Allowed" of ${cfg.paths.subagents}: set review.agents to an allowed agent in config.yml`;
	return { problem, warnings };
}

export const CANCELLED_REL = "docs/plans/CANCELLED.md";
export function globalCancelledPath(): string {
	return process.env.QUEUE_CANCELLED ?? `${agentDir()}/CANCELLED.md`;
}
export let GLOBAL_CANCELLED = globalCancelledPath();
export function cancelledFile(repo: string): string {
	return path.join(repo, CANCELLED_REL);
}
const STOP = new Set(
	"about after again also among another before being both could does done each every from have here into just like make many more most much must need never only other over same should some such than that their them then there these they this those through under until very want what when where which while will with within without would your yours plan plans goal owner main agent agents work file files".split(
		" ",
	),
);
function keyWords(text: string): string[] {
	const words = text.toLowerCase().match(/[a-z0-9][a-z0-9_.-]{3,}/g) ?? [];
	return [...new Set(words.map(w => w.replace(/[._-]+$/, "")).filter(w => w.length >= 4 && !STOP.has(w)))].sort();
}
export function planWords(text: string): string[] {
	const title = text.match(/^# (.+)$/m)?.[1] ?? "";
	return keyWords(`${title} ${items(sections(text).get("goal") ?? "").join(" ")}`);
}
export interface CancelledEntry {
	name: string;
	date: string;
	owner: string;
	words: string[];
	list: string;
}
function readList(file: string): CancelledEntry[] {
	let text = "";
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return [];
	}
	const out: CancelledEntry[] = [];
	for (const line of text.split("\n")) {
		const m = line.match(/^\s*[-*]\s+(\S+)\s*\|\s*([^|]*?)\s*\|\s*owner:\s*([^|]*?)\s*\|\s*words:\s*(.*)$/);
		if (m) out.push({ name: m[1] ?? "", date: m[2] ?? "", owner: m[3] ?? "", words: (m[4] ?? "").split(/\s+/).filter(Boolean), list: file });
	}
	return out;
}
export function readCancelled(repo: string): CancelledEntry[] {
	return readList(cancelledFile(repo));
}
export function readGlobalCancelled(): CancelledEntry[] {
	return readList(globalCancelledPath());
}
export function banLine(what: string, owner: string, date: string): string {
	const words = keyWords(what);
	const name = `ban-${words.slice(0, 4).join("-") || "x"}-${sha(`${what}${date}`).slice(0, 4)}`;
	return `- ${name} | ${date} | owner: ${owner.replace(/[|\n]/g, "/")} — never: ${what.replace(/[|\n]/g, "/")} | words: ${words.join(" ")}`;
}
export function cancelledLine(file: string, text: string, date: string): string {
	const owner = (progressBody(text).match(/^Cancelled by owner:\s*(.+?)\s*$/m)?.[1] ?? "").replace(/\|/g, "/");
	return `- ${path.basename(file)} | ${date} | owner: ${owner} | words: ${planWords(text).join(" ")}`;
}
const FINISHED_HEADER = "# Finished plans (newest first; written by queue-close and queue-finished)\n";

/** Heading plus at most 4 body lines: Summary, Result, Plan path. */
export function finishedEntry(plan: Plan, archived: string, date: string): string {
	const summary = (plan.summary ?? plan.goal[0] ?? "").replace(/\s+/g, " ").trim();
	const result = lastProgressLine(plan.text);
	const body = [`Summary: ${summary}`, `Result: ${result}`, `Plan: ${path.resolve(archived)}`];
	return [`## ${date} · ${path.basename(plan.repo)} · ${plan.title}`, ...body].join("\n");
}

/** Identity of a finished entry: its repo name and archived plan file name. Worktrees of one repo share it. */
export function finishedKey(entry: string): string {
	const lines = entry.split("\n");
	const repo = (lines[0] ?? "").split(" · ")[1] ?? "";
	return `${repo}\n${path.basename(lines.find(l => l.startsWith("Plan: ")) ?? "")}`;
}

/** Inserts the entry above older ones. Returns false when that repo's plan file is already listed. */
export function prependFinished(entry: string, file = finishedPath()): boolean {
	let current = "";
	try {
		current = readFileSync(file, "utf8");
	} catch {}
	const key = finishedKey(entry);
	if (current.split(/^(?=## )/m).some(b => finishedKey(b) === key)) return false;
	mkdirSync(path.dirname(file), { recursive: true });
	const block = entry.endsWith("\n") ? entry : `${entry}\n`;
	if (!current.trim()) {
		writeFileSync(file, `${FINISHED_HEADER}\n${block}`);
		return true;
	}
	const at = current.search(/^## /m);
	const next = at < 0 ? `${current.replace(/\s*$/, "\n\n")}${block}` : `${current.slice(0, at)}${block}\n${current.slice(at)}`;
	writeFileSync(file, next);
	return true;
}
const slug = (name: string) => name.replace(/\.md$/, "").replace(/^\d{8}_\d{4}_/, "");
export function cancelledMatches(plan: Plan): CancelledEntry[] {
	if (plan.status !== "open") return [];
	const mine = new Set(planWords(plan.text));
	const name = path.basename(plan.file);
	return [...readCancelled(plan.repo), ...readGlobalCancelled()].filter(c => {
		const cleared = plan.text.split("\n").some(l => {
			const m = l.match(/^\s*(?:[-*]\s+)?False positive:\s*`?([^\s`]+)`?\s+[—:–-]+\s*(.+)$/);
			return m && m[1] === c.name && (m[2] ?? "").trim().length >= 15;
		});
		if (cleared || c.name === name) return false;
		if (!c.name.startsWith("ban-") && slug(c.name) === slug(name)) return true;
		const shared = c.words.filter(w => mine.has(w)).length;
		const need = Math.min(3, c.words.length);
		return need >= 2 && shared >= need && shared / Math.max(1, Math.min(c.words.length, mine.size)) >= 0.5;
	});
}
export function cancelledProblem(plan: Plan, c: CancelledEntry): string {
	const what = c.name.startsWith("ban-")
		? `work the owner said NEVER to do: ${c.name} (${c.date}, owner: ${c.owner}; list ${c.list})`
		: `a plan the owner CANCELLED: ${c.name} (${c.date}, owner: ${c.owner}; archived under ${path.dirname(plan.file)}/archive/)`;
	return `resembles ${what}. Check it before going on. Same work: drop this plan (remove it from ${INDEX}) and don't do it. Different work: add the line "False positive: ${c.name} — <why it differs>" to this plan.`;
}

export const CANCEL_WORDS =
	/\b(?:cancel(?:led|ed)?|abort|scrap|call (?:it|that|this) off|forget (?:it|about)|no longer (?:do|need|want)|skip (?:it|that|this|the)|(?:don'?t|do not|never|stop|quit|not to|not) (?:do|doing|start|starting|work(?:ing)? on|implement|implementing|build|building|touch|run|running|continue|continuing|bother|pursue|go ahead|proceed)|stop (?:it|that|this|the|working|now)|drop (?:it|that|this|the))\b/i;
export let CANCEL_PENDING = path.join(STATE_DIR, "cancel-pending.json");
export function refreshQueuePaths(): void {
	INDEX = indexPath();
	BLOCKERS_DIR = blockersDirPath();
	STATE_DIR = stateDirPath();
	UNLOCK = unlockPath();
	PROTECTED = protectedPaths();
	SUBAGENTS_MD = subagentsPath();
	GLOBAL_CANCELLED = globalCancelledPath();
	CANCEL_PENDING = path.join(STATE_DIR, "cancel-pending.json");
}
export function cancelPending(): { at: string; words: string } | null {
	try {
		return JSON.parse(readFileSync(CANCEL_PENDING, "utf8"));
	} catch {
		return null;
	}
}

export function closeLog(file: string): string {
	return path.join(STATE_DIR, `close-${path.basename(file, ".md")}-${sha(file).slice(0, 6)}.log`);
}

export function lastCloseResult(file: string): string | null {
	try {
		const lines = readFileSync(closeLog(file), "utf8").split("\n").filter(l => /^queue-close: (REFUSED|CLOSED|AWAITING|already)/.test(l));
		return lines.at(-1) ?? null;
	} catch {
		return null;
	}
}

export function awaitingMerge(p: Plan): boolean {
	return p.status === "complete" && /^queue-close: AWAITING merge/.test(lastCloseResult(p.file) ?? "");
}

/**
 * I-20261025-208: index order is priority, so an open plan must never sit above an open plan of
 * this list it waits on. A "Waits on" target that is not an open plan of the list (complete,
 * cancelled, gone from the index) imposes no order. Pure: queueProblems, queueSummary and the
 * page's /reorder refusal all read it.
 */
export function dependencyOrderProblems(plans: Plan[]): string[] {
	const rank = new Map(plans.map((p, i) => [p.file, i] as const));
	const open = new Map(plans.filter(p => p.status === "open").map(p => [p.file, p] as const));
	const problems: string[] = [];
	plans.forEach((p, i) => {
		if (p.status !== "open") return;
		for (const f of p.waitsOn) {
			const j = rank.get(f);
			const target = open.get(f);
			if (j === undefined || j <= i || !target) continue;
			problems.push(`#${i + 1} ${p.title} waits on #${j + 1} ${target.title}; it cannot sit above it — move #${j + 1} up first or remove the "Waits on" line`);
		}
	});
	return problems;
}

export interface QueueProblem {
	where: string;
	problem: string;
}

export function queueProblems(index = INDEX, blockersDir = BLOCKERS_DIR, reviewSince = ""): QueueProblem[] {
	const probs: QueueProblem[] = [];
	if (!existsSync(index)) probs.push({ where: index, problem: "main index missing: create it (empty = no open work)" });
	const plans = readPlans(readIndex(index), blockersDir, reviewSince);
	const byWorktree = new Map<string, Plan[]>();
	for (const p of plans) {
		for (const e of p.errors) probs.push({ where: p.file, problem: e });
		if ((p.status === "complete" || p.status === "cancelled") && !awaitingMerge(p)) {
			const last = lastCloseResult(p.file);
			probs.push({ where: p.file, problem: `says ${p.status} but is still indexed; auto-close runs at every prompt, every 15 min and after a push${last ? ` (last: ${last.replace(/^queue-close: /, "")})` : ""}` });
		}
		for (const c of cancelledMatches(p)) probs.push({ where: p.file, problem: cancelledProblem(p, c) });
		// A plan file must live in a main checkout, never in a linked worktree.
		const g = gitTop(p.file);
		if (g && g.top !== g.repo)
			probs.push({ where: p.file, problem: `plan file lives in the linked worktree ${g.top}; move it to the main checkout ${g.repo}` });
		// One plan = one worktree: two open plans naming the same worktree is a splitting bug.
		if (p.status === "open" && p.worktree) byWorktree.set(p.worktree, [...(byWorktree.get(p.worktree) ?? []), p]);
	}
	for (const [wt, ps] of byWorktree)
		if (ps.length > 1)
			probs.push({ where: wt, problem: `${ps.length} open plans name this worktree (${ps.map(p => p.file).join(", ")}); one plan = one worktree` });
	// I-20261025-208: one problem per misranked plan, so queue-check exits 1 and the summary lists it.
	for (const m of dependencyOrderProblems(plans)) {
		const i = Number(/^#(\d+) /.exec(m)?.[1] ?? 0);
		probs.push({ where: plans[i - 1]?.file ?? index, problem: m });
	}
	return probs;
}

export function queueSummary(index = INDEX, reviewSince = ""): string {
	// Index order IS priority (20261025_0215_index_priority): the list is flat and ranked,
	// rank 1 = the index's top line; repos only surface through each plan's own path.
	const plans = activePlans(index);
	const rank = new Map(plans.map((p, i) => [p.file, i + 1] as const));
	const repos = [...new Set(plans.map(p => p.repo))];
	const lines = [`Queue (${index}): ${plans.length ? `${plans.length} plan(s) in ${repos.length} repo(s)` : "empty, no open work"}`];
	plans.forEach((p, i) => {
		const status = awaitingMerge(p) ? "complete, awaiting merge" : (p.status ?? "INVALID");
		const hold = p.waiting ? `WAITING on owner: ${(p.waitingLine ?? "").slice(0, 80)}` : "";
		// I-20261025-208: an open plan waiting on an open plan of the queue shows the target's rank.
		const waits: string[] = [];
		if (p.status === "open")
			for (const f of p.waitsOn) {
				const at = rank.get(f);
				if (at === undefined || plans[at - 1]!.status !== "open") continue;
				waits.push(`waits on #${at}`);
			}
		const done = p.phases.total ? `${p.phases.done}/${p.phases.total} done` : "";
		const flags = [status, done, hold, ...waits, p.priorityId ?? ""].filter(Boolean).join(", ");
		const goal = items(sections(p.text).get("goal") ?? "")[0]?.slice(0, 100) ?? "";
		lines.push(`  ${i + 1}. ${p.file} [${flags}] ${goal}`);
	});
	const nCancelled = repos.reduce((n, repo) => n + readCancelled(repo).length, 0);
	if (nCancelled) lines.push(`Cancelled rules: ${nCancelled}`);
	const probs = queueProblems(index, BLOCKERS_DIR, reviewSince);
	if (probs.length) lines.push(`Problems (fix first):`, ...probs.map(q => `  - ${q.where}: ${q.problem}`));
	return lines.join("\n");
}
