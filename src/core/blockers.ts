// Plan blockers, ported from the original blocker scripts (shared contract + deny-command,
// deny-path, deny-text, no-push). Executable wrappers live in blockers/<name>; they read one
// JSON call on stdin and exit 2 with one stderr line to refuse (same contract as before).
//
// Contract (called by the guard for every subagent call that touches an open plan's repo,
// worktrees or "## Applies to" paths):
//   argv      the arguments written after the blocker name in the plan's "## Blockers" line
//   stdin     JSON {tool, input, cwd, agent: "main"|"sub", repo, plan, paths: [absolute paths],
//             foreign?: true} — foreign: the caller is staffed on a different plan, so judge
//             only the paths listed (deny-path prunes the rest)
//   exit 0    allow;  exit 2 + one line on stderr = refuse the call with that reason.

import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { expandHome } from "./queue/lib.ts";
import { MAIN_PLAN_FILE } from "./guards.ts";

export interface BlockerCall {
	tool: string;
	input: Record<string, unknown>;
	cwd: string;
	agent: string;
	repo: string;
	plan: string;
	paths: string[];
	/** True when the caller is staffed on a different plan (runBlockers sets it): judge only paths. */
	foreign?: boolean;
}

export interface BlockerEnv {
	call: BlockerCall;
	args: string[];
	shell: boolean;
	writes: boolean;
	command: string;
}

/** A refusal: the wrapper prints `<script name>: <reason>` on stderr and exits 2. */
export class BlockerRefusal extends Error {}

function block(reason: string): never {
	throw new BlockerRefusal(reason);
}

function isDir(p: string): boolean {
	try {
		return statSync(p).isDirectory();
	} catch {
		return false;
	}
}

// Eval code (JS or Python) keeps the whole-text test; shell commands are judged per command.
const CODE_MUTATING =
	/(\brm\b|\bmv\b|\bcp\b|\bln\b|\bdd\b|\bchmod\b|\bchown\b|\btouch\b|\bmkdir\b|\brmdir\b|\binstall\b|\brsync\b|\btruncate\b|\bsed\s+-i|\btee\b|\bcurl\b[^;\n]*(?:\s-[a-zA-Z]*o|--output)|\bwget\b[^;\n]*(?:\s-[a-zA-Z]*O|--output-document)|>{1,2}\s*\S|\bgit\s+(rm|mv|checkout|restore|reset|clean|merge|rebase|cherry-pick)\b|writeFile|Bun\.write|unlink|\bpatch\b)/;

export function blockerEnv(call: BlockerCall, args: string[]): BlockerEnv {
	const shell = call.tool === "bash" || call.tool === "eval";
	const writes = call.tool === "write" || call.tool === "edit" || call.tool === "ast_edit";
	const command = shell ? String(call.input?.command || call.input?.code || "") : "";
	return { call, args, shell, writes, command };
}

export function runBlockerScript(check: (env: BlockerEnv) => void): void {
	const name = path.basename(process.argv[1] ?? "blocker");
	let call: BlockerCall;
	try {
		call = JSON.parse(readFileSync(0, "utf8")) as BlockerCall;
	} catch {
		console.error(`${name}: stdin is not one JSON call`);
		process.exit(2);
	}
	const env = blockerEnv(call, process.argv.slice(2));
	try {
		check(env);
	} catch (err) {
		if (err instanceof BlockerRefusal) {
			console.error(`${name}: ${err.message}`);
			process.exit(2);
		}
		throw err;
	}
}

// Repo/worktree root owning a path: walks up to the nearest .git (worktrees included via their
// .git file mapping back, same as the guard's gitTop but existence-based, as the original).
function gitRoot(p: string): string | null {
	let d = isDir(p) ? p : path.dirname(p);
	for (;;) {
		try {
			statSync(path.join(d, ".git"));
			return d;
		} catch {}
		const up = path.dirname(d);
		if (up === d) return null;
		d = up;
	}
}

// Path relative to the call's repo root; absolute when outside it.
function rel(p: string, call: BlockerCall): string {
	const root = gitRoot(p) ?? (call.repo || "/");
	const r = path.relative(root, p);
	return r.startsWith("..") ? p : r;
}

// Python fnmatch semantics: * and ? cross "/" too; [seq] classes; case-sensitive on POSIX.
function fnmatchToRegExp(glob: string): RegExp {
	let out = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i]!;
		if (c === "*") {
			out += "[\\s\\S]*";
		} else if (c === "?") {
			out += "[\\s\\S]";
		} else if (c === "[") {
			let j = i + 1;
			if (glob[j] === "!" || glob[j] === "^") j++;
			if (glob[j] === "]") j++;
			while (j < glob.length && glob[j] !== "]") j++;
			if (j >= glob.length) {
				out += "\\[";
			} else {
				const raw = glob.slice(i + 1, j);
				out += `[${raw.startsWith("!") ? `^${raw.slice(1)}` : raw}]`;
				i = j;
			}
		} else {
			out += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		}
	}
	return new RegExp(`^${out}$`);
}

