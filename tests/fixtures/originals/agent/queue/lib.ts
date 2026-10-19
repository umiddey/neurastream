// Queue model (owner AGENTS.md, 2026-10-15):
//   ~/.omp/agent/INDEX.md   one repo path per line, nothing else. Listed = the repo has unfinished plans.
//   <repo>/INDEX.md         one plan file location per line (absolute or relative to the repo), nothing else.
//                           Listed = that plan is not closed yet. Never in git (<repo>/.git/info/exclude).
//   plan file               committed in the repo (e.g. docs/plans/). Shape: ~/.omp/agent/queue/TEMPLATE.md.
//                           Main writes it; the implementer may change only its "## Progress" section.
//   blocker entry           `<name> [args]` = library script ~/.omp/agent/blockers/<name>, or
//                           `<path> [args]` (contains "/") = plan-specific script, relative to the plan's folder.
//   closing                 only ~/.local/bin/queue-close: done check passes -> worktree + branch gone ->
//                           plan archived -> plan line out of <repo>/INDEX.md -> repo line out of the main index.
//   cancelling              Main writes "Status: cancelled" + "Cancelled by owner: <date> \"<owner words>\"";
//                           queue-close archives it and appends one line to <repo>/docs/plans/CANCELLED.md.
//                           A new open plan resembling a cancelled one is refused once (queue problem + spawn
//                           gate) until Main checked it and wrote "False positive: <cancelled name> — <why>".
// Shared by extensions/plan-guard.ts, extensions/main-guard.ts, ~/.local/bin/queue-check and queue-close.

import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();
export const INDEX = process.env.QUEUE_INDEX ?? `${HOME}/.omp/agent/INDEX.md`;
export const BLOCKERS_DIR = process.env.QUEUE_BLOCKERS ?? `${HOME}/.omp/agent/blockers`;
export const STATE_DIR = process.env.QUEUE_STATE ?? `${HOME}/.local/state/queue`;
export const REPO_INDEX = "INDEX.md";
export const BACKGROUND_MAX_LINES = 40;
export const SUB_WARN_CALLS = 90;
export const SUB_MAX_CALLS = 100;
const REQUIRED = ["goal", "forbidden", "blockers", "phases", "done check", "progress"] as const;

export interface Blocker {
	script: string; // absolute path
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
	priorityId: string | null;
	errors: string[];
}

export function expandHome(p: string): string {
	return p === "~" ? HOME : p.startsWith("~/") ? `${HOME}/${p.slice(2)}` : p;
}

