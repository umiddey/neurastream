// Write-time lint checks: an edit that adds a lint finding or a suppression comment to a file is
// refused, and the caller puts the file back. Linters run as argv arrays, never through a shell.
// `after` is what is on disk now; `before` is what the file held before the edit (null: new file).

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";

export interface WriteCheckLinter {
	ext: string[];
	argv: string[];
	pattern: string;
}

export interface WriteCheckConfig {
	enabled: boolean;
	applies_to: "sub" | "all";
	timeout_ms: number;
	suppress: string;
	linters: WriteCheckLinter[];
}

export type WriteCheckResult = { allow: true; note?: string } | { allow: false; reason: string };

// Counts per rule key; suppression comments count under SUPPRESSION.
interface Findings {
	counts: Map<string, number>;
	samples: Map<string, string>;
}

const SUPPRESSION = "suppression";
const REASON_MAX = 2000;
const SAMPLE_MAX = 300;
const TAIL = "The file was restored to its state before this edit; fix it and edit again — do not add suppression comments.";

function add(f: Findings, key: string, sample: string): void {
	f.counts.set(key, (f.counts.get(key) ?? 0) + 1);
	if (!f.samples.has(key)) f.samples.set(key, sample.trim().slice(0, SAMPLE_MAX));
}

// Runs each linter on `path` and counts its findings. Throws when a linter did not finish
// (missing binary, timeout, signal); the caller turns that into an allowed edit with a note.
function lint(path: string, linters: WriteCheckLinter[], wc: WriteCheckConfig, f: Findings): void {
	for (const l of linters) {
		const argv = l.argv.map((a) => (a === "{file}" ? path : a));
		const [cmd = "", ...args] = argv;
		const r = spawnSync(cmd, args, {
			cwd: dirname(path),
			encoding: "utf8",
			timeout: wc.timeout_ms,
			maxBuffer: 16 * 1024 * 1024,
		});
		if (r.error || r.signal) throw new Error(`${cmd} did not finish (${r.error?.message ?? r.signal})`);
		const re = new RegExp(l.pattern);
		for (const line of r.stdout.split("\n")) {
			const rule = re.exec(line)?.groups?.rule;
			if (rule) add(f, rule, line);
		}
	}
}

// Lints `text` as if it were `file`: written to a scratch file beside it (same extension, so the
// repo's own lint config applies) and removed afterwards.
function lintText(file: string, text: string, linters: WriteCheckLinter[], wc: WriteCheckConfig, f: Findings): void {
	const ext = extname(file);
	const scratch = join(dirname(file), `.${basename(file, ext)}.wc-${randomBytes(4).toString("hex")}${ext}`);
	writeFileSync(scratch, text);
	try {
		lint(scratch, linters, wc, f);
	} finally {
		rmSync(scratch, { force: true });
	}
}

function suppressions(text: string, re: RegExp, f: Findings): void {
	for (const line of text.split("\n")) if (re.test(line)) add(f, SUPPRESSION, line);
}

function refusal(file: string, now: Findings, old: Findings): string {
	const head = `write-check: this edit adds lint problems to ${file}:`;
	const rows = [...now.counts].flatMap(([key, n]) => {
		const delta = n - (old.counts.get(key) ?? 0);
		return delta > 0 ? [`- ${key} (+${delta}): ${now.samples.get(key)}`] : [];
	});
	const room = REASON_MAX - head.length - TAIL.length - 2;
	let body = rows.join("\n");
	if (body.length > room) body = `${body.slice(0, room - 4)}\n...`;
	return `${head}\n${body}\n${TAIL}`;
}

export function checkWrite(file: string, before: string | null, after: string | null, wc: WriteCheckConfig): WriteCheckResult {
	if (after === null || before === after) return { allow: true };
	const linters = wc.linters.filter((l) => l.ext.includes(extname(file)));
	if (linters.length === 0) return { allow: true };
	const old: Findings = { counts: new Map(), samples: new Map() };
	const now: Findings = { counts: new Map(), samples: new Map() };
	try {
		const re = new RegExp(wc.suppress);
		if (before !== null) {
			suppressions(before, re, old);
			lintText(file, before, linters, wc, old);
		}
		suppressions(after, re, now);
		lint(file, linters, wc, now);
	} catch (err) {
		return { allow: true, note: `write-check: ${file} not checked (${(err as Error).message}); the edit was allowed` };
	}
	const grew = [...now.counts].some(([key, n]) => n > (old.counts.get(key) ?? 0));
	if (!grew) return { allow: true };
	return { allow: false, reason: refusal(file, now, old) };
}