// A glob matches a path: absolute globs against the path itself, relative ones against the
// repo-relative form, matching the glob's directory and everything under it.
function matchesPath(p: string, glob: string, call: BlockerCall): boolean {
	if (glob.startsWith("/") || glob.startsWith("~")) return fnmatchToRegExp(expandHome(glob)).test(p);
	const r = rel(p, call);
	const bare = glob.replace(/\/+$/, "");
	return fnmatchToRegExp(glob).test(r) || fnmatchToRegExp(`${bare}/*`).test(r) || r === bare;
}

// ---- Shell: a quote-aware splitter, not a shell parser ---------------------------------------
// Splits on `;`, `&&`, `||`, `|`, `&`, `(`, `)` and newlines outside quotes. Each word keeps its
// quote-removed text and whether any part was quoted; output-redirection targets are kept apart
// from the words; heredoc bodies are kept on their opening segment; the inside of `$(…)` and
// backticks becomes segments.

export interface ShellWord {
	/** Text with quotes and escapes removed; a substitution contributes nothing (its segments are listed). */
	text: string;
	/** Source text, quotes included. */
	raw: string;
	/** Any part of the word was quoted or escaped. */
	quoted: boolean;
}

export interface ShellSegment {
	/** Command words in order; redirections and their targets are not words. */
	words: ShellWord[];
	/** Targets of output redirections: `>`, `>>`, `>|`, `&>`, `&>>`, `<>`, and `>&file`. */
	writes: string[];
	/** Bodies of the heredocs this segment opens; for an interpreter they are its code. */
	bodies: string[];
}

type WordBuf = { text: string; quoted: boolean; start: number };
type RedirKind = "write" | "dup" | "skip" | "heredoc";

/** Segments of a command in source order; a substitution's segments come before their parent's. */
export function splitShell(command: string): ShellSegment[] {
	const out: ShellSegment[] = [];
	scan(command, out);
	return out;
}