export function sha(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

// Non-blank lines of an index file; markdown list markers and backticks are tolerated.
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

export function readIndex(file = INDEX): string[] {
	return [...new Set((indexLines(file) ?? []).map(l => path.resolve(expandHome(l))))];
}

export function readRepoIndex(repo: string): string[] {
	return [...new Set((indexLines(path.join(repo, REPO_INDEX)) ?? []).map(l => path.resolve(repo, expandHome(l))))];
}

// "## Name" sections (level 2 only), keyed by lowercased name; value = body text.
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

// Everything except the "## Progress" section body: what only Main may change.
export function outsideProgress(text: string): string {
	return text.replace(/^## Progress[^\n]*\n[\s\S]*?(?=^## |(?![\s\S]))/m, "## Progress\n");
}

export function progressBody(text: string): string {
	return sections(text).get("progress") ?? "";
}

export function statusOf(text: string): Plan["status"] {
	const m = progressBody(text).match(/^Status:\s*(\S+)\s*$/m);
	return m ? ((["open", "complete", "cancelled"].includes(m[1]) ? m[1] : null) as Plan["status"]) : null;
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
	const m = text.split(/^## /m)[0].match(new RegExp(`^${name}:\\s*(.+?)\\s*$`, "m"));
	return m ? m[1].replace(/`/g, "").trim() || null : null;
}

export function parsePlan(repo: string, file: string, text: string | null, blockersDir = BLOCKERS_DIR): Plan {
	const empty = { repo, file, text: "", status: null, blockers: [], doneCheck: null, worktree: null, branch: null, appliesTo: [], waiting: false, priorityId: null };
	if (text === null) return { ...empty, errors: ["plan file listed in INDEX.md does not exist"] };
	const errors: string[] = [];
	const secs = sections(text);
	for (const s of REQUIRED) {
		if (s === "progress" ? !secs.has(s) : !items(secs.get(s) ?? "").length)
			errors.push(`missing or empty "## ${s.replace(/^\w/, c => c.toUpperCase())}" section (template: ~/.omp/agent/queue/TEMPLATE.md)`);
	}
	const known = new Set([...REQUIRED, "applies to", "background"]);
	for (const s of secs.keys()) if (!known.has(s)) errors.push(`unknown section "## ${s}" (allowed: ${[...known].join(", ")})`);
	const status = statusOf(text);
	if (!status) errors.push('"## Progress" must start with a line "Status: open", "Status: complete" or "Status: cancelled"');
	if (status === "cancelled" && !/^Cancelled by owner:\s*\S.{5,}/m.test(progressBody(text)))
		errors.push('a cancelled plan needs a Progress line: Cancelled by owner: <date> "<the owner\'s words>"');
	const blockers: Blocker[] = [];
	for (const line of items(secs.get("blockers") ?? "")) {
		const [ref, ...args] = line.replace(/`/g, "").split(/\s+/);
		const script = ref.includes("/") ? path.resolve(path.dirname(file), expandHome(ref)) : path.join(blockersDir, ref);
		if (!executable(script)) errors.push(`blocker "${ref}": ${script} missing or not executable`);
		blockers.push({ script, args });
	}
	const phases = items(secs.get("phases") ?? "").filter(l => /^\[[ xX]\]/.test(l));
	if (secs.has("phases") && !phases.length) errors.push('"## Phases" needs checkbox lines: "- [ ] P1 <what> — verify: `<command>`"');
	for (const p of phases) if (!/verify:\s*`[^`]+`/.test(p)) errors.push(`phase without "verify: \`<command>\`": ${p.slice(0, 60)}`);
	const dc = (secs.get("done check") ?? "").match(/```[a-z]*\n([\s\S]*?)```|`([^`\n]+)`/);
	const doneCheck = dc ? (dc[1] ?? dc[2]).trim() : null;
	if (secs.has("done check") && !doneCheck) errors.push('"## Done check" needs one command in backticks (exit 0 = done)');
	const bg = (secs.get("background") ?? "").split("\n").filter(l => l.trim()).length;
	if (bg > BACKGROUND_MAX_LINES) errors.push(`"## Background" has ${bg} lines (max ${BACKGROUND_MAX_LINES}); link a separate file for long context`);
	const wt = headerField(text, "Worktree");
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
		priorityId: text.match(/^PRIORITY-ID:\s*`?([A-Z]{2}[0-9]{2})`?/m)?.[1] ?? null,
		errors,
	};
}

export function readPlans(repo: string, blockersDir = BLOCKERS_DIR): Plan[] {
	return readRepoIndex(repo).map(file => {
		let text: string | null = null;
		try {
			text = readFileSync(file, "utf8");
		} catch {}
		return parsePlan(repo, file, text, blockersDir);
	});
}

export function activePlans(index = INDEX, blockersDir = BLOCKERS_DIR): Plan[] {
	return readIndex(index).flatMap(r => readPlans(r, blockersDir));
}

// Repo root owning a path: walks up to the nearest .git; a linked worktree (.git file with
// "gitdir: <repo>/.git/worktrees/<name>") maps back to <repo>, so a plan also guards its worktrees.
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
			const gd = m ? path.resolve(dir, m[1].trim()) : "";
			const w = gd.match(/^(.*)\/\.git\/worktrees\/[^/]+$/);
			return { top: dir, repo: w ? w[1] : dir };
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

export function planCovers(plan: Plan, p: string): boolean {
	if (under(p, plan.repo) || plan.appliesTo.some(a => under(p, a)) || (plan.worktree && under(p, plan.worktree))) return true;
	return repoRoot(p) === plan.repo;
}

// The open plan a path IS: the listed file itself, or the same repo-relative file in one of the
// repo's worktrees (a committed plan exists in every checkout).
export function planAt(p: string, plans: Plan[]): Plan | null {
	const exact = plans.find(pl => pl.file === p);
	if (exact) return exact;
	const g = gitTop(p);
	if (!g) return null;
	const rel = path.relative(g.top, p);
	return plans.find(pl => pl.repo === g.repo && path.relative(pl.repo, pl.file) === rel) ?? null;
}

// Orchestration files Main owns: a repo-root INDEX.md, every open plan file (in any checkout of its
// repo) and every blocker script a plan names. Main's writes to them never count toward its edit
// limit; subagents may change only the "## Progress" section of a plan (enforced by plan-guard).
export function isOrchestrationPath(p: string, plans: Plan[] = activePlans()): boolean {
	if (path.basename(p) === REPO_INDEX && existsSync(path.join(path.dirname(p), ".git"))) return true;
	if (planAt(p, plans)) return true;
	return plans.some(pl => pl.blockers.some(b => b.script === p));
}

// Absolute paths a tool call touches: explicit path fields, edit headers, path-like tokens anywhere
// in the input, and for shell-like tools their working directory and every word that looks like a
// path, resolved against cwd.
const SHELL_TOOLS = new Set(["bash", "eval"]);
export function touchedPaths(toolName: string, input: Record<string, unknown>, cwd: string): string[] {
	const out = new Set<string>();
	const base = typeof input?.cwd === "string" ? path.resolve(cwd, expandHome(input.cwd)) : cwd;
	const add = (raw: string, from = base) => {
		const s = expandHome(raw.trim());
		if (!s || s.includes("://")) return;
		out.add(path.resolve(from, s));
	};
	for (const key of ["path", "file"]) {
		const v = input?.[key];
		if (typeof v === "string") for (const part of v.split(";")) add(part.replace(/:[\d+\-,]*(:raw)?$|:raw(:[\d+\-,]+)?$/, ""));
	}
	const text = JSON.stringify(input ?? {});
	for (const m of text.matchAll(/\[([^\]\s#]+)#[0-9A-Fa-f]{4}\]/g)) add(m[1]);
	for (const m of text.matchAll(/(?:^|[\s"'=:([])((?:~|\/)[^\s"'`;|&)\]\\]+)/g)) {
		const tok = m[1].replace(/#[0-9A-Fa-f]{4}$/, "");
		if (tok.startsWith("~") || tok.split("/").length > 2) add(tok);
	}
	if (SHELL_TOOLS.has(toolName)) {
		out.add(base);
		const cmd = String(input?.command ?? input?.code ?? "");
		let dir = base;
		for (const word of cmd.split(/[\s;&|<>()'"`,=]+/)) {
			const w = word.trim();
			if (!w || w.startsWith("-") || w.includes("://") || !/[./]/.test(w) || /^\d+(\.\d+)*$/.test(w)) continue;
			add(w, dir);
		}
		for (const m of cmd.matchAll(/(?:^|&&|;|\|\|)\s*cd\s+(\S+)/g)) dir = path.resolve(dir, expandHome(m[1]));
	}
	return [...out];
}

// Shell/eval text that changes files ("=>" / "->" arrows and "2>&1" are not redirects).
export const MUTATING =
	/(\brm\b|\bmv\b|\bcp\b|\btouch\b|\btruncate\b|\bchmod\b|\bln\b|\bsed\s+(-\w*\s+)*-i|\bperl\s+(-\w*\s+)*-[a-z]*i|\btee\b|(^|[^0-9&>=\-])>{1,2}\s*[^\s&>]|\bgit\s+(rm|mv|checkout|restore|apply|am|stash|reset|clean)\b|\bpatch\b|\binstall\b|\bdd\b|writeFile|appendFile|Bun\.write|unlink|rmSync|\.write_text\(|\.write_bytes\(|\bopen\([^)]*,\s*["'][wax]b?\+?["']|shutil\.|os\.(remove|rename|replace|unlink|chmod)|\.writelines\()/;

export function changesFiles(toolName: string, input: Record<string, unknown>): boolean {
	if (toolName === "edit" || toolName === "ast_edit") return true;
	if (toolName === "write") return true;
	return SHELL_TOOLS.has(toolName) && MUTATING.test(String(input?.command ?? input?.code ?? ""));
}

// Absolute paths a call WRITES (not the ones it only mentions or reads):
//   write -> its target; edit -> the [PATH#TAG] headers only (the body may name any path);
//   ast_edit (tool or xd://ast_edit device) -> its path field;
//   bash/eval -> redirect targets, tee/rm/mv/cp/touch/truncate/chmod/ln/sed -i/perl -i file arguments,
//   string literals passed to open(...,"w"), write_text/write_bytes, writeFile*/appendFile*/Bun.write,
//   os.remove/rename/unlink, shutil.*, and the repo for file-changing git subcommands.
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
		for (const m of String(input?.input ?? "").matchAll(/^\[([^\]\n]+?)#[0-9A-Fa-f]{4}\]/gm)) add(m[1], cwd);
		return [...out];
	}
	if (toolName === "ast_edit") {
		if (typeof input?.path === "string") add(input.path, cwd);
		return [...out];
	}
	if (!SHELL_TOOLS.has(toolName)) return [];
	const code = String(input?.command ?? input?.code ?? "");
	if (!MUTATING.test(code)) return [];
	let dir = typeof input?.cwd === "string" ? path.resolve(cwd, expandHome(input.cwd)) : cwd;
	// Shell segments, tracking `cd` so relative targets resolve where the command really runs.
	for (const seg of code.split(/&&|\|\||;|\n|\|/)) {
		const s = seg.trim();
		const cd = s.match(/^cd\s+(\S+)/);
		if (cd) {
			dir = path.resolve(dir, expandHome(cd[1].replace(/^["']|["']$/g, "")));
			continue;
		}
		for (const m of s.matchAll(/(?:^|[^0-9&>=\-])>{1,2}\s*([^\s&|;)<>]+)/g)) add(m[1], dir);
		const words = s.split(/\s+/).filter(Boolean);
		const cmd = words[0]?.replace(/^.*\//, "") ?? "";
		const args = words.slice(1).filter(w => !w.startsWith("-"));
		if (["rm", "mv", "touch", "truncate", "chmod", "ln", "tee", "unlink", "rmdir", "mkdir"].includes(cmd))
			for (const a of cmd === "chmod" ? args.slice(1) : args) add(a, dir);
		if (["cp", "install"].includes(cmd) && args.length) add(args[args.length - 1], dir);
		if ((cmd === "sed" && /\s-[a-zA-Z]*i/.test(s)) || (cmd === "perl" && /\s-[a-z]*i/.test(s)))
			for (const a of args.slice(1)) add(a, dir);
		const g = s.match(/^git\s+(?:-C\s+(\S+)\s+)?(rm|mv|checkout|restore|apply|am|stash|reset|clean)\b/);
		if (g && !(g[2] === "checkout" && /\s-b\s/.test(s)) && !(g[2] === "reset" && !/--hard/.test(s)))
			add(g[1] ?? ".", dir);
	}
	// Writes from inline code (python/js), via string literals only.
	for (const re of [
		/\bopen\(\s*(["'][^"']+["'])\s*,\s*["'][wax]b?\+?["']/g,
		/\bPath\(\s*(["'][^"']+["'])\s*\)\.(?:write_text|write_bytes|unlink|rename|touch|mkdir)\(/g,
		/\b(?:writeFileSync|writeFile|appendFileSync|appendFile|Bun\.write|rmSync|unlinkSync)\(\s*(["'`][^"'`]+["'`])/g,
		/\bos\.(?:remove|unlink|rename|replace)\(\s*(["'][^"']+["'])/g,
		/\bshutil\.\w+\(\s*["'][^"']+["']\s*,\s*(["'][^"']+["'])/g,
	])
		for (const m of code.matchAll(re)) add(m[1].replace(/`/g, ""), dir);
	return [...out];
}

// Files nobody may change from inside an agent session (owner unlocks by touching UNLOCK from a
// terminal; valid UNLOCK_MINUTES). Covers the guards, their data and the agent model pins.
export const UNLOCK = `${HOME}/.omp/agent/.guard-unlock`;
export const UNLOCK_MINUTES = 30;
export const PROTECTED = [
	`${HOME}/.omp/agent/extensions/`,
	`${HOME}/.omp/agent/queue/`,
	`${HOME}/.omp/agent/blockers/`,
	`${HOME}/.omp/agent/agents/`,
	`${HOME}/.omp/agent/AGENTS.md`,
	`${HOME}/.omp/agent/CANCELLED.md`,
	`${HOME}/.local/state/queue/`,
	`${HOME}/.omp/agent/config.yml`,
	`${HOME}/.omp/agent/notes/subagents.md`,
	`${HOME}/.omp/agent/.guard-unlock`,
	`${HOME}/.omp/git-no-verify-guard.mjs`,
	`${HOME}/.local/bin/queue-check`,
	`${HOME}/.local/bin/queue-close`,
	`${HOME}/.local/bin/queue-cancel`,
	`${HOME}/.local/bin/agent-ledger`,
	`${HOME}/.local/bin/brief-lint`,
	`${HOME}/.local/bin/main-start`,
	`${HOME}/.local/bin/git`,
	`${HOME}/.local/bin/git-secret-gate`,
	`${HOME}/.config/git-secret-gate/`,
];

export function unlocked(): boolean {
	try {
		return Date.now() - statSync(UNLOCK).mtimeMs < UNLOCK_MINUTES * 60_000;
	} catch {
		return false;
	}
}

export function protectedHit(paths: string[]): string | null {
	for (const p of paths) for (const g of PROTECTED) if (g.endsWith("/") ? p.startsWith(g) || `${p}/` === g : p === g) return p;
	return null;
}

// Allowed subagent definitions: "- `name`" lines under "## Allowed" in ~/.omp/agent/notes/subagents.md.
export const SUBAGENTS_MD = process.env.QUEUE_SUBAGENTS ?? `${HOME}/.omp/agent/notes/subagents.md`;
export function allowedAgents(file = SUBAGENTS_MD): Set<string> {
	let text = "";
	try {
		text = readFileSync(file, "utf8");
	} catch {}
	const body = sections(text).get("allowed") ?? "";
	return new Set([...body.matchAll(/^\s*[-*]\s+`([a-z0-9-]+)`/gm)].map(m => m[1]));
}

// Cancelled work (owner 2026-10-16: a plan the owner called off came back hours later and ran to the
// end; and "don't do X" said before any plan existed must hold too). One line per entry:
//   - <plan file name | ban-<slug>> | <date> | owner: "<words>" | words: <key words>
// in <repo>/docs/plans/CANCELLED.md (that repo's plans) or ~/.omp/agent/CANCELLED.md (every repo).
// Plan entries come from queue-close (Status: cancelled); ban entries (no plan ever written) from
// `queue-cancel --never`. Only scripts read the lists; Main sees a line only when an open plan matches.
// A match is a one-time refusal: Main checks it, then drops the new plan (real match) or writes
// `False positive: <entry name> — <why it differs>` into the new plan.
export const CANCELLED_REL = "docs/plans/CANCELLED.md";
export const GLOBAL_CANCELLED = process.env.QUEUE_CANCELLED ?? `${HOME}/.omp/agent/CANCELLED.md`;
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
		if (m) out.push({ name: m[1], date: m[2], owner: m[3], words: m[4].split(/\s+/).filter(Boolean), list: file });
	}
	return out;
}
export function readCancelled(repo: string): CancelledEntry[] {
	return readList(cancelledFile(repo));
}
export function readGlobalCancelled(): CancelledEntry[] {
	return readList(GLOBAL_CANCELLED);
}
// A ban: work the owner refused before (or without) any plan.
export function banLine(what: string, owner: string, date: string): string {
	const words = keyWords(what);
	const name = `ban-${words.slice(0, 4).join("-") || "x"}-${sha(`${what}${date}`).slice(0, 4)}`;
	return `- ${name} | ${date} | owner: ${owner.replace(/[|\n]/g, "/")} — never: ${what.replace(/[|\n]/g, "/")} | words: ${words.join(" ")}`;
}
export function cancelledLine(file: string, text: string, date: string): string {
	const owner = (progressBody(text).match(/^Cancelled by owner:\s*(.+?)\s*$/m)?.[1] ?? "").replace(/\|/g, "/");
	return `- ${path.basename(file)} | ${date} | owner: ${owner} | words: ${planWords(text).join(" ")}`;
}
const slug = (name: string) => name.replace(/\.md$/, "").replace(/^\d{8}_\d{4}_/, "");
// Cancelled entries the plan resembles and has not been cleared of (same name without its date stamp,
// or at least 3 shared key words, fewer only for a shorter entry, covering half of the smaller word set).
export function cancelledMatches(plan: Plan): CancelledEntry[] {
	if (plan.status !== "open") return [];
	const mine = new Set(planWords(plan.text));
	const name = path.basename(plan.file);
	return [...readCancelled(plan.repo), ...readGlobalCancelled()].filter(c => {
		const cleared = plan.text.split("\n").some(l => {
			const m = l.match(/^\s*(?:[-*]\s+)?False positive:\s*`?(\S+?)`?\s*[—:–-]+\s*(.+)$/);
			return m && m[1] === c.name && m[2].trim().length >= 15;
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
	return `resembles ${what}. Check it before going on. Same work: drop this plan (remove it from ${REPO_INDEX}) and don't do it. Different work: add the line "False positive: ${c.name} — <why it differs>" to this plan.`;
}

// Owner message that may call work off (main-guard): until Main records it with queue-cancel (or says
// it was no cancel), no spawn and no stop. Pending state lives in STATE_DIR/cancel-pending.json.
export const CANCEL_WORDS =
	/\b(?:cancel(?:led|ed)?|abort|scrap|call (?:it|that|this) off|forget (?:it|about)|no longer (?:do|need|want)|skip (?:it|that|this|the)|(?:don'?t|do not|never|stop|quit|not to|not) (?:do|doing|start|starting|work(?:ing)? on|implement|implementing|build|building|touch|run|running|continue|continuing|bother|pursue|go ahead|proceed)|stop (?:it|that|this|the|working|now)|drop (?:it|that|this|the))\b/i;
export const CANCEL_PENDING = path.join(STATE_DIR, "cancel-pending.json");
export function cancelPending(): { at: string; words: string } | null {
	try {
		return JSON.parse(readFileSync(CANCEL_PENDING, "utf8"));
	} catch {
		return null;
	}
}

// Log of the automatic queue-close attempts for a plan (written by main-guard's background runs).
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

// Owner 2026-10-17: "Status: complete" says the work is done (Main, after review); the index says it
// is not on main yet. A complete plan whose last queue-close found the done check green and only
// the merge missing is a normal state, not a queue problem.
export function awaitingMerge(p: Plan): boolean {
	return p.status === "complete" && /^queue-close: AWAITING merge/.test(lastCloseResult(p.file) ?? "");
}

export interface QueueProblem {
	where: string;
	problem: string;
}

// Deterministic health of the whole queue.
export function queueProblems(index = INDEX, blockersDir = BLOCKERS_DIR): QueueProblem[] {
	const probs: QueueProblem[] = [];
	if (!existsSync(index)) probs.push({ where: index, problem: "main index missing: create it (empty = no open work)" });
	for (const repo of readIndex(index)) {
		if (!existsSync(repo)) {
			probs.push({ where: repo, problem: "indexed repo does not exist: remove the line" });
			continue;
		}
		const plans = readPlans(repo, blockersDir);
		if (!plans.length) probs.push({ where: repo, problem: `indexed but ${REPO_INDEX} lists no plan: remove the repo from ${index}` });
		for (const p of plans) {
			for (const e of p.errors) probs.push({ where: p.file, problem: e });
			if ((p.status === "complete" || p.status === "cancelled") && !awaitingMerge(p)) {
				const last = lastCloseResult(p.file);
				probs.push({ where: p.file, problem: `says ${p.status} but is still indexed; auto-close runs at every prompt, every 15 min and after a push${last ? ` (last: ${last.replace(/^queue-close: /, "")})` : ""}` });
			}
			for (const c of cancelledMatches(p)) probs.push({ where: p.file, problem: cancelledProblem(p, c) });
		}
	}
	return probs;
}

// Human-readable queue summary (injected into Main's context and printed by queue-check).
export function queueSummary(index = INDEX): string {
	const repos = readIndex(index);
	const lines = [`Queue (${index}): ${repos.length ? `${repos.length} repo(s)` : "empty, no open work"}`];
	for (const repo of repos) {
		const nCancelled = readCancelled(repo).length;
		lines.push(`- ${repo}${nCancelled ? ` (${nCancelled} cancelled)` : ""}`);
		for (const p of readPlans(repo)) {
			const status = awaitingMerge(p) ? "complete, awaiting merge" : (p.status ?? "INVALID");
			const flags = [status, p.waiting ? "WAITING on owner" : "", p.priorityId ?? ""].filter(Boolean).join(", ");
			const goal = items(sections(p.text).get("goal") ?? "")[0]?.slice(0, 100) ?? "";
			lines.push(`  - ${p.file} [${flags}] ${goal}`);
		}
	}
	const probs = queueProblems(index);
	if (probs.length) lines.push(`Problems (fix first):`, ...probs.map(q => `  - ${q.where}: ${q.problem}`));
	return lines.join("\n");
}