function scan(src: string, out: ShellSegment[]): void {
	const n = src.length;
	const st: {
		seg: ShellSegment;
		word: WordBuf | null;
		redir: RedirKind | null;
		tabs: boolean;
		heredocs: { delim: string; tabs: boolean }[];
	} = { seg: { words: [], writes: [], bodies: [] }, word: null, redir: null, tabs: false, heredocs: [] };
	let i = 0;

	const ensure = (): WordBuf => {
		if (!st.word) st.word = { text: "", quoted: false, start: i };
		return st.word;
	};
	const endWord = (end: number): void => {
		const w = st.word;
		if (!w) return;
		st.word = null;
		if (w.text === "" && !w.quoted) return; // an unquoted empty word only comes from a $() substitution
		const word: ShellWord = { text: w.text, raw: src.slice(w.start, end), quoted: w.quoted };
		const kind = st.redir;
		if (!kind) {
			st.seg.words.push(word);
			return;
		}
		st.redir = null;
		if (kind === "write" || (kind === "dup" && !/^(\d+|-)$/.test(word.text))) st.seg.writes.push(word.text);
		else if (kind === "heredoc") st.heredocs.push({ delim: word.text, tabs: st.tabs });
	};
	const endSeg = (end: number): ShellSegment | null => {
		endWord(end);
		st.redir = null;
		const ended = st.seg.words.length || st.seg.writes.length ? st.seg : null;
		if (ended) out.push(ended);
		st.seg = { words: [], writes: [], bodies: [] };
		return ended;
	};
	// Skips the bodies of the heredocs opened on the line before `from`, keeping their text in
	// `into`; returns the index after them.
	const skipHeredocs = (from: number, into: string[]): number => {
		let j = from;
		for (const h of st.heredocs) {
			const start = j;
			while (j < n) {
				const e = src.indexOf("\n", j);
				const line = src.slice(j, e < 0 ? n : e);
				j = e < 0 ? n : e + 1;
				if ((h.tabs ? line.replace(/^\t+/, "") : line) === h.delim) break;
			}
			into.push(src.slice(start, j));
		}
		st.heredocs = [];
		return j;
	};
	// Double-quoted text from `from` (after the opening quote); returns the index after the closing quote.
	const readDouble = (from: number, w: WordBuf): number => {
		let j = from;
		while (j < n && src.charAt(j) !== '"') {
			const d = src.charAt(j);
			const nx = src.charAt(j + 1);
			if (d === "\\" && nx === "\n") j += 2;
			else if (d === "\\" && nx !== "" && '"\\$`'.includes(nx)) {
				w.text += nx;
				j += 2;
			} else if (d === "$" && nx === "(") {
				const end = matchParen(src, j + 2);
				scan(src.slice(j + 2, end), out);
				j = end + 1;
			} else if (d === "`") {
				const end = closeTick(src, j + 1);
				scan(src.slice(j + 1, end), out);
				j = end + 1;
			} else {
				w.text += d;
				j++;
			}
		}
		return j + 1;
	};

	while (i < n) {
		const c = src.charAt(i);
		if (c === " " || c === "\t" || c === "\r") {
			endWord(i);
			i++;
		} else if (c === "\\") {
			if (src.charAt(i + 1) === "\n") i += 2;
			else {
				const w = ensure();
				w.quoted = true;
				w.text += src.charAt(i + 1);
				i += 2;
			}
		} else if (c === "'") {
			const w = ensure();
			w.quoted = true;
			const close = src.indexOf("'", i + 1);
			const end = close < 0 ? n : close;
			w.text += src.slice(i + 1, end);
			i = end + 1;
		} else if (c === '"') {
			const w = ensure();
			w.quoted = true;
			i = readDouble(i + 1, w);
		} else if (c === "$" && src.charAt(i + 1) === "(") {
			ensure();
			const end = matchParen(src, i + 2);
			scan(src.slice(i + 2, end), out);
			i = end + 1;
		} else if (c === "`") {
			ensure();
			const end = closeTick(src, i + 1);
			scan(src.slice(i + 1, end), out);
			i = end + 1;
		} else if (c === "#" && !st.word) {
			while (i < n && src.charAt(i) !== "\n") i++;
		} else if (c === "\n") {
			const ended = endSeg(i);
			i = skipHeredocs(i + 1, ended ? ended.bodies : []);
		} else if (c === ";" || c === "(" || c === ")") {
			endSeg(i);
			i++;
		} else if (c === "|") {
			endSeg(i);
			i += src.charAt(i + 1) === "|" ? 2 : 1;
		} else if (c === "&") {
			if (src.charAt(i + 1) === ">") {
				endWord(i);
				st.redir = "write";
				i += src.charAt(i + 2) === ">" ? 3 : 2;
			} else {
				endSeg(i);
				i += src.charAt(i + 1) === "&" ? 2 : 1;
			}
		} else if (c === ">" || c === "<") {
			const pending = st.word;
			// A bare fd number before a redirection (the 2 in 2>file) is not a word.
			if (pending && !pending.quoted && /^\d+$/.test(pending.text)) st.word = null;
			else endWord(i);
			let j = i + 1;
			const nx = src.charAt(j);
			if (c === ">") {
				if (nx === ">" || nx === "|") {
					st.redir = "write";
					j++;
				} else if (nx === "&") {
					st.redir = "dup";
					j++;
				} else st.redir = "write";
			} else if (nx === "<" && src.charAt(j + 1) === "<") {
				st.redir = "skip";
				j += 2;
			} else if (nx === "<") {
				st.redir = "heredoc";
				j++;
				st.tabs = src.charAt(j) === "-";
				if (st.tabs) j++;
			} else if (nx === ">") {
				st.redir = "write";
				j++;
			} else if (nx === "&") {
				st.redir = "dup";
				j++;
			} else st.redir = "skip";
			i = j;
		} else {
			ensure().text += c;
			i++;
		}
	}
	endSeg(n);
}

// Index of the `)` closing a `$(` whose body starts at `from`; src.length when unclosed.
function matchParen(src: string, from: number): number {
	let depth = 1;
	let j = from;
	while (j < src.length) {
		const c = src.charAt(j);
		if (c === "\\") j += 2;
		else if (c === "'") {
			const close = src.indexOf("'", j + 1);
			j = close < 0 ? src.length : close + 1;
		} else if (c === '"') {
			j++;
			while (j < src.length && src.charAt(j) !== '"') j += src.charAt(j) === "\\" ? 2 : 1;
			j++;
		} else {
			if (c === "(") depth++;
			else if (c === ")" && --depth === 0) return j;
			j++;
		}
	}
	return src.length;
}

// Index of the backtick closing one opened before `from`; src.length when unclosed.
function closeTick(src: string, from: number): number {
	let j = from;
	while (j < src.length && src.charAt(j) !== "`") j += src.charAt(j) === "\\" ? 2 : 1;
	return Math.min(j, src.length);
}

// ---- Shell commands ---------------------------------------------------------------------------
const ASSIGN = /^[A-Za-z_]\w*=/;
// Words that only run another command: skipped to reach the command they run.
const WRAPPERS: Record<string, true> = {
	env: true,
	nohup: true,
	command: true,
	builtin: true,
	exec: true,
	time: true,
	nice: true,
	sudo: true,
	xargs: true,
	timeout: true,
	"!": true,
	"{": true,
	"}": true,
};
const SHELLS: Record<string, true> = { bash: true, sh: true, zsh: true, dash: true };
// Interpreters whose arguments may be code that writes files (bun -e 'writeFileSync(...)').
const INTERPRETERS: Record<string, true> = {
	...SHELLS,
	bun: true,
	node: true,
	deno: true,
	python: true,
	python3: true,
	perl: true,
	ruby: true,
};
const GIT_VALUE_OPTS: Record<string, true> = {
	"-C": true,
	"-c": true,
	"--git-dir": true,
	"--work-tree": true,
	"--namespace": true,
	"--super-prefix": true,
	"--config-env": true,
};
const GH_GLAB_VALUE_OPTS: Record<string, true> = {
	"-R": true,
	"--repo": true,
	"-H": true,
	"--hostname": true,
};
const SUBCMD_TOOLS: Record<string, { valueOpts: Record<string, true>; depth: number }> = {
	git: { valueOpts: GIT_VALUE_OPTS, depth: 1 },
	npm: { valueOpts: { "--prefix": true, "-C": true, "--userconfig": true, "--cache": true, "--registry": true }, depth: 1 },
	bun: { valueOpts: { "--cwd": true, "-c": true, "--config": true, "--env-file": true, "-e": true, "--eval": true, "-p": true, "--print": true }, depth: 1 },
	gh: { valueOpts: GH_GLAB_VALUE_OPTS, depth: 2 },
	glab: { valueOpts: GH_GLAB_VALUE_OPTS, depth: 2 },
	docker: { valueOpts: { "-H": true, "--host": true, "--context": true, "--config": true, "-c": true, "-l": true, "--log-level": true }, depth: 2 },
	kubectl: { valueOpts: { "-n": true, "--namespace": true, "--context": true, "--kubeconfig": true, "--cluster": true, "--user": true }, depth: 1 },
	cargo: { valueOpts: { "--manifest-path": true, "-C": true, "--target-dir": true }, depth: 1 },
	uv: { valueOpts: { "--directory": true, "--project": true, "--cache-dir": true, "--config-file": true }, depth: 1 },
	yarn: { valueOpts: { "--cwd": true }, depth: 1 },
	pnpm: { valueOpts: { "-C": true, "--dir": true, "--filter": true, "-F": true }, depth: 1 },
};
const MUTATING_NAMES: Record<string, true> = {
	rm: true,
	mv: true,
	truncate: true,
	tee: true,
	patch: true,
	chmod: true,
	chown: true,
	touch: true,
	mkdir: true,
	rmdir: true,
	unlink: true,
};
const DEST_LAST_NAMES: Record<string, true> = { cp: true, ln: true, install: true, rsync: true };
const DEST_LAST_VALUE_OPTS: Record<string, Record<string, true>> = {
	cp: { "-S": true, "--suffix": true },
	ln: { "-S": true, "--suffix": true },
	install: { "-m": true, "--mode": true, "-o": true, "--owner": true, "-g": true, "--group": true, "-S": true, "--suffix": true },
	rsync: { "-e": true, "--rsh": true, "--exclude": true, "--include": true, "--filter": true, "-f": true },
};
const GIT_MUTATING: Record<string, true> = {
	rm: true,
	mv: true,
	checkout: true,
	restore: true,
	reset: true,
	clean: true,
	merge: true,
	rebase: true,
	"cherry-pick": true,
};
// Code-write forms, one list for shell and eval: the code parts of queue/lib.ts MUTATING plus
// Ruby's File.write. Never fork a second list.
const CODE_WRITE =
	/writeFile|appendFile|Bun\.write|unlink|rmSync|\.write_text\(|\.write_bytes\(|\bopen\([^)]*,\s*["'][wax]b?\+?["']|shutil\.|os\.(remove|rename|replace|unlink|chmod)|\.writelines\(|File\.write/;

interface ShellCommand {
	name: string;
	args: ShellWord[];
	headIndex: number;
}

/** Resolve the command a segment runs, skipping leading assignments, wrapper words, options, and durations. */
function commandOf(seg: ShellSegment): ShellCommand | null {
	let k = 0;
	for (; k < seg.words.length; k++) {
		const w = seg.words[k];
		if (!w) break;
		const skippable = ASSIGN.test(w.raw) || WRAPPERS[w.text] === true || w.text.startsWith("-") || /^[\d.]+[smhd]?$/.test(w.text);
		if (!skippable) break;
	}
	const head = seg.words[k];
	return head ? { name: path.basename(head.text), args: seg.words.slice(k + 1), headIndex: k } : null;
}

/** Extract non-option subcommand words from CLI args, skipping leading flags and their value arguments. */
function cliSubcommands(args: ShellWord[], valueOpts: Record<string, true>, limit = 2): string[] {
	const out: string[] = [];
	for (let k = 0; k < args.length && out.length < limit; k++) {
		const t = args[k]?.text ?? "";
		if (t === "--") break;
		if (valueOpts[t] === true) {
			k++;
			continue;
		}
		if (t.startsWith("-")) continue;
		out.push(t);
	}
	return out;
}

// git's subcommand and the words after it, skipping global options (-C <dir>, --git-dir=...).
function gitSub(args: ShellWord[]): { sub: string; rest: ShellWord[] } | null {
	for (let k = 0; k < args.length; k++) {
		const t = args[k]?.text ?? "";
		if (GIT_VALUE_OPTS[t] === true) {
			k++;
			continue;
		}
		if (!t.startsWith("-")) return { sub: t, rest: args.slice(k + 1) };
	}
	return null;
}

// A `-c` script as shell source: its quotes removed.
function scriptText(w: ShellWord): string {
	const r = w.raw;
	if (r.length >= 2 && r.startsWith("'") && r.endsWith("'")) return r.slice(1, -1);
	if (r.length >= 2 && r.startsWith('"') && r.endsWith('"')) return r.slice(1, -1).replace(/\\(["\\$`])/g, "$1");
	return w.text;
}

// Scripts a segment runs through `bash|sh|zsh|dash -c <script>`.
function shellScripts(seg: ShellSegment): string[] {
	const cmd = commandOf(seg);
	if (!cmd || SHELLS[cmd.name] !== true) return [];
	for (let k = 0; k < cmd.args.length; k++) {
		const w = cmd.args[k];
		if (!w) break;
		if (w.text === "-o" || w.text === "+o") {
			k++;
			continue;
		}
		if (/^-[a-zA-Z]*c/.test(w.text)) {
			const script = cmd.args[k + 1];
			return script ? [scriptText(script)] : [];
		}
		if (!w.text.startsWith("-") && !w.text.startsWith("+")) break;
	}
	return [];
}

// Every segment that runs, in order: the splitter's segments, each followed by the segments of
// any `bash -c` script it runs.
function executed(command: string): ShellSegment[] {
	const out: ShellSegment[] = [];
	for (const seg of splitShell(command)) {
		out.push(seg);
		for (const script of shellScripts(seg)) out.push(...executed(script));
	}
	return out;
}

/** Extract destination target path(s) for copy/link/sync commands (`cp`, `ln`, `install`, `rsync`). */
function destLastTargets(cmd: ShellCommand): string[] {
	const valueOpts = DEST_LAST_VALUE_OPTS[cmd.name] ?? {};
	let targetDir: string | null = null;
	let installDirMode = false;
	const operands: string[] = [];
	let afterDoubleDash = false;
	for (let k = 0; k < cmd.args.length; k++) {
		const t = cmd.args[k]?.text ?? "";
		if (!t) continue;
		if (!afterDoubleDash && t === "--") {
			afterDoubleDash = true;
			continue;
		}
		if (!afterDoubleDash) {
			if (t === "-t" || t === "--target-directory") {
				const dir = cmd.args[++k]?.text ?? "";
				if (dir) targetDir = dir;
				continue;
			}
			if (t.startsWith("--target-directory=")) {
				const dir = t.slice("--target-directory=".length);
				if (dir) targetDir = dir;
				continue;
			}
			if (/^-t.+$/.test(t)) {
				targetDir = t.slice(2);
				continue;
			}
			if (cmd.name === "install" && (t === "-d" || t === "--directory")) {
				installDirMode = true;
				continue;
			}
			if (valueOpts[t] === true) {
				k++;
				continue;
			}
			if (t.startsWith("-")) continue;
		}
		operands.push(t);
	}
	if (targetDir !== null) {
		const base = targetDir.replace(/\/+$/, "");
		const children = operands.length > 0 ? operands.map((src) => `${base}/${path.basename(src)}`) : [`${base}/_`];
		return [targetDir, ...children];
	}
	if (installDirMode) return operands;
	if (operands.length === 0) return [];
	if (cmd.name === "ln" && operands.length === 1) return [path.basename(operands[0]!)];
	const dest = operands[operands.length - 1]!;
	return dest.endsWith("/") ? [dest, `${dest}_`] : [dest];
}

/** Extract output file targets from `curl` (`-o`, `--output`) or `wget` (`-O`, `--output-document`). */
function downloadTargets(cmd: ShellCommand): string[] {
	const out: string[] = [];
	const shortFlag = cmd.name === "curl" ? "o" : "O";
	const longFlag = cmd.name === "curl" ? "--output" : "--output-document";
	const longPrefix = `${longFlag}=`;
	const combinedEnd = new RegExp(`^-[a-zA-Z]+${shortFlag}$`);
	const shortAttached = new RegExp(`^-${shortFlag}(.+)$`);
	for (let k = 0; k < cmd.args.length; k++) {
		const t = cmd.args[k]?.text ?? "";
		if (!t) continue;
		if (t === `-${shortFlag}` || t === longFlag || combinedEnd.test(t)) {
			const next = cmd.args[++k]?.text ?? "";
			if (next && next !== "-") out.push(next);
		} else if (t.startsWith(longPrefix)) {
			const val = t.slice(longPrefix.length);
			if (val && val !== "-") out.push(val);
		} else {
			const m = shortAttached.exec(t);
			if (m?.[1] && m[1] !== "-") out.push(m[1]);
		}
	}
	return out;
}

/** Extract target directory paths when `tar` runs in extraction mode (`-x` / `--extract` / `xf`) with `-C`/`--directory`. */
function tarExtractTargets(args: ShellWord[]): string[] {
	const first = args[0]?.text ?? "";
	const extracting =
		/^[a-zA-Z]*x[a-zA-Z]*$/.test(first) ||
		args.some((w) => w.text === "-x" || w.text === "--extract" || /^-[a-zA-Z]*x/.test(w.text));
	if (!extracting) return [];
	const out: string[] = [];
	for (let k = 0; k < args.length; k++) {
		const t = args[k]?.text ?? "";
		let dir = "";
		if (t === "-C" || t === "--directory") dir = args[++k]?.text ?? "";
		else if (t.startsWith("--directory=")) dir = t.slice("--directory=".length);
		else if (/^-C.+$/.test(t)) dir = t.slice(2);
		if (dir) {
			out.push(dir, `${dir.replace(/\/+$/, "")}/_`);
		}
	}
	return out;
}

/**
 * Words a segment changes: output redirections, operands of mutating commands, destination targets of
 * copy/link/sync/download/dd/tar-extract commands, and file arguments of interpreter write code.
 */
function mutationTargets(seg: ShellSegment): string[] {
	const out = [...seg.writes];
	const cmd = commandOf(seg);
	if (!cmd) return out;
	let args = cmd.args;
	let mutating = MUTATING_NAMES[cmd.name] === true;
	if (cmd.name === "git") {
		const g = gitSub(cmd.args);
		args = g?.rest ?? [];
		mutating = g !== null && GIT_MUTATING[g.sub] === true;
	}
	const ops = args.filter((w) => w.text !== "" && !w.text.startsWith("-")).map((w) => w.text);
	if (mutating) out.push(...ops);
	else if (DEST_LAST_NAMES[cmd.name] === true) out.push(...destLastTargets(cmd));
	else if (cmd.name === "dd") {
		for (const w of cmd.args) {
			if (w.text.startsWith("of=") && w.text.length > 3) out.push(w.text.slice(3));
		}
	} else if (cmd.name === "curl" || cmd.name === "wget") out.push(...downloadTargets(cmd));
	else if (cmd.name === "tar") out.push(...tarExtractTargets(cmd.args));
	else if (cmd.name === "sed" && cmd.args.some((a) => /^-[a-zA-Z]*i|^--in-place/.test(a.text))) out.push(...ops.slice(1));
	const raw = [...seg.words.map((w) => w.raw), ...seg.bodies].join(" ");
	if (INTERPRETERS[cmd.name] === true && CODE_WRITE.test(raw)) {
		out.push(...raw.split(/[\s;&|<>(),'"]+/).filter((t) => t !== "" && !t.startsWith("-")));
	}
	return out;
}

// Directories a command may run in: the call's cwd and every directory a `cd` reaches. Subshells
// and `&&` chains are not tracked, so each relative target is checked against all of them.
function shellDirs(segs: ShellSegment[], base: string): string[] {
	const dirs = [base];
	let last = base;
	for (const seg of segs) {
		const cmd = commandOf(seg);
		if (cmd?.name !== "cd") continue;
		const dir = cmd.args.find((w) => !w.text.startsWith("-"))?.text ?? "~";
		last = path.resolve(last, expandHome(dir));
		dirs.push(last);
	}
	return dirs;
}

// Absolute targets of a shell command, each resolved against every directory it may run in.
function shellTargets(env: BlockerEnv): string[] {
	const base = expandHome(String(env.call.input?.cwd || env.call.cwd || "/"));
	const segs = executed(env.command);
	const dirs = shellDirs(segs, base);
	const out: string[] = [];
	for (const seg of segs) {
		for (const t of mutationTargets(seg)) {
			if (t === "") continue;
			for (const d of dirs) out.push(path.resolve(d, expandHome(t)));
		}
	}
	return out;
}

// eval code keeps the old whole-text rule: every word of the code counts as a path.
function evalPaths(env: BlockerEnv): string[] {
	const base = expandHome(String(env.call.input?.cwd || env.call.cwd || "/"));
	const out: string[] = [];
	for (const w of env.command.split(/[\s;&|<>()'"`]+/)) {
		const t = w.trim();
		if (t && !t.startsWith("-")) out.push(path.normalize(path.join(base, expandHome(t))));
	}
	return out;
}

/** True when a segment pushes (`git push`) or merges an MR/PR (`glab mr merge`, `gh pr merge`), skipping leading flags. */
function pushesOrMerges(seg: ShellSegment): boolean {
	const cmd = commandOf(seg);
	if (!cmd) return false;
	if (cmd.name === "git") return gitSub(cmd.args)?.sub === "push";
	if (cmd.name === "glab") {
		const subs = cliSubcommands(cmd.args, GH_GLAB_VALUE_OPTS);
		return subs[0] === "mr" && subs[1] === "merge";
	}
	if (cmd.name === "gh") {
		const subs = cliSubcommands(cmd.args, GH_GLAB_VALUE_OPTS);
		return subs[0] === "pr" && subs[1] === "merge";
	}
	return false;
}

const GIT_PROSE_SUBS: Record<string, true> = {
	commit: true,
	tag: true,
	merge: true,
	notes: true,
	stash: true,
	revert: true,
};

/** True when a command/subcommand accepts short prose flags (`-m`, `-am`, `-F`) for message text. */
function hasShortProseFlags(cmdName: string | undefined, firstSub: string | undefined): boolean {
	return cmdName === "git" && firstSub !== undefined && GIT_PROSE_SUBS[firstSub] === true;
}

/** True when a flag takes a prose message/search argument in the immediately following word. */
function isProseNextFlag(token: string, shortProse: boolean): boolean {
	if (token === "--message" || token === "--grep") return true;
	if (!shortProse) return false;
	return token === "-m" || token === "-F" || /^-[a-zA-Z]*m$/.test(token);
}

/** True when a single word combines a prose flag with its attached value (e.g. `--message=--no-verify`, `-m--no-verify`). */
function isProseAttachedFlag(token: string, shortProse: boolean): boolean {
	if (token.startsWith("--message=") || token.startsWith("--grep=")) return true;
	if (!shortProse) return false;
	return /^-[a-zA-Z]*m.+$/.test(token) || /^-F.+$/.test(token);
}

/**
 * Build the match text(s) for `deny-command` from one shell segment.
 * Preserves the resolved command head, subcommands (skipping global value options), non-prose
 * flags (even if quoted), `git add` single-token quoted pathspecs like `"."`, and unquoted words,
 * while excluding prose arguments (`--message`, `--grep`, and git message-subcommand `-m`/`-F`/`-am`)
 * and quoted prose.
 */
function commandMatchText(seg: ShellSegment): string[] {
	const cmd = commandOf(seg);
	const subIndices: number[] = [];
	if (cmd) {
		const spec = SUBCMD_TOOLS[cmd.name];
		if (spec) {
			for (let j = 0; j < cmd.args.length && subIndices.length < spec.depth; j++) {
				const t = cmd.args[j]?.text ?? "";
				if (t === "--") break;
				if (spec.valueOpts[t] === true) {
					j++;
					continue;
				}
				if (t.startsWith("-")) continue;
				if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(t)) break;
				subIndices.push(cmd.headIndex + 1 + j);
			}
		}
	}
	const subIndexSet = new Set(subIndices);
	const firstSub = subIndices.length > 0 ? seg.words[subIndices[0]!]?.text : undefined;
	const isGitAdd = cmd?.name === "git" && firstSub === "add";
	const shortProse = hasShortProseFlags(cmd?.name, firstSub);

	const keptIndices: number[] = [];
	let skipProseNext = false;
	for (let i = 0; i < seg.words.length; i++) {
		const w = seg.words[i]!;
		if (skipProseNext) {
			skipProseNext = false;
			continue;
		}
		if (cmd !== null && i === cmd.headIndex) {
			keptIndices.push(i);
			continue;
		}
		if (subIndexSet.has(i)) {
			keptIndices.push(i);
			continue;
		}
		if (isProseNextFlag(w.text, shortProse)) {
			// Keep the flag token itself and skip only the following prose argument.
			keptIndices.push(i);
			skipProseNext = true;
			continue;
		}
		if (isProseAttachedFlag(w.text, shortProse)) {
			continue;
		}
		if (!w.quoted) {
			keptIndices.push(i);
		} else if (/^--?[A-Za-z0-9]/.test(w.text)) {
			keptIndices.push(i);
		} else if (isGitAdd && w.text !== "" && !/\s/.test(w.text)) {
			keptIndices.push(i);
		}
	}

	const fullText = keptIndices.map((idx) => seg.words[idx]!.text).join(" ");
	if (cmd === null) return [fullText];

	// Also emit a canonical command form with head basename and leading global options before the
	// subcommand stripped, so `gi\t -C repo "tag" v1` matches `/git\s+tag/`.
	const lastSubIdx = subIndices.length > 0 ? subIndices[subIndices.length - 1]! : cmd.headIndex;
	const canonicalParts = [
		cmd.name,
		...subIndices.map((idx) => seg.words[idx]!.text),
		...keptIndices.filter((idx) => idx > lastSubIdx).map((idx) => seg.words[idx]!.text),
	];
	const canonicalText = canonicalParts.join(" ");
	return canonicalText !== fullText ? [fullText, canonicalText] : [fullText];
}

// The text a call would write: write content, the added lines of an edit, the whole input of an
// ast_edit, and the command itself for shell/eval.
function writtenText(env: BlockerEnv): string {
	if (env.call.tool === "write") return String(env.call.input?.content || "");
	if (env.call.tool === "edit") {
		return String(env.call.input?.input || "")
			.split("\n")
			.filter(l => l.startsWith("+"))
			.map(l => l.slice(1))
			.join("\n");
	}
	if (env.call.tool === "ast_edit") return JSON.stringify(env.call.input ?? {});
	return env.command;
}

/** deny-command <regex>...: refuse shell commands matching any regex (use \s for spaces). Matches resolved command heads, subcommands, flags, and unquoted tokens while excluding prose arguments and heredoc bodies; eval code is matched whole. */
export function denyCommand(env: BlockerEnv): void {
	if (!env.args.length) block("deny-command needs at least one regex in the plan");
	if (!env.shell) return;
	const texts = env.call.tool === "eval" ? [env.command] : executed(env.command).flatMap(commandMatchText);
	for (const rx of env.args) {
		const re = new RegExp(rx);
		if (texts.some((t) => re.test(t))) block(`command matches forbidden pattern /${rx}/ (plan Forbidden list)`);
	}
}

/** deny-path <glob>...: refuse changes to matching paths: write/edit/ast_edit targets (live plan files excepted: plan-edit governs them), shell redirections and mutating commands. */
export function denyPath(env: BlockerEnv): void {
	if (!env.args.length) block("deny-path needs at least one glob in the plan");
	let targets: string[] = [];
	if (env.writes) targets = (env.call.paths ?? []).filter((p) => !MAIN_PLAN_FILE.test(p));
	else if (env.call.tool === "eval") {
		if (CODE_MUTATING.test(env.command) || CODE_WRITE.test(env.command))
			targets = [...(env.call.paths ?? []), ...evalPaths(env)];
	} else if (env.shell) targets = shellTargets(env);
	// A foreign plan's globs never reach past the paths that made its blockers run
	// (I-20261028-111): the command may also name paths this plan does not cover.
	if (env.call.foreign) targets = targets.filter((p) => env.call.paths.includes(p));
	for (const p of targets) {
		for (const g of env.args) {
			if (matchesPath(p, g, env.call)) block(`${p} is forbidden by the plan (deny-path ${g})`);
		}
	}
}

/** deny-text <regex>...: refuse writes/edits (and shell commands) whose new text matches any regex. */
export function denyText(env: BlockerEnv): void {
	if (!env.args.length) block("deny-text needs at least one regex in the plan");
	if (env.writes || env.shell) {
		const text = writtenText(env);
		for (const rx of env.args) {
			if (new RegExp(rx).test(text)) block(`new text matches forbidden pattern /${rx}/ (plan Forbidden list)`);
		}
	}
}

// Eval code's words: the same subcommand test as the bash path, so `git stash push` is not a push
// (I-20261027-266), while flag-prefixed `gh -R owner/repo pr merge` and `glab --repo g/p mr merge`
// are caught with the same `cliSubcommands` logic.
const CODE_WORDS = /[A-Za-z0-9_@%+=:.,/~-]+/g;

/** True when eval code invokes `git push`, `glab mr merge`, or `gh pr merge` (even with leading flags). */
function evalPushesOrMerges(code: string): boolean {
	const words = code.match(CODE_WORDS) ?? [];
	return words.some((w, i) => {
		const base = path.basename(w);
		const args = words.slice(i + 1).map((text) => ({ text, raw: text, quoted: false }));
		if (base === "git") return gitSub(args)?.sub === "push";
		if (base === "glab") {
			const subs = cliSubcommands(args, GH_GLAB_VALUE_OPTS);
			return subs[0] === "mr" && subs[1] === "merge";
		}
		if (base === "gh") {
			const subs = cliSubcommands(args, GH_GLAB_VALUE_OPTS);
			return subs[0] === "pr" && subs[1] === "merge";
		}
		return false;
	});
}

/** no-push: subagents never push or merge (Main pushes and merges). Matched as commands, never as words inside arguments. */
export function noPush(env: BlockerEnv): void {
	if (!env.shell || env.call.agent === "main") return;
	const hit = env.call.tool === "eval" ? evalPushesOrMerges(env.command) : executed(env.command).some(pushesOrMerges);
	if (hit) block("subagents never push or merge; commit on the feature branch and report");
}
